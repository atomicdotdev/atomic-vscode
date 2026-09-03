# Atomic for Visual Studio Code

Use [Atomic](https://github.com/atomicdotdev/atomic) from Visual Studio Code's built-in Source Control view.

## Features

- Shows modified, added, deleted, untracked, and conflicted files.
- Records tracked changes from the Source Control message box.
- Adds untracked files and restores tracked files from context menus.
- Opens working-copy diffs and editor gutter quick diffs.
- Shows the current Atomic view in the status bar and switches views from a picker.
- Initializes local repositories and clones remote repositories from the Command Palette.
- Pulls from and pushes to the repository's default remote with progress and error reporting.
- Configures a default remote without shelling out through a terminal.
- Supports multi-root workspaces with one Source Control provider per Atomic repository.

## Requirements

Install an Atomic CLI version that supports the versioned integration commands:

```console
atomic status --json
atomic view list --json
```

The extension runs the CLI directly in each workspace folder. It does not require a running Atomic server. Configure a non-default executable with `atomic.path`.
External records and view switches are detected through repository metadata. After an external `atomic add`, use the Source Control refresh button if the working file itself did not change.

## Usage

1. Run **Atomic: Initialize Repository** for a local folder, or **Atomic: Clone Repository**
   for an existing remote. Existing repositories can be opened directly when their root contains
   `.atomic`.
2. Open the Source Control view.
3. Add untracked files or inspect tracked changes.
4. Enter a message and press `Ctrl+Enter` (`Cmd+Enter` on macOS) to record.
5. Use the pull and push buttons in the Atomic Source Control title bar to synchronize the
   repository's default remote.

Restoring a file discards its unrecorded tracked changes, so the extension asks for confirmation first.
Pulling with unrecorded changes also requires confirmation. Remote authentication, identity selection,
and transport behavior continue to use the Atomic CLI's existing configuration.

## Development

```console
npm install
npm test
npm run build
npm run package
```

Run the process-level integration test against a compatible locally built CLI:

```console
ATOMIC_BIN=/absolute/path/to/atomic npm run test:live
```

Set `ATOMIC_REMOTE_URL` to an isolated test project URL (and point `ATOMIC_CONFIG_DIR` at its
authenticated CLI profile) to also run the repeatable clone, push, and pull round-trip test.

Press `F5` in VS Code to launch an Extension Development Host after running `npm install`.

## Protocol compatibility

The extension validates `schema_version` before consuming CLI JSON. A newer incompatible Atomic CLI produces a clear error instead of silently misclassifying files.

## License

Apache-2.0
