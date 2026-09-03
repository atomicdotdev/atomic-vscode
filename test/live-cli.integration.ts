import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AtomicClient,
  AtomicCommandError,
  cloneRepository,
  initializeRepository,
} from "../src/client";

const atomicBin = process.env.ATOMIC_BIN;
const atomicRemoteUrl = process.env.ATOMIC_REMOTE_URL;

test("live Atomic CLI supports the editor workflow", async () => {
  assert.ok(atomicBin, "Set ATOMIC_BIN to an Atomic CLI built from atomic PR #188");
  const parent = await mkdtemp(path.join(os.tmpdir(), "atomic-vscode-live-"));

  try {
    const repository = path.join(parent, "repository with spaces");
    await mkdir(repository);
    await initializeRepository(atomicBin, repository);
    await access(path.join(repository, ".atomic"));

    const client = new AtomicClient(repository, atomicBin);
    const file = path.join(repository, "tracked file.txt");
    await writeFile(file, "baseline\n");
    assert.equal(
      (await client.status()).entries.find((entry) => entry.path === "tracked file.txt")?.status,
      "untracked",
    );

    await client.add(["tracked file.txt"]);
    await client.record("baseline from the VS Code live test");
    await writeFile(file, "changed\n");
    assert.equal(
      (await client.status()).entries.find((entry) => entry.path === "tracked file.txt")?.status,
      "modified",
    );
    assert.equal((await client.original("tracked file.txt")).toString("utf8"), "baseline\n");
    await client.restore("tracked file.txt");
    assert.equal(await readFile(file, "utf8"), "baseline\n");

    await client.addDefaultRemote(
      "origin",
      "http://127.0.0.1:1/workspaces/acme/projects/demo/code",
    );
    await assert.rejects(
      client.pull(),
      (error) => error instanceof AtomicCommandError && error.args.includes("pull"),
    );
    await assert.rejects(
      client.push(),
      (error) => error instanceof AtomicCommandError && error.args.includes("push"),
    );

    const cloneTarget = path.join(parent, "failed clone");
    await assert.rejects(
      cloneRepository(
        atomicBin,
        "http://127.0.0.1:1/workspaces/acme/projects/demo/code",
        cloneTarget,
      ),
      (error) => error instanceof AtomicCommandError && error.args.includes("clone"),
    );
    await assert.rejects(access(cloneTarget));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test(
  "live Atomic storage round-trips clone, push, and pull",
  { skip: atomicRemoteUrl ? false : "Set ATOMIC_REMOTE_URL to an isolated Atomic test project" },
  async () => {
    assert.ok(atomicBin, "Set ATOMIC_BIN to an Atomic CLI built from atomic PR #188");
    assert.ok(atomicRemoteUrl);
    const parent = await mkdtemp(path.join(os.tmpdir(), "atomic-vscode-remote-live-"));

    try {
      const author = path.join(parent, "author repo");
      await cloneRepository(atomicBin, atomicRemoteUrl, author);
      const authorClient = new AtomicClient(author, atomicBin);

      const relativePath = `round-trip-${Date.now()}-${process.pid}.txt`;
      const file = path.join(author, relativePath);
      await writeFile(file, "from author\n");
      await authorClient.add([relativePath]);
      await authorClient.record("create remote round-trip fixture");
      await authorClient.push();

      const reader = path.join(parent, "reader repo");
      await cloneRepository(atomicBin, atomicRemoteUrl, reader);
      assert.equal(await readFile(path.join(reader, relativePath), "utf8"), "from author\n");

      await writeFile(file, "updated by author\n");
      await authorClient.record("update remote round-trip fixture");
      await authorClient.push();

      const readerClient = new AtomicClient(reader, atomicBin);
      await readerClient.pull();
      assert.equal(
        await readFile(path.join(reader, relativePath), "utf8"),
        "updated by author\n",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
