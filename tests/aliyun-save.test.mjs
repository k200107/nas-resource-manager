import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseAliyunShareUrl,
  parseArgs,
  prepareAliyunSave,
  saveAliyunSelectedItems
} from "../scripts/aliyun-save.mjs";

test("parseArgs supports dry-run and explicit confirmation flags", () => {
  const args = parseArgs(["https://www.alipan.com/s/share-id", "/Downloads", "--dry-run", "--format", "json"]);
  assert.equal(args.shareUrl, "https://www.alipan.com/s/share-id");
  assert.equal(args.targetPath, "/Downloads");
  assert.equal(args.dryRun, true);
  assert.equal(args.yes, false);
  assert.equal(args.format, "json");
});

test("parseAliyunShareUrl extracts share id and password", () => {
  assert.deepEqual(
    parseAliyunShareUrl("https://www.alipan.com/s/share-id?pwd=1234"),
    { shareId: "share-id", passcode: "1234" }
  );
  assert.deepEqual(
    parseAliyunShareUrl("https://www.aliyundrive.com/s/another-id"),
    { shareId: "another-id", passcode: "" }
  );
  assert.throws(() => parseAliyunShareUrl("https://pan.baidu.com/s/not-aliyun"), /不是阿里云盘/);
});

test("prepareAliyunSave uses mocked token, share, list and destination APIs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aliyun-save-test-"));
  const stateFile = path.join(root, "auth.json");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ endpoint, body, headers: options.headers || {} });
    if (endpoint === "/v2/account/token") {
      return jsonResponse({ access_token: "access-token", refresh_token: "rotated-refresh-token", default_drive_id: "drive-1" });
    }
    if (endpoint === "/adrive/v2/share_link/get_share_by_anonymous") {
      return jsonResponse({ share_id: "share-id", share_name: "测试资源" });
    }
    if (endpoint === "/v2/share_link/get_share_token") {
      assert.equal(body.share_pwd, "1234");
      return jsonResponse({ share_token: "share-token" });
    }
    if (endpoint === "/adrive/v2/file/list_by_share") {
      assert.equal(options.headers["x-share-token"], "share-token");
      return jsonResponse({ items: [{ file_id: "source-1", name: "视频.mp4", type: "file", size: 100 }], next_marker: "" });
    }
    if (endpoint === "/adrive/v3/file/list") {
      assert.equal(options.headers.Authorization, "Bearer access-token");
      return jsonResponse({ items: [{ file_id: "folder-1", name: "Downloads", type: "folder" }], next_marker: "" });
    }
    if (endpoint === "/adrive/v2/batch") {
      assert.equal(options.headers.Authorization, "Bearer access-token");
      assert.equal(options.headers["x-share-token"], "share-token");
      return jsonResponse({ responses: [{ id: "source-1", status: 202, body: { file_id: "saved-1" } }] });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  try {
    const result = await prepareAliyunSave({
      shareUrl: "https://www.alipan.com/s/share-id?pwd=1234",
      targetPath: "/Downloads",
      refreshToken: "configured-refresh-token",
      stateFile,
      fetchImpl
    });
    assert.equal(result.provider, "aliyun");
    assert.equal(result.targetFolderId, "folder-1");
    assert.equal(result.selectedItems[0].fid, "source-1");
    const saved = await saveAliyunSelectedItems({ result, selectedItems: result.selectedItems });
    assert.equal(saved.ok, true);
    assert.equal(saved.savedCount, 1);
    assert.ok(calls.some((call) => call.endpoint === "/adrive/v2/batch"));
    const stored = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(stored.refresh_token, "rotated-refresh-token");
    assert.equal(typeof stored.source_fingerprint, "string");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
