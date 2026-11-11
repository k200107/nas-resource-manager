import test from "node:test";
import assert from "node:assert/strict";

import {
  compactTaskResult,
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

test("runOpenListTasks gets one task status with a single command", async () => {
  const endpoints = [];
  const result = await runOpenListTasks({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "token" },
    args: { action: "get", group: "copy", taskId: "copy-77" },
    fetchImpl: async (url) => {
      const endpoint = String(url);
      endpoints.push(endpoint);
      if (endpoint.endsWith("/api/task/copy/undone")) {
        return jsonResponse({ code: 200, message: "success", data: [] });
      }
      if (endpoint.endsWith("/api/task/copy/done")) {
        return jsonResponse({ code: 200, message: "success", data: [{ id: "copy-77", state: 2, status: "uploading", progress: 0.13, error: "" }] });
      }
      throw new Error("Unexpected request: " + endpoint);
    }
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.taskId, "copy-77");
  assert.equal(endpoints.length, 2);
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

test("lookupOpenListTaskById returns an active task without querying done", async () => {
  const endpoints = [];
  const result = await lookupOpenListTaskById({
    baseUrl: "http://openlist.test",
    token: "token",
    id: "copy-active",
    fetchImpl: async (url) => {
      const endpoint = String(url);
      endpoints.push(endpoint);
      if (endpoint.endsWith("/api/task/copy/undone")) {
        return jsonResponse({
          code: 200, message: "success",
          data: [{ id: "copy-active", name: "copy A", status: "uploading", progress: 12 }]
        });
      }
      throw new Error("done bucket should not be queried");
    }
  });
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.task.id, "copy-active");
  assert.equal(endpoints.length, 1);
});

test("compactTaskResult preserves cancellation outcome and confirmation state", () => {
  const result = compactTaskResult({
    ok: true, action: "cancel", group: "copy", state: "undone",
    matchedCount: 1, matchedIds: ["task-1"], cancelledIds: [],
    dryRun: true, nextAction: "confirm_task_cancel"
  });
  assert.deepEqual(result, {
    ok: true, action: "cancel", group: "copy", state: "undone",
    matchedCount: 1, matchedIds: ["task-1"], cancelledIds: [],
    dryRun: true, nextAction: "confirm_task_cancel"
  });
});

test("compactTaskResult removes task metadata not needed by the agent", () => {
  assert.equal(parseArgs(["list", "copy", "undone", "--compact"]).compact, true);
  const result = compactTaskResult({
    ok: true, action: "list", group: "copy", state: "undone",
    totalCount: 3, matchedCount: 1, nextAction: "report_tasks",
    tasks: [{
      id: "copy-active", name: "copy A", creator: "admin",
      creatorRole: 2, state: 1, status: "uploading",
      progress: 12, totalBytes: 2048, error: ""
    }]
  });
  assert.deepEqual(result.tasks, [{
    id: "copy-active", name: "copy A", status: "uploading",
    progress: 12, totalBytes: 2048
  }]);
  assert.equal("filter" in result, false);
});

test("lookupOpenListTaskById trusts the done bucket even if status text remains uploading", async () => {
  const result = await lookupOpenListTaskById({
    baseUrl: "http://openlist.test",
    token: "token",
    id: "copy-77",
    fetchImpl: async (url) => {
      const endpoint = String(url);
      if (endpoint.endsWith("/api/task/copy/undone")) {
        return jsonResponse({ code: 200, message: "success", data: [] });
      }
      if (endpoint.endsWith("/api/task/copy/done")) {
        return jsonResponse({
          code: 200,
          message: "success",
          data: [{ id: "copy-77", state: 2, status: "uploading", progress: 0.13, error: "" }]
        });
      }
      throw new Error("Unexpected request: " + endpoint);
    }
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.bucket, "done");
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
