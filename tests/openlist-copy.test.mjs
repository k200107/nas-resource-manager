import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  runOpenListCopy,
  listOpenListMounts
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
  assert.equal(calls.filter((url) => url.endsWith("/api/task/copy/undone")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/api/task/copy/done")).length, 1);
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


test("listOpenListMounts returns mount names and configured destinations in one request", async () => {
  let calls = 0;
  const result = await listOpenListMounts({
    env: {
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_TOKEN: "token",
      OPENLIST_STAGING_PATH: "/本地存储/Downloads",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/本地存储"
    },
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(String(url), "http://openlist.test/api/fs/list");
      assert.equal(JSON.parse(options.body).path, "/");
      return jsonResponse({
        code: 200, message: "success",
        data: { content: [
          { name: "百度网盘", is_dir: true },
          { name: "本地存储", is_dir: true },
          { name: "说明.txt", is_dir: false }
        ] }
      });
    }
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.mounts, ["百度网盘", "本地存储"]);
  assert.equal(result.stagingPath, "/本地存储/Downloads");
});

test("runOpenListCopy corrects a selected folder mistakenly supplied as its own source parent", async () => {
  const calls = [];
  const result = await runOpenListCopy({
    env: { OPENLIST_BASE_URL: "http://openlist.test", OPENLIST_TOKEN: "token" },
    args: {
      srcDir: "/百度网盘/影视库/可能的爱",
      dstDir: "/本地存储/Downloads",
      names: ["可能的爱"],
      yes: false
    },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.path);
      if (body.path === "/百度网盘/影视库/可能的爱") {
        return jsonResponse({ code: 200, message: "success", data: { content: [{ name: "电影.mkv", is_dir: false }] } });
      }
      if (body.path === "/百度网盘/影视库") {
        return jsonResponse({ code: 200, message: "success", data: { content: [{ name: "可能的爱", is_dir: true }] } });
      }
      if (body.path === "/本地存储/Downloads") {
        return jsonResponse({ code: 200, message: "success", data: { content: [] } });
      }
      throw new Error("Unexpected path " + body.path);
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.copyPlan.srcDir, "/百度网盘/影视库");
  assert.deepEqual(result.copyPlan.names, ["可能的爱"]);
  assert.deepEqual(result.sourcePathCorrection, {
    supplied: "/百度网盘/影视库/可能的爱",
    corrected: "/百度网盘/影视库",
    itemName: "可能的爱"
  });
  assert.equal(calls.length, 3);
});
