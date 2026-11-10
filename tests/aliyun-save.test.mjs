import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildAliyunRenamePlan,
  buildAliyunSubagentPreview,
  parseAliyunShareUrl,
  parseArgs,
  prepareAliyunSave,
  saveAliyunSelectedItems
} from "../scripts/aliyun-save.mjs";

test("parseArgs supports dry-run, confirmation and rename options", () => {
  const args = parseArgs([
    "https://www.alipan.com/s/share-id",
    "/Downloads",
    "--dry-run",
    "--format",
    "json",
    "--rename-plan-json",
    '[{"rank":1,"name":"修正名称.mp4"}]'
  ]);
  assert.equal(args.shareUrl, "https://www.alipan.com/s/share-id");
  assert.equal(args.targetPath, "/Downloads");
  assert.equal(args.dryRun, true);
  assert.equal(args.yes, false);
  assert.equal(args.agentRenamePlan[0].name, "修正名称.mp4");
  assert.equal(parseArgs(["url", "/Downloads", "--no-rename"]).noRename, true);
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

test("buildAliyunRenamePlan creates movie and series naming plans", () => {
  const moviePlan = buildAliyunRenamePlan({
    contextName: "猫和老鼠：胡桃夹子传奇 (2007)",
    selectedItems: [{ fid: "f1", rank: 1, name: "video.mp4", isDir: false }]
  });
  assert.equal(moviePlan.length, 1);
  assert.equal(moviePlan[0].suggestedName, "猫和老鼠：胡桃夹子传奇 (2007).mp4");
  assert.equal(moviePlan[0].sourceFid, "f1");

  const seriesPlan = buildAliyunRenamePlan({
    resourceType: "series",
    contextName: "测试剧集",
    selectedItems: [
      { fid: "f2", rank: 1, name: "EP1.mkv", isDir: false },
      { fid: "f3", rank: 2, name: "EP2.mkv", isDir: false }
    ]
  });
  assert.deepEqual(seriesPlan.map((item) => item.suggestedName), ["测试剧集 E01.mkv", "测试剧集 E02.mkv"]);
});

test("buildAliyunRenamePlan renames a selected noisy folder using canonical search title", () => {
  const plan = buildAliyunRenamePlan({
    resourceType: "movie",
    contextName: "奥德赛 (2026)",
    selectedItems: [{ fid: "folder-1", rank: 1, name: "奥z德z赛 (2026) 1080P", isDir: true }]
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].originalName, "奥z德z赛 (2026) 1080P");
  assert.equal(plan[0].suggestedName, "奥德赛 (2026)");
  assert.equal(plan[0].sourceFid, "folder-1");
});

test("Agent rename plan is validated and no-rename disables it", () => {
  const selectedItems = [{ fid: "f1", rank: 2, name: "old.mp4", isDir: false }];
  const plan = buildAliyunRenamePlan({
    selectedItems,
    agentRenamePlan: [{ rank: 2, name: "new.mp4", reason: "Agent 核验" }]
  });
  assert.equal(plan[0].suggestedName, "new.mp4");
  assert.equal(plan[0].reason, "Agent 核验");
  assert.deepEqual(buildAliyunRenamePlan({ selectedItems, agentRenamePlan: [{ rank: 2, name: "new.mp4" }], noRename: true }), []);
  assert.throws(() => buildAliyunRenamePlan({ selectedItems, agentRenamePlan: [{ rank: 3, name: "new.mp4" }] }), /not selected/);
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
      return jsonResponse({ responses: [{ id: "source-1", status: 201, body: { file_id: "saved-1" } }] });
    }
    if (endpoint === "/adrive/v3/file/update") {
      assert.equal(body.drive_id, "drive-1");
      assert.equal(body.file_id, "saved-1");
      assert.equal(body.name, "测试资源.mp4");
      assert.equal(body.check_name_mode, "refuse");
      return jsonResponse({ file_id: "saved-1", name: body.name });
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
    assert.equal(result.renamePlan[0].suggestedName, "测试资源.mp4");

    const preview = buildAliyunSubagentPreview({ args: { selection: "all" }, result });
    assert.equal(preview.renamePlan.length, 1);
    assert.equal(preview.confirmation.finalNaming[0].suggestedName, "测试资源.mp4");

    const saved = await saveAliyunSelectedItems({ result, selectedItems: result.selectedItems });
    assert.equal(saved.ok, true);
    assert.equal(saved.transferOk, true);
    assert.equal(saved.renameOk, true);
    assert.equal(saved.savedCount, 1);
    assert.equal(saved.renameResults[0].fileId, "saved-1");
    assert.ok(calls.some((call) => call.endpoint === "/adrive/v2/batch"));
    assert.ok(calls.some((call) => call.endpoint === "/adrive/v3/file/update"));
    const stored = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(stored.refresh_token, "rotated-refresh-token");
    assert.equal(typeof stored.source_fingerprint, "string");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("saveAliyunSelectedItems never renames when copy response has no destination file id", async () => {
  const calls = [];
  const result = {
    shareId: "share-id",
    targetFolderId: "folder-1",
    driveId: "drive-1",
    accessToken: "access-token",
    shareToken: "share-token",
    fetchImpl: async (url) => {
      const endpoint = new URL(String(url)).pathname;
      calls.push(endpoint);
      if (endpoint === "/adrive/v2/batch") {
        return jsonResponse({ responses: [{ id: "source-1", status: 202, body: {} }] });
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    }
  };
  const saved = await saveAliyunSelectedItems({
    result,
    selectedItems: [{ fid: "source-1" }],
    renamePlan: [{ sourceFid: "source-1", originalName: "old.mp4", suggestedName: "new.mp4" }]
  });
  assert.equal(saved.transferOk, true);
  assert.equal(saved.renameOk, false);
  assert.match(saved.renameResults[0].error, /目标文件 ID/);
  assert.equal(calls.includes("/adrive/v3/file/update"), false);
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
