import test from "node:test";
import assert from "node:assert/strict";
import { runOpenListReconcile, parseArgs } from "../scripts/openlist-reconcile.mjs";

test("parseArgs requires a media task id and accepts OpenList task group", () => {
  assert.deepEqual(parseArgs(["media-id", "--group", "copy"]), { id: "media-id", envFile: ".env", group: "copy", timeoutMs: 20000 });
});

test("moves TRANSFERRING to VERIFYING only when exact OpenList task is confirmed successful", async () => {
  const transitions = [];
  const task = { id: "media-1", state: "TRANSFERRING", openListTaskId: "ol-1" };
  const result = await runOpenListReconcile({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "secret" },
    args: { id: "media-1" },
    store: { getTask: async () => task, transitionTask: async (_id, state) => { transitions.push(state); return { ...task, state }; } },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.endsWith("/api/task/copy/undone")) return jsonResponse({ code: 200, data: [] });
      assert.equal(text, "http://openlist.test/api/task/copy/done");
      return jsonResponse({ code: 200, data: [{ id: "ol-1", progress: 100, status: "success" }] });
    }
  });
  assert.deepEqual(transitions, ["VERIFYING"]);
  assert.equal(result.mediaTaskState, "VERIFYING");
  assert.equal(result.openList.status, "SUCCEEDED");
});

test("keeps active OpenList tasks in TRANSFERRING", async () => {
  const transitions = [];
  const task = { id: "media-2", state: "TRANSFERRING", openListTaskId: "ol-2" };
  const result = await runOpenListReconcile({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "secret" }, args: { id: "media-2" },
    store: { getTask: async () => task, transitionTask: async (_id, state) => { transitions.push(state); return { ...task, state }; } },
    fetchImpl: async (url) => String(url).endsWith("/undone")
      ? jsonResponse({ code: 200, data: [{ id: "ol-2", progress: 45 }] })
      : jsonResponse({ code: 200, data: [] })
  });
  assert.deepEqual(transitions, []);
  assert.equal(result.mediaTaskState, "TRANSFERRING");
  assert.equal(result.openList.status, "ACTIVE");
});

test("moves failed OpenList task to FAILED and missing task to UNKNOWN", async () => {
  const task = { id: "media-3", state: "TRANSFERRING", openListTaskId: "ol-3" };
  const transitions = [];
  const failed = await runOpenListReconcile({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "secret" }, args: { id: "media-3" },
    store: { getTask: async () => task, transitionTask: async (_id, state) => { transitions.push(state); return { ...task, state }; } },
    fetchImpl: async (url) => String(url).endsWith("/undone")
      ? jsonResponse({ code: 200, data: [] })
      : jsonResponse({ code: 200, data: [{ id: "ol-3", error: "disk full" }] })
  });
  assert.equal(failed.mediaTaskState, "FAILED");
  assert.deepEqual(transitions, ["FAILED"]);
});

test("does not advance when the OpenList task is absent from both lists", async () => {
  const task = { id: "media-4", state: "TRANSFERRING", openListTaskId: "ol-4" };
  const transitions = [];
  const result = await runOpenListReconcile({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "secret" }, args: { id: "media-4" },
    store: { getTask: async () => task, transitionTask: async (_id, state) => { transitions.push(state); return { ...task, state }; } },
    fetchImpl: async () => jsonResponse({ code: 200, data: [] })
  });
  assert.deepEqual(transitions, ["UNKNOWN"]);
  assert.equal(result.mediaTaskState, "UNKNOWN");
});

test("does not reconcile tasks outside TRANSFERRING", async () => {
  const result = await runOpenListReconcile({
    args: { id: "media-5" }, store: { getTask: async () => ({ id: "media-5", state: "STAGED" }) },
    fetchImpl: async () => { throw new Error("should not call OpenList"); }
  });
  assert.equal(result.changed, false);
  assert.equal(result.mediaTaskState, "STAGED");
});

function jsonResponse(body) { return { ok: true, status: 200, async text() { return JSON.stringify(body); } }; }
