import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  pollCopyCompletion,
  runOpenListCopy,
  toCompactCopyResult
} from "../scripts/openlist-copy.mjs";

test("parseArgs accepts source, destination, and object name positionals", () => {
  const args = parseArgs(["/pan/quark/备份资源", "/影视资源备份/影视", "绿皮书"]);

  assert.equal(args.srcDir, "/pan/quark/备份资源");
  assert.equal(args.dstDir, "/影视资源备份/影视");
  assert.deepEqual(args.names, ["绿皮书"]);
  assert.equal(args.format, "json");
  assert.equal(args.yes, false);
});

test("runOpenListCopy previews source and destination before mutation", async () => {
  let copyCalled = false;
  const result = await runOpenListCopy({
    env: {
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_TOKEN: "token",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
    },
    args: {
      srcDir: "/pan/quark/备份资源",
      names: ["绿皮书"],
      yes: false
    },
    fetchImpl: async (url, options) => {
      const text = String(url);
      if (text.endsWith("/api/fs/copy")) copyCalled = true;
      if (text.endsWith("/api/fs/list")) {
        const body = JSON.parse(options.body);
        if (body.path === "/pan/quark/备份资源") {
          return jsonResponse({
            code: 200,
            message: "success",
            data: { content: [{ name: "绿皮书", is_dir: true }] }
          });
        }
        if (body.path === "/影视资源备份/影视") {
          return jsonResponse({
            code: 200,
            message: "success",
            data: { content: [] }
          });
        }
      }
      throw new Error(`Unexpected request: ${text}`);
    }
  });

  assert.equal(copyCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.nextAction, "confirm_before_copy");
  assert.deepEqual(result.copyPlan.names, ["绿皮书"]);
  assert.deepEqual(result.copyPlan.expectedPaths, ["/影视资源备份/影视/绿皮书"]);
});

