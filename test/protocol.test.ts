import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatus, parseViewList, ProtocolError } from "../src/protocol";

test("parseStatus accepts schema v1 and preserves escaped paths", () => {
  const document = parseStatus(
    JSON.stringify({
      schema_version: 1,
      repository_root: "/repo",
      view: "dev",
      state: "STATE",
      clean: false,
      needs_reindex: false,
      stale_index_count: 0,
      entries: [
        {
          path: "folder/line\nbreak.txt",
          status: "untracked",
          code: "?",
          details: null,
        },
      ],
    }),
  );

  assert.equal(document.view, "dev");
  assert.equal(document.entries[0].path, "folder/line\nbreak.txt");
  assert.equal(document.entries[0].status, "untracked");
});

test("parseStatus rejects unknown schema versions", () => {
  assert.throws(
    () =>
      parseStatus(
        JSON.stringify({
          schema_version: 2,
          entries: [],
        }),
      ),
    (error: unknown) =>
      error instanceof ProtocolError && error.message.includes("unsupported schema version 2"),
  );
});

test("parseStatus rejects unknown file statuses", () => {
  assert.throws(
    () =>
      parseStatus(
        JSON.stringify({
          schema_version: 1,
          repository_root: "/repo",
          view: "dev",
          state: null,
          clean: false,
          needs_reindex: false,
          stale_index_count: 0,
          entries: [{ path: "file", status: "mystery", code: "X", details: null }],
        }),
      ),
    /status is unknown/,
  );
});

test("parseStatus rejects paths that escape the repository", () => {
  for (const path of ["../outside", "/absolute", "C:/absolute", String.raw`\\server\share`]) {
    assert.throws(
      () =>
        parseStatus(
          JSON.stringify({
            schema_version: 1,
            repository_root: "/repo",
            view: "dev",
            state: null,
            clean: false,
            needs_reindex: false,
            stale_index_count: 0,
            entries: [{ path, status: "modified", code: "M", details: null }],
          }),
        ),
      /must stay within the repository/,
      path,
    );
  }
});

test("parseViewList validates local view metadata", () => {
  const document = parseViewList(
    JSON.stringify({
      schema_version: 1,
      source: "local",
      repository_root: "/repo",
      remote: null,
      current_view: "feature",
      views: [
        {
          name: "feature",
          current: true,
          scope: "draft",
          parent: "dev",
          change_count: 3,
          own_change_count: 1,
          inherited_change_count: 2,
          state: "STATE",
          set_id: null,
        },
      ],
    }),
  );

  assert.equal(document.current_view, "feature");
  assert.equal(document.views[0].scope, "draft");
  assert.equal(document.views[0].parent, "dev");
});

test("parseViewList rejects malformed scopes", () => {
  assert.throws(
    () =>
      parseViewList(
        JSON.stringify({
          schema_version: 1,
          source: "local",
          repository_root: "/repo",
          remote: null,
          current_view: "dev",
          views: [
            {
              name: "dev",
              current: true,
              scope: "private",
              parent: null,
              change_count: 0,
              own_change_count: 0,
              inherited_change_count: 0,
              state: null,
              set_id: null,
            },
          ],
        }),
      ),
    /scope must be shared or draft/,
  );
});
