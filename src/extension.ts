import * as vscode from "vscode";
import {
  cloneRepository,
  inferCloneFolderName,
  initializeRepository,
  validateCloneFolderName,
} from "./client";
import {
  AtomicRepository,
  AtomicResourceState,
  EMPTY_SCHEME,
  formatError,
  PRISTINE_SCHEME,
} from "./repository";
import { StatusEntry } from "./protocol";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Atomic", { log: true });
  const repositories = new Map<string, AtomicRepository>();

  const executableFor = (resource?: vscode.Uri): string =>
    vscode.workspace.getConfiguration("atomic", resource).get<string>("path", "atomic");

  const runSetupOperation = async (
    title: string,
    operation: () => Promise<void>,
  ): Promise<boolean> => {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title,
          cancellable: false,
        },
        operation,
      );
      return true;
    } catch (error) {
      const message = formatError(error);
      output.appendLine(`[setup] ${title} failed: ${message}`);
      const choice = await vscode.window.showErrorMessage(`Atomic: ${message}`, "Show Output");
      if (choice === "Show Output") {
        output.show();
      }
      return false;
    }
  };

  const offerOpenRepository = async (uri: vscode.Uri, message: string): Promise<void> => {
    const choice = await vscode.window.showInformationMessage(message, "Open Repository");
    if (choice === "Open Repository") {
      await vscode.commands.executeCommand("vscode.openFolder", uri);
    }
  };

  const removeRepository = (folder: vscode.WorkspaceFolder): void => {
    const repository = repositories.get(folder.uri.toString());
    repository?.dispose();
    repositories.delete(folder.uri.toString());
  };

  const addRepository = async (folder: vscode.WorkspaceFolder): Promise<void> => {
    const key = folder.uri.toString();
    if (repositories.has(key) || folder.uri.scheme !== "file") {
      return;
    }
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, ".atomic"));
    } catch {
      return;
    }
    // Initialization can race the root marker watcher. Re-check after the async stat so
    // only one Source Control provider and one set of filesystem watchers are created.
    if (repositories.has(key)) {
      return;
    }
    const executable = vscode.workspace
      .getConfiguration("atomic", folder.uri)
      .get<string>("path", "atomic");
    repositories.set(
      key,
      new AtomicRepository(folder.uri, executable, output),
    );
  };

  const reloadRepositories = async (): Promise<void> => {
    for (const repository of repositories.values()) {
      repository.dispose();
    }
    repositories.clear();
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(addRepository));
  };

  const folderForRootMarker = (uri: vscode.Uri): vscode.WorkspaceFolder | undefined => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== "file") {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, ".atomic").toString() === uri.toString()
      ? folder
      : undefined;
  };

  const resolveRepository = (candidate?: unknown): AtomicRepository | undefined => {
    if (candidate instanceof AtomicRepository) {
      return candidate;
    }
    if (isAtomicResource(candidate)) {
      return candidate.repository;
    }
    if (isSourceControl(candidate)) {
      return [...repositories.values()].find(
        (repository) => repository.rootUri.toString() === candidate.rootUri?.toString(),
      );
    }
    return repositories.size === 1 ? repositories.values().next().value : undefined;
  };

  const requireRepository = (candidate?: unknown): AtomicRepository | undefined => {
    const repository = resolveRepository(candidate);
    if (!repository) {
      void vscode.window.showWarningMessage("Select an Atomic repository first.");
    }
    return repository;
  };

  const pristineProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri) => {
      const root = new URLSearchParams(uri.query).get("root");
      const repository = [...repositories.values()].find((item) => item.root === root);
      if (!repository) {
        throw new Error("Atomic repository is no longer open");
      }
      return repository.original(uri.path.replace(/^\//, ""));
    },
  };
  const emptyProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: () => "",
  };
  const markerWatcher = vscode.workspace.createFileSystemWatcher("**/.atomic");

  context.subscriptions.push(
    output,
    markerWatcher,
    markerWatcher.onDidCreate(async (uri) => {
      const folder = folderForRootMarker(uri);
      if (folder) {
        await addRepository(folder);
      }
    }),
    markerWatcher.onDidDelete((uri) => {
      const folder = folderForRootMarker(uri);
      if (folder) {
        removeRepository(folder);
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(PRISTINE_SCHEME, pristineProvider),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, emptyProvider),
    vscode.commands.registerCommand("atomic.init", async () => {
      const selection = await vscode.window.showOpenDialog({
        title: "Select a folder to initialize with Atomic",
        openLabel: "Initialize Repository",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      const target = selection?.[0];
      if (!target) {
        return;
      }
      if (target.scheme !== "file") {
        void vscode.window.showErrorMessage("Atomic can only initialize local folders.");
        return;
      }

      const initialized = await runSetupOperation("Atomic: Initializing repository", () =>
        initializeRepository(executableFor(target), target.fsPath),
      );
      if (!initialized) {
        return;
      }

      const workspaceFolder = (vscode.workspace.workspaceFolders ?? []).find(
        (folder) => folder.uri.toString() === target.toString(),
      );
      if (workspaceFolder) {
        await addRepository(workspaceFolder);
        await repositories.get(workspaceFolder.uri.toString())?.refresh();
        const choice = await vscode.window.showInformationMessage(
          "Atomic repository initialized.",
          "Add Remote",
        );
        if (choice === "Add Remote") {
          await repositories.get(workspaceFolder.uri.toString())?.addDefaultRemote();
        }
      } else {
        await offerOpenRepository(target, "Atomic repository initialized.");
      }
    }),
    vscode.commands.registerCommand("atomic.clone", async () => {
      const remote = await vscode.window.showInputBox({
        title: "Clone Atomic Repository",
        prompt: "Remote repository URL",
        placeHolder: "https://example.com/workspaces/acme/projects/project/code",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : "Enter a remote repository URL"),
      });
      if (!remote) {
        return;
      }

      const selection = await vscode.window.showOpenDialog({
        title: "Select the parent folder for the cloned repository",
        openLabel: "Select Destination",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      const parent = selection?.[0];
      if (!parent) {
        return;
      }
      if (parent.scheme !== "file") {
        void vscode.window.showErrorMessage("Atomic can only clone into local folders.");
        return;
      }

      const folderName = await vscode.window.showInputBox({
        title: "Clone Atomic Repository",
        prompt: "Repository folder name",
        value: inferCloneFolderName(remote),
        ignoreFocusOut: true,
        validateInput: validateCloneFolderName,
      });
      if (!folderName) {
        return;
      }

      const target = vscode.Uri.joinPath(parent, folderName.trim());
      const cloned = await runSetupOperation("Atomic: Cloning repository", () =>
        cloneRepository(executableFor(), remote.trim(), target.fsPath),
      );
      if (cloned) {
        await offerOpenRepository(target, "Atomic repository cloned.");
      }
    }),
    vscode.commands.registerCommand("atomic.refresh", async (candidate?: unknown) => {
      const repository = resolveRepository(candidate);
      if (repository) {
        await repository.refresh();
      } else {
        await Promise.all([...repositories.values()].map((item) => item.refresh()));
      }
    }),
    vscode.commands.registerCommand("atomic.add", async (candidate?: unknown) => {
      const resource = isAtomicResource(candidate) ? candidate : undefined;
      const repository = requireRepository(resource ?? candidate);
      if (repository && resource) {
        await repository.add([toStatusEntry(resource)]);
      }
    }),
    vscode.commands.registerCommand("atomic.record", async (candidate?: unknown) => {
      await requireRepository(candidate)?.record();
    }),
    vscode.commands.registerCommand("atomic.restore", async (candidate?: unknown) => {
      const resource = isAtomicResource(candidate) ? candidate : undefined;
      const repository = requireRepository(resource ?? candidate);
      if (repository && resource) {
        await repository.restore(toStatusEntry(resource));
      }
    }),
    vscode.commands.registerCommand("atomic.switchView", async (candidate?: unknown) => {
      await requireRepository(candidate)?.switchView();
    }),
    vscode.commands.registerCommand("atomic.pull", async (candidate?: unknown) => {
      await requireRepository(candidate)?.pull();
    }),
    vscode.commands.registerCommand("atomic.push", async (candidate?: unknown) => {
      await requireRepository(candidate)?.push();
    }),
    vscode.commands.registerCommand("atomic.addRemote", async (candidate?: unknown) => {
      await requireRepository(candidate)?.addDefaultRemote();
    }),
    vscode.commands.registerCommand(
      "atomic.openChange",
      async (candidate?: unknown, entry?: StatusEntry) => {
        const repository = requireRepository(candidate);
        if (repository && entry) {
          await repository.openChange(entry);
        }
      },
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      event.removed.forEach(removeRepository);
      await Promise.all(event.added.map(addRepository));
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("atomic.path")) {
        await reloadRepositories();
      }
    }),
    { dispose: () => repositories.forEach((repository) => repository.dispose()) },
  );

  await Promise.all((vscode.workspace.workspaceFolders ?? []).map(addRepository));
}

export function deactivate(): void {}

function isAtomicResource(candidate: unknown): candidate is AtomicResourceState {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "repository" in candidate &&
    (candidate as { repository?: unknown }).repository instanceof AtomicRepository &&
    "relativePath" in candidate &&
    "status" in candidate
  );
}

function isSourceControl(candidate: unknown): candidate is vscode.SourceControl {
  return typeof candidate === "object" && candidate !== null && "rootUri" in candidate;
}

function toStatusEntry(resource: AtomicResourceState): StatusEntry {
  return {
    path: resource.relativePath,
    status: resource.status,
    code: "",
    details: null,
  };
}