test("runOpenListCopy uses one task snapshot and treats a clean done bucket as success", async () => {
  const calls = [];
  const result = await runOpenListCopy({
    env: {
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_TOKEN: "token",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
    },
    args: {
      srcDir: "/pan/quark/备份资源",
      names: ["绿皮书"],
      yes: true,
      pollTimeoutMs: 100,
      intervalMs: 1
    },
    fetchImpl: async (url, options) => {
      const text = String(url);
      calls.push(text);
      if (text.endsWith("/api/fs/list")) {
        const body = JSON.parse(options.body);
        if (body.path === "/pan/quark/备份资源") {
          return jsonResponse({
            code: 200,
            message: "success",
            data: { content: [{ name: "绿皮书", is_dir: true }] }
          });
        }
        if (body.path === "/影视资源备份/影视") {
          return jsonResponse({
            code: 200,
            message: "success",
            data: { content: [] }
          });
        }
      }
      if (text.endsWith("/api/fs/copy")) {
        assert.deepEqual(JSON.parse(options.body), {
          src_dir: "/pan/quark/备份资源",
          dst_dir: "/影视资源备份/影视",
          names: ["绿皮书"]
        });
        return jsonResponse({
          code: 200,
          message: "success",
          data: {
            task: { id: "copy-1", name: "copy 绿皮书", state: 0, progress: 0 }
          }
        });
      }
      if (text.endsWith("/api/task/copy/undone")) {
        return jsonResponse({ code: 200, message: "success", data: [] });
      }
      if (text.endsWith("/api/task/copy/done")) {
        return jsonResponse({
          code: 200,
          message: "success",
          data: [{ id: "copy-1", name: "copy 绿皮书", progress: 100, error: "" }]
        });
      }
      throw new Error(`Unexpected request: ${text}`);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.nextAction, "copy_complete");
  assert.equal(result.copyTask.id, "copy-1");
  assert.equal(result.verification.status, "SUCCEEDED");
  assert.equal(calls.filter((url) => url.endsWith("/api/fs/list")).length, 2);
});

test("runOpenListCopy asks for confirmation when target already exists", async () => {
  const result = await runOpenListCopy({
    env: {
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_TOKEN: "token",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
    },
    args: {
      srcDir: "/pan/quark/备份资源",
      names: ["绿皮书"],
      yes: false
    },
    fetchImpl: async (url, options) => {
      const text = String(url);
      if (text.endsWith("/api/fs/list")) {
        const body = JSON.parse(options.body);
        if (body.path === "/pan/quark/备份资源") {
          return jsonResponse({
            code: 200,
            message: "success",
            data: { content: [{ name: "绿皮书", is_dir: true }] }
          });
        }
        if (body.path === "/影视资源备份/影视") {
          return jsonResponse({
            code: 200,
            message: "success",
            data: { content: [{ name: "绿皮书", is_dir: true }] }
          });
        }
      }
      throw new Error(`Unexpected request: ${text}`);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.nextAction, "confirm_copy_over_existing");
  assert.deepEqual(result.destination.existingTargetNames, ["绿皮书"]);
});

test("runOpenListCopy reports source mismatch before copy", async () => {
  const result = await runOpenListCopy({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "token" },
    args: {
      srcDir: "/pan/quark/备份资源",
      dstDir: "/影视资源备份/影视",
      names: ["不存在的资源"],
      yes: true
    },
    fetchImpl: async (url, options) => {
      const text = String(url);
      if (text.endsWith("/api/fs/list")) {
        const body = JSON.parse(options.body);
        if (body.path === "/pan/quark/备份资源") {
          return jsonResponse({
            code: 200,
            message: "success",
            data: { content: [{ name: "绿皮书", is_dir: true }] }
          });
        }
        if (body.path === "/影视资源备份/影视") {
          return jsonResponse({ code: 200, message: "success", data: { content: [] } });
        }
      }
      throw new Error(`Unexpected request: ${text}`);
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.nextAction, "fix_copy_source");
  assert.deepEqual(result.source.missingNames, ["不存在的资源"]);
});


test("parseArgs derives the source directory and item name from one exact OpenList item path", () => {
  const args = parseArgs([
    "--source-item-path", "/百度网盘/影视库/奥本海默 (2023)",
    "--dst-dir", "/本地存储/Downloads",
    "--compact"
  ]);

  assert.equal(args.srcDir, "/百度网盘/影视库");
  assert.deepEqual(args.names, ["奥本海默 (2023)"]);
  assert.equal(args.dstDir, "/本地存储/Downloads");
  assert.equal(args.compact, true);
});

test("parseArgs rejects ambiguous combinations with --source-item-path", () => {
  assert.throws(
    () => parseArgs(["--source-item-path", "/百度网盘/影视库/电影", "/来源", "/目标", "电影"]),
    /cannot be combined/
  );
});

test("toCompactCopyResult removes duplicated preview payload while preserving confirmation facts", () => {
  const compact = toCompactCopyResult({
    ok: true,
    dryRun: true,
    nextAction: "confirm_before_copy",
    source: { dir: "/百度网盘/影视库", itemCount: 10, foundNames: ["奥本海默 (2023)"], missingNames: [] },
    destination: { dir: "/本地存储/Downloads", exists: true, created: false, itemCount: 2, existingTargetNames: [] },
    copyPlan: {
      srcDir: "/百度网盘/影视库",
      dstDir: "/本地存储/Downloads",
      names: ["奥本海默 (2023)"],
      expectedPaths: ["/本地存储/Downloads/奥本海默 (2023)"]
    },
    confirmation: { source: "duplicate", selectedItems: ["duplicate"], target: "duplicate" }
  });

  assert.deepEqual(compact, {
    ok: true,
    mode: "preview",
    nextAction: "confirm_before_copy",
    source: { dir: "/百度网盘/影视库", found: ["奥本海默 (2023)"], missing: [] },
    destination: { dir: "/本地存储/Downloads", exists: true, created: false, conflicts: [] },
    items: ["奥本海默 (2023)"],
    targetPaths: ["/本地存储/Downloads/奥本海默 (2023)"]
  });
});

test("pollCopyCompletion returns an active task after one API request", async () => {
  const calls = [];
  const result = await pollCopyCompletion({
    baseUrl: "http://openlist.test",
    token: "token",
    taskId: "active-1",
    timeoutMs: 100,
    fetchImpl: async (url) => {
      const endpoint = new URL(url).pathname;
      calls.push(endpoint);
      if (endpoint === "/api/task/copy/undone") {
        return jsonResponse({
          code: 200, message: "success",
          data: [{ id: "active-1", name: "copy Example", status: "uploading", progress: 42 }]
        });
      }
      throw new Error("done bucket should not be queried for an active task");
    }
  });

  assert.equal(result.status, "ACTIVE");
  assert.equal(result.taskId, "active-1");
  assert.deepEqual(calls, ["/api/task/copy/undone"]);
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


test("runOpenListCopy previews a missing destination without creating it", async () => {
  const calls = [];
  const result = await runOpenListCopy({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "token" },
    args: {
      srcDir: "/阿里云盘/影视库",
      dstDir: "/本地存储/__NAS_RESOURCE_MANAGER_TEST__",
      names: ["猫和老鼠：胡桃夹子传奇 (2007)"],
      yes: false
    },
    fetchImpl: async (url, options) => {
      const endpoint = String(url);
      calls.push(endpoint);
      if (endpoint.endsWith("/api/fs/list")) {
        const body = JSON.parse(options.body);
        if (body.path === "/阿里云盘/影视库") {
          return jsonResponse({ code: 200, message: "success", data: { content: [{ name: "猫和老鼠：胡桃夹子传奇 (2007)", is_dir: true }] } });
        }
        if (body.path === "/本地存储/__NAS_RESOURCE_MANAGER_TEST__") {
          return jsonResponse({ code: 500, message: "failed get objs: failed get dir: failed to get obj: object not found" });
        }
      }
      throw new Error(`Unexpected request: ${endpoint}`);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.destination.exists, false);
  assert.equal(result.destination.created, false);
  assert.equal(result.nextAction, "confirm_create_destination_and_copy");
  assert.equal(calls.some((endpoint) => endpoint.endsWith("/api/fs/mkdir")), false);
});
