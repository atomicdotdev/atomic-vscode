import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertNoSymlinkComponents,
  AtomicClient,
  AtomicCommandError,
  cloneRepository,
  CommandRunner,
  inferCloneFolderName,
  initializeRepository,
  isAtomicMetadataPath,
  redactSensitiveUrls,
  shouldRefreshForPath,
  validateCloneFolderName,
  validateRemoteName,
} from "../src/client";

test("Atomic metadata changes do not trigger recursive status refreshes", () => {
  assert.equal(isAtomicMetadataPath(".atomic"), true);
  assert.equal(isAtomicMetadataPath(".atomic/pristine.redb"), true);
  assert.equal(isAtomicMetadataPath(".atomicignore"), false);
  assert.equal(isAtomicMetadataPath("src/.atomic/file"), false);
  assert.equal(shouldRefreshForPath(".atomic/pristine.redb"), false);
  assert.equal(shouldRefreshForPath(".atomic/changes/AB/change"), true);
  assert.equal(shouldRefreshForPath(".atomic/current_view"), true);
  assert.equal(shouldRefreshForPath("src/main.ts"), true);
});

test("restore guard rejects symlinks in the file path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atomic-vscode-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "atomic-vscode-outside-"));
  try {
    await writeFile(path.join(outside, "file.txt"), "outside");
    await symlink(outside, path.join(root, "linked"));
    await assert.rejects(
      assertNoSymlinkComponents(root, "linked/file.txt"),
      /Refusing to restore through symbolic link/,
    );

    await mkdir(path.join(root, "safe"));
    await writeFile(path.join(root, "safe", "file.txt"), "safe");
    await assert.doesNotReject(assertNoSymlinkComponents(root, "safe/file.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("AtomicClient invokes versioned JSON status without a shell", async () => {
  const calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
  const runner: CommandRunner = async (executable, args, cwd) => {
    calls.push({ executable, args, cwd });
    return Buffer.from(
      JSON.stringify({
        schema_version: 1,
        repository_root: "/repo",
        view: "dev",
        state: null,
        clean: true,
        needs_reindex: false,
        stale_index_count: 0,
        entries: [],
      }),
    );
  };
  const client = new AtomicClient("/repo", "/bin/atomic", runner);

  const status = await client.status();

  assert.equal(status.view, "dev");
  assert.deepEqual(calls, [
    {
      executable: "/bin/atomic",
      args: ["--no-color", "status", "--json"],
      cwd: "/repo",
    },
  ]);
});

test("AtomicClient turns an old CLI JSON flag error into an upgrade hint", async () => {
  const client = new AtomicClient("/repo", "atomic", async () => {
    throw new AtomicCommandError(
      ["status", "--json"],
      2,
      "error: unknown-arg\ncmd: atomic status\ngot: --json\nhint: Run 'atomic status --help'",
    );
  });

  await assert.rejects(client.status(), /Run 'atomic update'/);
});

test("AtomicClient passes file paths as arguments after an option terminator", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_executable, args) => {
    calls.push([...args]);
    return Buffer.alloc(0);
  };
  const client = new AtomicClient("/repo", "atomic", runner);

  await client.add(["--not-an-option", "folder/file with spaces.ts"]);
  await client.restore("--not-an-option");

  assert.deepEqual(calls, [
    ["--no-color", "add", "--", "--not-an-option", "folder/file with spaces.ts"],
    ["--no-color", "restore", "--", "--not-an-option"],
  ]);
});

test("AtomicClient protects record messages and view names that start with a dash", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_executable, args) => {
    calls.push([...args]);
    return Buffer.alloc(0);
  };
  const client = new AtomicClient("/repo", "atomic", runner);

  await client.record("-message");
  await client.switchView("-view");

  assert.deepEqual(calls, [
    ["--no-color", "record", "--message=-message"],
    ["--no-color", "view", "switch", "--", "-view"],
  ]);
});

test("repository setup commands pass URLs and paths without shell interpolation", async () => {
  const calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
  const runner: CommandRunner = async (executable, args, cwd) => {
    calls.push({ executable, args, cwd });
    return Buffer.alloc(0);
  };

  await initializeRepository("/bin/atomic", "/work/new repo", runner);
  await cloneRepository(
    "/bin/atomic",
    "https://example.com/workspaces/acme/projects/demo/code?token=a&b=c",
    "/work/cloned repo",
    runner,
  );

  assert.deepEqual(calls, [
    {
      executable: "/bin/atomic",
      args: ["--no-color", "init", "--", "/work/new repo"],
      cwd: "/work",
    },
    {
      executable: "/bin/atomic",
      args: [
        "--no-color",
        "clone",
        "--",
        "https://example.com/workspaces/acme/projects/demo/code?token=a&b=c",
        "/work/cloned repo",
      ],
      cwd: "/work",
    },
  ]);
});

