import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  parseStatus,
  parseViewList,
  ProtocolError,
  StatusDocument,
  ViewListDocument,
} from "./protocol";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function inferCloneFolderName(remote: string): string {
  const trimmed = remote.trim().replace(/\/+$/, "");
  let segments: string[] = [];
  try {
    segments = new URL(trimmed).pathname.split("/").filter(Boolean);
  } catch {
    segments = trimmed.split("/").filter(Boolean);
  }

  const last = segments.at(-1);
  const candidate = last === "code" ? segments.at(-2) : last;
  return candidate?.replace(/\.git$/, "") || "repo";
}

export function validateCloneFolderName(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "Enter a folder name";
  }
  const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    name === "." ||
    name === ".." ||
    /[\x00-\x1f<>:"/\\|?*]/.test(name) ||
    /[. ]$/.test(name) ||
    windowsReservedName.test(name)
  ) {
    return "Enter a single valid folder name";
  }
  return undefined;
}

export function validateRemoteName(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "Enter a remote name";
  }
  if (name === "." || name === ".." || name.startsWith("-") || !/^[A-Za-z0-9_-]+$/.test(name)) {
    return "Use letters, numbers, hyphens, or underscores; do not start with a hyphen";
  }
  return undefined;
}

export function redactSensitiveUrls(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      const authority = url.username || url.password ? "[redacted]@" : "";
      const query = url.search ? "?[redacted]" : "";
      const fragment = url.hash ? "#[redacted]" : "";
      return `${url.protocol}//${authority}${url.host}${url.pathname}${query}${fragment}`;
    } catch {
      return raw;
    }
  });
}

export function isAtomicMetadataPath(relativePath: string): boolean {
  return relativePath === ".atomic" || relativePath.startsWith(".atomic/");
}

export function shouldRefreshForPath(
  relativePath: string,
): boolean {
  return relativePath !== ".atomic/pristine.redb";
}

export async function assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Refusing to restore through symbolic link: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
) => Promise<Buffer>;

export async function initializeRepository(
  executable: string,
  target: string,
  runner: CommandRunner = runCommand,
): Promise<void> {
  await runner(executable, ["--no-color", "init", "--", target], path.dirname(target));
}

export async function cloneRepository(
  executable: string,
  url: string,
  target: string,
  runner: CommandRunner = runCommand,
): Promise<void> {
  await runner(executable, ["--no-color", "clone", "--", url, target], path.dirname(target));
}

export class AtomicCommandError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(
    args: readonly string[],
    readonly exitCode: number | null,
    stderr: string,
  ) {
    const safeArgs = args.map(redactSensitiveUrls);
    const safeStderr = redactSensitiveUrls(stderr);
    super(
      safeStderr.trim() ||
        `atomic ${safeArgs.join(" ")} exited with code ${String(exitCode)}`,
    );
    this.name = "AtomicCommandError";
    this.args = safeArgs;
    this.stderr = safeStderr;
  }
}

export class AtomicClient {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly root: string,
    readonly executable: string,
    private readonly runner: CommandRunner = runCommand,
  ) {}

  async status(): Promise<StatusDocument> {
    return this.readJson(["status", "--json"], parseStatus);
  }

  async views(): Promise<ViewListDocument> {
    return this.readJson(["view", "list", "--json"], parseViewList);
  }

  async add(relativePaths: readonly string[]): Promise<void> {
    if (relativePaths.length === 0) {
      return;
    }
    await this.run(["add", "--", ...relativePaths]);
  }

  async record(message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new Error("A record message is required");
    }
    await this.run(["record", `--message=${trimmed}`]);
  }

  async restore(relativePath: string): Promise<void> {
    await this.enqueue(async () => {
      await assertNoSymlinkComponents(this.root, relativePath);
      await this.runner(
        this.executable,
        ["--no-color", "restore", "--", relativePath],
        this.root,
      );
    });
  }

  async switchView(name: string): Promise<void> {
    await this.run(["view", "switch", "--", name]);
  }

  async pull(): Promise<void> {
    await this.run(["pull"]);
  }

  async push(): Promise<void> {
    await this.run(["push"]);
  }

  async addDefaultRemote(name: string, url: string): Promise<void> {
    await this.run(["remote", "add", "--default", "--", name, url]);
  }

  async original(relativePath: string): Promise<Buffer> {
    return this.run(["restore", "--dry-run", "--", relativePath]);
  }

  relativePath(absolutePath: string): string {
    const relative = path.relative(this.root, absolutePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the Atomic repository: ${absolutePath}`);
    }
    return relative.split(path.sep).join("/");
  }

  private run(args: readonly string[]): Promise<Buffer> {
    return this.enqueue(() =>
      this.runner(this.executable, ["--no-color", ...args], this.root),
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.queue.then(operation);
    this.queue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  private async readJson<T>(args: readonly string[], parse: (json: string) => T): Promise<T> {
    try {
      return parse((await this.run(args)).toString("utf8"));
    } catch (error) {
      if (
        error instanceof AtomicCommandError &&
        (/(?:unexpected|unknown).*(?:argument|option).*--json/is.test(error.stderr) ||
          (/error:\s*unknown-arg/i.test(error.stderr) &&
            /got:\s*--json(?:\s|$)/i.test(error.stderr)))
      ) {
        throw new ProtocolError(
          "The installed Atomic CLI does not support editor integration. Run 'atomic update' and try again.",
        );
      }
      throw error;
    }
  }
}

function runCommand(executable: string, args: readonly string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let outputError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        if (!outputError) {
          outputError = new Error("Atomic CLI output exceeded 16 MiB");
          child.kill();
          forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
          forceKillTimer.unref();
        }
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (settled) {
        return;
      }
      settled = true;
      if (outputError) {
        reject(outputError);
      } else if (exitCode === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new AtomicCommandError(args, exitCode, Buffer.concat(stderr).toString("utf8")));
      }
    });
  });
}
