import test from "node:test";
import assert from "node:assert/strict";

import { buildAliyunCompactPreview, buildAliyunCompactSave, parseArgs as parseAliyunArgs } from "../scripts/aliyun-save.mjs";
import { buildQuarkCompactPreview, buildQuarkCompactSave, parseArgs as parseQuarkArgs } from "../scripts/quark-save.mjs";
import { buildBaiduCompactPreview, buildBaiduCompactSave, parseArgs as parseBaiduArgs } from "../scripts/baidu-save.mjs";

test("all provider CLIs accept --compact", () => {
  assert.equal(parseAliyunArgs(["https://www.alipan.com/s/x", "/影视库", "--compact"]).compact, true);
  assert.equal(parseQuarkArgs(["https://pan.quark.cn/s/x", "/影视库", "--compact"]).compact, true);
  assert.equal(parseBaiduArgs(["https://pan.baidu.com/s/x", "/影视库", "--compact"]).compact, true);
});

test("Aliyun compact preview removes duplicated confirmation and candidate payloads", () => {
  const compact = buildAliyunCompactPreview({
    ok: true, provider: "aliyun", mode: "preview", nextAction: "confirm_before_save",
    source: { shareUrl: "https://alipan.com/s/x" },
    target: { pathOrUrl: "/影视库" },
    resource: { canonicalName: "蜘蛛侠", type: "movie" },
    selection: { selectedItems: [{ rank: 1, fid: "f1", name: "蜘蛛侠.mkv", isDir: false, size: 100 }] },
    renamePlan: [{ rank: 1, originalName: "raw.mkv", suggestedName: "蜘蛛侠.mkv", reason: "normalization" }],
    confirmation: { selectedItems: [{ name: "duplicated" }] }
  });
  assert.equal(compact.selectedItems[0].id, "f1");
  assert.equal(compact.renamePlan[0].suggestedName, "蜘蛛侠.mkv");
  assert.equal("confirmation" in compact, false);
  assert.equal("items" in compact, false);
});

test("Aliyun compact save does not call HTTP 202 terminal success", () => {
  const compact = buildAliyunCompactSave({
    ok: true, transferOk: true, source: "share", target: "/影视库",
    savedCount: 1, results: [{ status: 202 }], renameResults: []
  });
  assert.equal(compact.status, "ACTIVE");
});

test("Quark compact preview keeps selected resource and omits repeated payloads", () => {
  const item = { rank: 1, fid: "q1", name: "剧集 S01E01.mkv", isDir: false, size: 10 };
  const compact = buildQuarkCompactPreview({
    args: { shareUrl: "share", toUrl: "/影视库" },
    result: { contextName: "剧集", classification: { type: "series" }, selectedPreview: [item], items: [item], renamePlan: [] }
  });
  assert.equal(compact.selectedItems[0].id, "q1");
  assert.equal("confirmation" in compact, false);
  assert.equal("items" in compact, false);
});

test("Quark compact save returns task ID and terminal status only", () => {
  const compact = buildQuarkCompactSave({
    args: { shareUrl: "share", toUrl: "/影视库" },
    saveResult: { taskId: "task-1", selectedItems: [{ fid: "q1" }], renameResults: [] }
  });
  assert.equal(compact.status, "SUCCEEDED");
  assert.equal(compact.taskId, "task-1");
  assert.equal("savedFids" in compact, false);
});

test("Baidu compact preview keeps exact selected item and rename target", () => {
  const item = { rank: 1, fsId: 123, name: "电影.mkv", isDir: false, size: 10 };
  const compact = buildBaiduCompactPreview({
    args: { shareUrl: "share", savePath: "/影视库" },
    result: { savePath: "/影视库", contextName: "电影", classification: { type: "movie" }, selectedPreview: [item], items: [item], renamePlan: [] }
  });
  assert.equal(compact.selectedItems[0].id, 123);
  assert.equal(compact.target, "/影视库");
  assert.equal("confirmation" in compact, false);
});

test("Baidu compact save preserves asynchronous submission state", () => {
  const compact = buildBaiduCompactSave({
    args: { shareUrl: "share" }, result: { savePath: "/影视库" },
    saveResult: { transferResponse: { errno: 0, task_id: "bd-task" }, selectedItems: [{ fsId: 123 }], renameResults: [] }
  });
  assert.equal(compact.status, "SUBMITTED");
  assert.equal(compact.taskId, "bd-task");
});
