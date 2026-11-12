import test from "node:test";
import assert from "node:assert/strict";

import {
  filterTasks,
  lookupOpenListTaskById,
  parseArgs,
  runOpenListTasks
} from "../scripts/openlist-tasks.mjs";

test("parseArgs defaults to listing undone copy tasks as JSON", () => {
  const args = parseArgs([]);

  assert.equal(args.action, "list");
  assert.equal(args.group, "copy");
  assert.equal(args.state, "undone");
  assert.equal(args.format, "json");
});

test("filterTasks can select Baidu copy tasks", () => {
  const tasks = [
    { id: "a", name: "copy [/bdy](/NAS资源下载/A.mp4) to [/影视资源备份](/影视/A)" },
    { id: "b", name: "copy [/pan/quark](/备份资源/B.mkv) to [/影视资源备份](/影视/B)" }
  ];

  assert.deepEqual(filterTasks(tasks, { provider: "baidu" }).map((task) => task.id), ["a"]);
  assert.deepEqual(filterTasks(tasks, { provider: "quark" }).map((task) => task.id), ["b"]);
});

test("runOpenListTasks gets one task through the info endpoint and requires clear success", async () => {
  const calls = [];
  const result = await runOpenListTasks({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "token" },
    args: { action: "get", group: "copy", taskId: "copy-77" },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      return jsonResponse({ code: 200, message: "success", data: [{
        id: "copy-77", state: "succeeded", status: "", progress: 100, error: ""
      }] });
    }
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.taskId, "copy-77");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://openlist.test/api/task/copy/info?tid=copy-77");
  assert.equal(calls[0].method, "POST");
  assert.equal("creator" in result.task, false);
  assert.equal("startTime" in result.task, false);
});

test("runOpenListTasks lists tasks with injected fetch", async () => {
  const result = await runOpenListTasks({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "token" },
    args: { action: "list", group: "copy", state: "undone" },
    fetchImpl: async (url) => {
      assert.equal(String(url), "http://openlist.test/api/task/copy/undone");
      return jsonResponse({
        code: 200,
        message: "success",
        data: [{ id: "task-1", name: "copy A", state: 1, progress: 50 }]
      });
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.nextAction, "report_tasks");
  assert.equal(result.tasks[0].id, "task-1");
});

test("lookupOpenListTaskById does not treat done-like incomplete metadata as success", async () => {
  const result = await lookupOpenListTaskById({
    baseUrl: "http://openlist.test", token: "token", id: "copy-77",
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "http://openlist.test/api/task/copy/info?tid=copy-77");
      assert.equal(options.method, "POST");
      return jsonResponse({ code: 200, message: "success", data: [{
        id: "copy-77", state: 2, status: "uploading", progress: 0.13, error: ""
      }] });
    }
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "legacy_numeric_terminal_incomplete");
});

test("lookup accepts completed legacy numeric file task despite stale uploading status", async () => {
  const result = await lookupOpenListTaskById({
    baseUrl: "http://openlist.test", token: "token", id: "completed-legacy",
    fetchImpl: async () => jsonResponse({ code: 200, message: "success", data: [{
      id: "completed-legacy", state: 2, status: "uploading", progress: 100.0000019,
      endTime: "2026-11-11T17:29:23.438619675+08:00", totalBytes: 2346792545, error: ""
    }] })
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.reason, "legacy_numeric_terminal_metadata");
  assert.equal(result.task.endTime, "2026-11-11T17:29:23.438619675+08:00");
  assert.equal(result.task.totalBytes, 2346792545);
});

test("lookup does not treat directory task dispatch as a completed file copy", async () => {
  const result = await lookupOpenListTaskById({
    baseUrl: "http://openlist.test", token: "token", id: "directory-parent",
    fetchImpl: async () => jsonResponse({ code: 200, message: "success", data: [{
      id: "directory-parent", state: 2,
      status: "src object is dir, added all copy tasks of objs", progress: 0,
      endTime: "2026-11-11T15:09:24.625393583+08:00", totalBytes: 0, error: ""
    }] })
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "directory_task_dispatch");
});

test("lookup rejects succeeded state with progress below 100", async () => {
  const result = await lookupOpenListTaskById({
    baseUrl: "http://openlist.test", token: "token", id: "partial-1",
    fetchImpl: async () => jsonResponse({ code: 200, message: "success", data: [{
      id: "partial-1", state: "succeeded", status: "", progress: 13, error: ""
    }] })
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "success_state_incomplete_or_conflicting");
});

test("lookup returns active task from its info response with compact fields", async () => {
  const endpoints = [];
  const result = await lookupOpenListTaskById({
    baseUrl: "http://openlist.test", token: "token", id: "active-1",
    fetchImpl: async (url) => {
      endpoints.push(String(url));
      return jsonResponse({ code: 200, message: "success", data: [{
        id: "active-1", name: "copy A", state: "running", status: "copying",
        progress: 12, creator: "ignored", start_time: "ignored"
      }] });
    }
  });
  assert.equal(result.status, "ACTIVE");
  assert.equal(endpoints.length, 1);
  assert.deepEqual(Object.keys(result.task).sort(), ["endTime", "error", "id", "name", "progress", "state", "status", "totalBytes"]);
});

test("task errors redact URLs and truncate long details", async () => {
  const result = await lookupOpenListTaskById({
    baseUrl: "http://openlist.test", token: "token", id: "bad-1",
    fetchImpl: async () => jsonResponse({ code: 200, message: "success", data: [{
      id: "bad-1", state: "errored",
      error: "https://baidu.example/file?sign=SECRET&token=SECRET2 " + "x".repeat(400)
    }] })
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.task.error.includes("SECRET"), false);
  assert.equal(result.task.error.length <= 240, true);
});

test("runOpenListTasks previews cancel without yes", async () => {
  let cancelCalled = false;
  const result = await runOpenListTasks({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "token" },
    args: { action: "cancel", group: "copy", state: "undone", provider: "baidu", yes: false },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.endsWith("/api/task/copy/undone")) {
        return jsonResponse({
          code: 200,
          message: "success",
          data: [
            { id: "baidu-task", name: "copy [/bdy](/NAS资源下载/A.mp4) to [/影视资源备份](/影视/A)" }
          ]
        });
      }
      if (text.includes("/cancel")) cancelCalled = true;
      return jsonResponse({ code: 200, message: "success", data: null });
    }
  });

  assert.equal(cancelCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.nextAction, "confirm_task_cancel");
  assert.deepEqual(result.matchedIds, ["baidu-task"]);
});

test("runOpenListTasks cancels matched tasks with yes", async () => {
  const calledUrls = [];
  const result = await runOpenListTasks({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "token" },
    args: { action: "cancel", group: "copy", state: "undone", provider: "baidu", yes: true },
    fetchImpl: async (url) => {
      const text = String(url);
      calledUrls.push(text);
      if (text.endsWith("/api/task/copy/undone")) {
        return jsonResponse({
          code: 200,
          message: "success",
          data: [
            { id: "baidu-task", name: "copy [/bdy](/NAS资源下载/A.mp4) to [/影视资源备份](/影视/A)" }
          ]
        });
      }
      assert.equal(text, "http://openlist.test/api/task/copy/cancel_some");
      return jsonResponse({ code: 200, message: "success", data: {} });
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.nextAction, "verify_tasks_cancelled");
  assert.deepEqual(result.cancelledIds, ["baidu-task"]);
  assert.equal(calledUrls.length, 2);
});

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async text() {
      return JSON.stringify(body);
    }
  };
}