test("clone destination helpers handle Atomic URLs and unsafe folder names", () => {
  assert.equal(
    inferCloneFolderName("https://example.com/workspaces/acme/projects/demo/code"),
    "demo",
  );
  assert.equal(inferCloneFolderName("https://example.com/acme/project.git/"), "project");
  assert.equal(inferCloneFolderName("project"), "project");

  assert.equal(validateCloneFolderName("project"), undefined);
  assert.match(validateCloneFolderName("../outside") ?? "", /single valid folder/);
  assert.match(validateCloneFolderName("folder/name") ?? "", /single valid folder/);
  assert.match(validateCloneFolderName("CON.txt") ?? "", /single valid folder/);
  assert.match(validateCloneFolderName("project.") ?? "", /single valid folder/);
  assert.match(validateCloneFolderName("project\u0007") ?? "", /single valid folder/);
  assert.match(validateCloneFolderName("   ") ?? "", /folder name/);
});

test("remote names use the same validation rules as the Atomic CLI", () => {
  assert.equal(validateRemoteName("origin"), undefined);
  assert.equal(validateRemoteName("team-upstream_2"), undefined);
  assert.match(validateRemoteName("-origin") ?? "", /do not start/);
  assert.match(validateRemoteName("origin/team") ?? "", /letters, numbers/);
  assert.match(validateRemoteName("..") ?? "", /letters, numbers/);
  assert.match(validateRemoteName("   ") ?? "", /remote name/);
});

test("Atomic command errors redact credentials embedded in remote URLs", () => {
  const url = "https://alice:secret@example.com/project/code?token=top-secret#private";
  const error = new AtomicCommandError(
    ["clone", url],
    4,
    `Failed to clone ${url}`,
  );

  assert.equal(
    redactSensitiveUrls(url),
    "https://[redacted]@example.com/project/code?[redacted]#[redacted]",
  );
  assert.doesNotMatch(error.message, /alice|secret|private/);
  assert.doesNotMatch(error.args.join(" "), /alice|secret|private/);
  assert.match(error.message, /\[redacted\]/);
});

test("AtomicClient invokes pull and push through the repository command queue", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_executable, args) => {
    calls.push([...args]);
    return Buffer.alloc(0);
  };
  const client = new AtomicClient("/repo", "atomic", runner);

  await client.pull();
  await client.push();
  await client.addDefaultRemote("-origin", "https://example.com/project?token=a&b=c");

  assert.deepEqual(calls, [
    ["--no-color", "pull"],
    ["--no-color", "push"],
    [
      "--no-color",
      "remote",
      "add",
      "--default",
      "--",
      "-origin",
      "https://example.com/project?token=a&b=c",
    ],
  ]);
});

test("AtomicClient rejects paths outside the repository", () => {
  const client = new AtomicClient("/repo", "atomic", async () => Buffer.alloc(0));

  assert.throws(() => client.relativePath("/outside/file.ts"), /outside the Atomic repository/);
  assert.equal(client.relativePath("/repo/folder/file.ts"), "folder/file.ts");
});

test("AtomicClient serializes commands for repositories with exclusive database locks", async () => {
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstFinished = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const runner: CommandRunner = async (_executable, args) => {
    const command = args.slice(1).join(" ");
    events.push(`start:${command}`);
    if (command === "status --json") {
      await firstFinished;
      events.push(`finish:${command}`);
      return Buffer.from(
        JSON.stringify({
          schema_version: 1,
          repository_root: "/repo",
          view: "dev",
          state: null,
          clean: true,
          needs_reindex: false,
          stale_index_count: 0,
          entries: [],
        }),
      );
    }
    events.push(`finish:${command}`);
    return Buffer.from(
      JSON.stringify({
        schema_version: 1,
        source: "local",
        repository_root: "/repo",
        remote: null,
        current_view: "dev",
        views: [],
      }),
    );
  };
  const client = new AtomicClient("/repo", "atomic", runner);

  const status = client.status();
  const views = client.views();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:status --json"]);

  releaseFirst?.();
  await Promise.all([status, views]);

  assert.deepEqual(events, [
    "start:status --json",
    "finish:status --json",
    "start:view list --json",
    "finish:view list --json",
  ]);
});
