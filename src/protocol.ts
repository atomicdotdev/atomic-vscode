export const SUPPORTED_SCHEMA_VERSION = 1;

export type AtomicFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "untracked"
  | "conflicted"
  | "type_changed"
  | "permissions_changed"
  | "clean";

export interface StatusEntry {
  path: string;
  status: AtomicFileStatus;
  code: string;
  details: string | null;
}

export interface StatusDocument {
  schema_version: number;
  repository_root: string;
  view: string;
  state: string | null;
  clean: boolean;
  needs_reindex: boolean;
  stale_index_count: number;
  entries: StatusEntry[];
}

export interface ViewDocument {
  name: string;
  current: boolean;
  scope: "shared" | "draft";
  parent: string | null;
  change_count: number;
  own_change_count: number | null;
  inherited_change_count: number | null;
  state: string | null;
  set_id: string | null;
}

export interface ViewListDocument {
  schema_version: number;
  source: "local" | "remote";
  repository_root: string | null;
  remote: string | null;
  current_view: string | null;
  views: ViewDocument[];
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const statuses = new Set<AtomicFileStatus>([
  "added",
  "modified",
  "deleted",
  "untracked",
  "conflicted",
  "type_changed",
  "permissions_changed",
  "clean",
]);

function parseObject(json: string, command: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new ProtocolError(`${command} returned invalid JSON: ${String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${command} returned a non-object JSON value`);
  }
  return value as Record<string, unknown>;
}

function requireSchema(value: Record<string, unknown>, command: string): void {
  if (value.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new ProtocolError(
      `${command} uses unsupported schema version ${String(value.schema_version)}; expected ${SUPPORTED_SCHEMA_VERSION}. Update Atomic and this extension so their integration versions match.`,
    );
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError(`${field} must be a string`);
  }
  return value;
}

function requireRelativePath(value: unknown, field: string): string {
  const path = requireString(value, field);
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw new ProtocolError(`${field} must stay within the repository`);
  }
  return path;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, field);
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`${field} must be a finite number`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolError(`${field} must be a boolean`);
  }
  return value;
}

export function parseStatus(json: string): StatusDocument {
  const value = parseObject(json, "atomic status --json");
  requireSchema(value, "atomic status --json");
  if (!Array.isArray(value.entries)) {
    throw new ProtocolError("entries must be an array");
  }

  const entries = value.entries.map((entry, index): StatusEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ProtocolError(`entries[${index}] must be an object`);
    }
    const object = entry as Record<string, unknown>;
    const status = requireString(object.status, `entries[${index}].status`);
    if (!statuses.has(status as AtomicFileStatus)) {
      throw new ProtocolError(`entries[${index}].status is unknown: ${status}`);
    }
    return {
      path: requireRelativePath(object.path, `entries[${index}].path`),
      status: status as AtomicFileStatus,
      code: requireString(object.code, `entries[${index}].code`),
      details: optionalString(object.details, `entries[${index}].details`),
    };
  });

  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    repository_root: requireString(value.repository_root, "repository_root"),
    view: requireString(value.view, "view"),
    state: optionalString(value.state, "state"),
    clean: requireBoolean(value.clean, "clean"),
    needs_reindex: requireBoolean(value.needs_reindex, "needs_reindex"),
    stale_index_count: requireNumber(value.stale_index_count, "stale_index_count"),
    entries,
  };
}

export function parseViewList(json: string): ViewListDocument {
  const value = parseObject(json, "atomic view list --json");
  requireSchema(value, "atomic view list --json");
  if (value.source !== "local" && value.source !== "remote") {
    throw new ProtocolError("source must be local or remote");
  }
  if (!Array.isArray(value.views)) {
    throw new ProtocolError("views must be an array");
  }

  const views = value.views.map((view, index): ViewDocument => {
    if (typeof view !== "object" || view === null || Array.isArray(view)) {
      throw new ProtocolError(`views[${index}] must be an object`);
    }
    const object = view as Record<string, unknown>;
    if (object.scope !== "shared" && object.scope !== "draft") {
      throw new ProtocolError(`views[${index}].scope must be shared or draft`);
    }
    return {
      name: requireString(object.name, `views[${index}].name`),
      current: requireBoolean(object.current, `views[${index}].current`),
      scope: object.scope,
      parent: optionalString(object.parent, `views[${index}].parent`),
      change_count: requireNumber(object.change_count, `views[${index}].change_count`),
      own_change_count:
        object.own_change_count === null
          ? null
          : requireNumber(object.own_change_count, `views[${index}].own_change_count`),
      inherited_change_count:
        object.inherited_change_count === null
          ? null
          : requireNumber(object.inherited_change_count, `views[${index}].inherited_change_count`),
      state: optionalString(object.state, `views[${index}].state`),
      set_id: optionalString(object.set_id, `views[${index}].set_id`),
    };
  });

  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    source: value.source,
    repository_root: optionalString(value.repository_root, "repository_root"),
    remote: optionalString(value.remote, "remote"),
    current_view: optionalString(value.current_view, "current_view"),
    views,
  };
}
