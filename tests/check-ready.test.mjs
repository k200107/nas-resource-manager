import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  validateReadyConfig
} from "../scripts/check-ready.mjs";

test("parseArgs defaults to agent JSON output", () => {
  const args = parseArgs([]);

  assert.equal(args.envFile, ".env");
  assert.equal(args.format, "json");
});

test("validateReadyConfig passes with Baidu-only provider and OpenList target", async () => {
  const result = await validateReadyConfig(
    {
      BAIDU_COOKIE: "baidu-cookie",
      BAIDU_DEFAULT_SAVE_PATH: "/NAS资源下载",
      OPENLIST_TOKEN: "openlist-token",
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
    },
    {
      fetchImpl: async (url) => {
        const text = String(url);
        if (text.includes("/xpan/nas")) return jsonResponse({ errno: 0, username: "tester" });
        if (text.includes("/api/gettemplatevariable")) return jsonResponse({ result: { bdstoken: "bdstoken" } });
        if (text.includes("/api/list")) return jsonResponse({ errno: 0, list: [{ fs_id: 1, server_filename: "NAS资源下载", isdir: 1 }] });
        if (text.includes("/api/fs/list")) return jsonResponse({ code: 200, message: "success", data: { content: [] } });
        throw new Error(`Unexpected URL: ${text}`);
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.nextAction, "ready");
  assert.deepEqual(result.validProviders, ["baidu"]);
  assert.equal(result.openList.ok, true);
  assert.equal(result.providerTargets[0].targetPath, "/NAS资源下载");
});

test("validateReadyConfig passes with Quark path target when it can be resolved", async () => {
  const result = await validateReadyConfig(
    {
      QUARK_COOKIE: "quark-cookie",
      QUARK_DEFAULT_SAVE_URL: "/备份资源",
      OPENLIST_TOKEN: "openlist-token",
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
    },
    {
      fetchImpl: async (url) => {
        const text = String(url);
        if (text.includes("drive-pc.quark.cn") && text.includes("pdir_fid=0")) {
          return jsonResponse({ code: 0, data: { list: [{ fid: "backup-fid", file_name: "备份资源", dir: true }] } });
        }
        if (text.includes("/api/fs/list")) return jsonResponse({ code: 200, message: "success", data: { content: [] } });
        throw new Error(`Unexpected URL: ${text}`);
      }
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.validProviders, ["quark"]);
  assert.equal(result.providerTargets[0].fid, "backup-fid");
});


test("validateReadyConfig passes with Aliyun-only provider and existing save folder", async () => {
  const result = await validateReadyConfig(
    {
      ALIYUN_REFRESH_TOKEN: "aliyun-refresh-token",
      ALIYUN_DEFAULT_SAVE_PATH: "/Downloads",
      OPENLIST_TOKEN: "openlist-token",
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
    },
    {
      aliyunStateFile: "/tmp/aliyun-check-ready-test/auth.json",
      fetchImpl: async (url) => {
        const text = String(url);
        if (text.includes("/v2/account/token")) {
          return jsonResponse({ access_token: "access-token", refresh_token: "rotated", default_drive_id: "drive-1" });
        }
        if (text.includes("/adrive/v3/file/list")) {
          return jsonResponse({ items: [{ file_id: "downloads-id", name: "Downloads", type: "folder" }] });
        }
        if (text.includes("/api/fs/list")) {
          return jsonResponse({ code: 200, message: "success", data: { content: [] } });
        }
        throw new Error(`Unexpected URL: ${text}`);
      }
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.nextAction, "ready");
  assert.deepEqual(result.validProviders, ["aliyun"]);
  assert.equal(result.providerTargets[0].provider, "aliyun");
  assert.equal(result.providerTargets[0].folderId, "downloads-id");
});

test("validateReadyConfig automatically creates a missing Aliyun save folder", async () => {
  const calls = [];
  const result = await validateReadyConfig(
    {
      ALIYUN_REFRESH_TOKEN: "aliyun-refresh-token",
      ALIYUN_DEFAULT_SAVE_PATH: "/影视库",
      OPENLIST_TOKEN: "openlist-token",
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
    },
    {
      aliyunStateFile: "/tmp/aliyun-check-ready-create-test/auth.json",
      fetchImpl: async (url, options = {}) => {
        const text = String(url);
        const endpoint = new URL(text).pathname;
        const body = options.body ? JSON.parse(options.body) : {};
        calls.push({ endpoint, body });
        if (endpoint === "/v2/account/token") {
          return jsonResponse({ access_token: "access-token", refresh_token: "rotated", default_drive_id: "drive-1" });
        }
        if (endpoint === "/adrive/v3/file/list") return jsonResponse({ items: [] });
        if (endpoint === "/adrive/v2/file/createWithFolders") {
          assert.equal(body.name, "影视库");
          assert.equal(body.parent_file_id, "root");
          return jsonResponse({ file_id: "created-folder-id" });
        }
        if (endpoint === "/api/fs/list") {
          return jsonResponse({ code: 200, message: "success", data: { content: [] } });
        }
        throw new Error(`Unexpected URL: ${text}`);
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.nextAction, "ready");
  assert.equal(result.providerTargets[0].folderId, "created-folder-id");
  assert.deepEqual(result.providerTargets[0].createdDirectories, ["/影视库"]);
  assert.ok(calls.some((call) => call.endpoint === "/adrive/v2/file/createWithFolders"));
});


test("validateReadyConfig automatically creates a missing Quark save folder", async () => {
  const calls = [];
  const result = await validateReadyConfig({
    QUARK_COOKIE: "quark-cookie", QUARK_DEFAULT_SAVE_URL: "/影视库/电影",
    OPENLIST_TOKEN: "openlist-token", OPENLIST_BASE_URL: "http://openlist.test",
    OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
  }, {
    fetchImpl: async (url, options = {}) => {
      const endpoint = new URL(String(url)).pathname;
      const query = new URL(String(url)).searchParams;
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ endpoint, query, body });
      if (endpoint === "/1/clouddrive/file/sort") return jsonResponse({ code: 0, data: { list: [] } });
      if (endpoint === "/1/clouddrive/file" && options.method === "POST") return jsonResponse({ code: 0, data: { fid: "created-quark-folder" } });
      if (endpoint === "/api/fs/list") return jsonResponse({ code: 200, message: "success", data: { content: [] } });
      throw new Error(`Unexpected URL: ${url}`);
    }
  });
  assert.equal(result.providerTargets[0].ok, true);
  assert.deepEqual(result.providerTargets[0].createdDirectories, ["/影视库", "/影视库/电影"]);
  assert.equal(calls.filter((call) => call.endpoint === "/1/clouddrive/file" && call.body.file_name).length, 2);
});

test("validateReadyConfig automatically creates a missing Baidu save folder", async () => {
  const calls = [];
  const result = await validateReadyConfig({
    BAIDU_COOKIE: "baidu-cookie", BAIDU_DEFAULT_SAVE_PATH: "/影视库",
    OPENLIST_TOKEN: "openlist-token", OPENLIST_BASE_URL: "http://openlist.test",
    OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
  }, {
    fetchImpl: async (url, options = {}) => {
      const endpoint = new URL(String(url)).pathname;
      const body = options.body instanceof URLSearchParams ? Object.fromEntries(options.body.entries()) : {};
      calls.push({ endpoint, body });
      if (endpoint === "/rest/2.0/xpan/nas") return jsonResponse({ errno: 0, username: "tester" });
      if (endpoint === "/api/gettemplatevariable") return jsonResponse({ result: { bdstoken: "bdstoken" } });
      if (endpoint === "/api/list") return jsonResponse({ errno: -9, list: [] });
      if (endpoint === "/api/create") return jsonResponse({ errno: 0, info: [{ path: "/影视库" }] });
      if (endpoint === "/api/fs/list") return jsonResponse({ code: 200, message: "success", data: { content: [] } });
      throw new Error(`Unexpected URL: ${url}`);
    }
  });
  assert.equal(result.providerTargets[0].ok, true);
  assert.deepEqual(result.providerTargets[0].createdDirectories, ["/影视库"]);
  assert.ok(calls.some((call) => call.endpoint === "/api/create" && call.body.path === "/影视库"));
});
test("validateReadyConfig fails when no provider is complete", async () => {
  const result = await validateReadyConfig(
    {
      OPENLIST_TOKEN: "openlist-token",
      OPENLIST_BASE_URL: "http://openlist.test",
      OPENLIST_DEFAULT_COPY_DST_PATH: "/影视资源备份/影视"
    },
    {
      fetchImpl: async () => jsonResponse({ code: 200, message: "success", data: { content: [] } })
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.nextAction, "configure_provider");
  assert.match(result.recommendations.join("\n"), /至少配置一个完整网盘/);
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
