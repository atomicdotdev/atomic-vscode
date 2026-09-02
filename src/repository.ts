import * as vscode from "vscode";
import { AtomicClient, shouldRefreshForPath } from "./client";
import { AtomicFileStatus, StatusDocument, StatusEntry } from "./protocol";

export const PRISTINE_SCHEME = "atomic-pristine";
export const EMPTY_SCHEME = "atomic-empty";

export interface AtomicResourceState extends vscode.SourceControlResourceState {
  repository: AtomicRepository;
  relativePath: string;
  status: AtomicFileStatus;
}

export class AtomicRepository implements vscode.Disposable, vscode.QuickDiffProvider {
  readonly rootUri: vscode.Uri;
  readonly sourceControl: vscode.SourceControl;

  private readonly changes: vscode.SourceControlResourceGroup;
  private readonly untracked: vscode.SourceControlResourceGroup;
  private readonly conflicts: vscode.SourceControlResourceGroup;
  private readonly client: AtomicClient;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private refreshAgain = false;
  private lastError = "";

  constructor(
    rootUri: vscode.Uri,
    executable: string,
    private readonly output: vscode.OutputChannel,
  ) {
    this.rootUri = rootUri;
    this.client = new AtomicClient(rootUri.fsPath, executable);
    this.sourceControl = vscode.scm.createSourceControl("atomic", "Atomic", rootUri);
    this.sourceControl.inputBox.placeholder = "Record message (press Ctrl+Enter to record)";
    this.sourceControl.acceptInputCommand = {
      command: "atomic.record",
      title: "Record",
      arguments: [this],
    };
    this.sourceControl.quickDiffProvider = this;

    this.changes = this.sourceControl.createResourceGroup("changes", "Changes");
    this.untracked = this.sourceControl.createResourceGroup("untracked", "Untracked");
    this.conflicts = this.sourceControl.createResourceGroup("conflicts", "Conflicts");
    this.changes.hideWhenEmpty = true;
    this.untracked.hideWhenEmpty = true;
    this.conflicts.hideWhenEmpty = true;

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootUri, "**/*"),
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.scheduleRefreshFor(uri)),
      watcher.onDidChange((uri) => this.scheduleRefreshFor(uri)),
      watcher.onDidDelete((uri) => this.scheduleRefreshFor(uri)),
      this.sourceControl,
    );

    void this.refresh();
  }

  get root(): string {
    return this.rootUri.fsPath;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    let relativePath: string;
    try {
      relativePath = this.client.relativePath(uri.fsPath);
    } catch {
      return undefined;
    }
    const resource = [...this.changes.resourceStates, ...this.conflicts.resourceStates].find(
      (candidate) => (candidate as AtomicResourceState).relativePath === relativePath,
    ) as AtomicResourceState | undefined;
    if (!resource) {
      return undefined;
    }
    if (resource.status === "added") {
      return virtualUri(EMPTY_SCHEME, this.root, relativePath);
    }
    return virtualUri(PRISTINE_SCHEME, this.root, relativePath);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const status = await this.client.status();
        this.applyStatus(status);
        this.lastError = "";
      } while (this.refreshAgain);
    } catch (error) {
      this.clearStatus();
      const message = formatError(error);
      this.output.appendLine(`[${this.root}] refresh failed: ${message}`);
      if (message !== this.lastError) {
        this.lastError = message;
        void vscode.window.showErrorMessage(`Atomic: ${message}`, "Show Output").then((choice) => {
          if (choice === "Show Output") {
            this.output.show();
          }
        });
      }
    } finally {
      this.refreshing = false;
    }
  }

  async add(entries: readonly StatusEntry[]): Promise<void> {
    await this.runOperation("add", () => this.client.add(entries.map((entry) => entry.path)));
  }

  async record(): Promise<void> {
    const message = this.sourceControl.inputBox.value;
    if (!message.trim()) {
      void vscode.window.showWarningMessage("Enter a record message first.");
      return;
    }
    if (await this.runOperation("record", () => this.client.record(message))) {
      this.sourceControl.inputBox.value = "";
    }
  }

  async restore(entry: StatusEntry): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Discard unrecorded changes in ${entry.path}?`,
      { modal: true },
      "Restore",
    );
    if (choice !== "Restore") {
      return;
    }
    await this.runOperation("restore", () => this.client.restore(entry.path));
  }

  async switchView(): Promise<void> {
    try {
      const document = await this.client.views();
      const selected = await vscode.window.showQuickPick(
        document.views.map((view) => ({
          label: view.name,
          description: view.current ? "current" : view.scope,
          detail: view.parent ? `parent: ${view.parent}` : undefined,
        })),
        { placeHolder: "Select an Atomic view" },
      );
      if (!selected || selected.label === document.current_view) {
        return;
      }
      await this.runOperation("switch view", () => this.client.switchView(selected.label));
    } catch (error) {
      this.showOperationError("list views", error);
    }
  }

  async openChange(entry: StatusEntry): Promise<void> {
    const working = vscode.Uri.joinPath(this.rootUri, ...entry.path.split("/"));
    if (entry.status === "untracked") {
      await vscode.window.showTextDocument(working);
      return;
    }
    const original = virtualUri(
      entry.status === "added" ? EMPTY_SCHEME : PRISTINE_SCHEME,
      this.root,
      entry.path,
    );
    const right =
      entry.status === "deleted" ? virtualUri(EMPTY_SCHEME, this.root, entry.path) : working;
    await vscode.commands.executeCommand(
      "vscode.diff",
      original,
      right,
      `${entry.path} (Atomic Working Copy)`,
    );
  }

  async original(relativePath: string): Promise<string> {
    return (await this.client.original(relativePath)).toString("utf8");
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const delay = vscode.workspace
      .getConfiguration("atomic", this.rootUri)
      .get<number>("refreshDebounceMs", 300);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  private scheduleRefreshFor(uri: vscode.Uri): void {
    let relativePath: string;
    try {
      relativePath = this.client.relativePath(uri.fsPath);
    } catch {
      return;
    }
    if (!shouldRefreshForPath(relativePath)) {
      return;
    }
    this.scheduleRefresh();
  }

  private clearStatus(): void {
    this.changes.resourceStates = [];
    this.untracked.resourceStates = [];
    this.conflicts.resourceStates = [];
    this.sourceControl.count = 0;
    this.sourceControl.statusBarCommands = [];
  }

  private applyStatus(status: StatusDocument): void {
    const resources = status.entries
      .filter((entry) => entry.details !== "directory")
      .map((entry) => this.resourceState(entry));
    this.changes.resourceStates = resources.filter((resource) =>
      ["added", "modified", "deleted", "type_changed", "permissions_changed"].includes(
        resource.status,
      ),
    );
    this.untracked.resourceStates = resources.filter(
      (resource) => resource.status === "untracked",
    );
    this.conflicts.resourceStates = resources.filter(
      (resource) => resource.status === "conflicted",
    );
    this.sourceControl.count = resources.length;
    this.sourceControl.statusBarCommands = [
      {
        command: "atomic.switchView",
        title: `$(git-branch) ${status.view}`,
        tooltip: "Switch Atomic view",
        arguments: [this],
      },
    ];
  }

  private resourceState(entry: StatusEntry): AtomicResourceState {
    const resourceUri = vscode.Uri.joinPath(this.rootUri, ...entry.path.split("/"));
    return {
      resourceUri,
      repository: this,
      relativePath: entry.path,
      status: entry.status,
      contextValue: `atomic.${entry.status}`,
      decorations: decorations(entry),
      command: {
        command: "atomic.openChange",
        title: "Open Change",
        arguments: [this, entry],
      },
    };
  }

  private async runOperation(name: string, operation: () => Promise<void>): Promise<boolean> {
    try {
      await operation();
      await this.refresh();
      return true;
    } catch (error) {
      this.showOperationError(name, error);
      return false;
    }
  }

  private showOperationError(name: string, error: unknown): void {
    const message = formatError(error);
    this.output.appendLine(`[${this.root}] ${name} failed: ${message}`);
    void vscode.window.showErrorMessage(`Atomic ${name} failed: ${message}`, "Show Output").then(
      (choice) => {
        if (choice === "Show Output") {
          this.output.show();
        }
      },
    );
  }
}

function decorations(entry: StatusEntry): vscode.SourceControlResourceDecorations {
  const icons: Record<AtomicFileStatus, string> = {
    added: "diff-added",
    modified: "diff-modified",
    deleted: "diff-removed",
    untracked: "question",
    conflicted: "warning",
    type_changed: "diff-modified",
    permissions_changed: "diff-modified",
    clean: "pass",
  };
  return {
    iconPath: new vscode.ThemeIcon(icons[entry.status]),
    strikeThrough: entry.status === "deleted",
    tooltip: entry.status.replaceAll("_", " "),
  };
}

export function virtualUri(scheme: string, root: string, relativePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme,
    path: `/${relativePath}`,
    query: new URLSearchParams({ root }).toString(),
  });
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
