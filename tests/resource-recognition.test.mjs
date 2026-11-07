import test from "node:test";
import assert from "node:assert/strict";

import { buildAliyunRenamePlan } from "../scripts/aliyun-save.mjs";
import { buildBaiduRenamePlan } from "../scripts/baidu-save.mjs";
import { buildRenamePlan } from "../scripts/quark-save.mjs";

import {
  buildResourceRenamePlan,
  resolveAgentRenamePlan,
  resolveResourceContext
} from "../scripts/resource-recognition.mjs";

test("resource context applies one canonical normalization and classification", () => {
  const context = resolveResourceContext({
    contextName: "A 蜘蛛侠丨崭新之日（2026）",
    shareTitle: "z丨Z🕷️X（2026）",
    resourceType: "movie",
    items: [{ name: "movie.mp4", isDir: false }]
  });
  assert.equal(context.canonicalName, "蜘蛛侠崭新之日（2026）");
  assert.equal(context.resourceType, "movie");
  assert.equal(context.classification.isSeries, false);
});

test("provider-neutral plans produce identical names for every adapter", () => {
  const selectedItems = [
    { rank: 1, name: "raw.S01E01.mkv", isDir: false },
    { rank: 2, name: "raw.S01E02.mkv", isDir: false }
  ];
  const plan = buildResourceRenamePlan({
    resourceType: "series",
    contextName: "标准剧名 第一季",
    selectedItems
  });
  assert.deepEqual(plan.map((item) => item.suggestedName), [
    "标准剧名 第一季 S01E01.mkv",
    "标准剧名 第一季 S01E02.mkv"
  ]);
  assert.deepEqual(plan.map((item) => item.itemIndex), [0, 1]);
});

test("Agent plan validation is shared and rejects duplicate or unselected ranks", () => {
  const selectedItems = [{ rank: 2, name: "old.mp4", isDir: false }];
  assert.deepEqual(
    resolveAgentRenamePlan({ selectedItems, agentRenamePlan: [{ rank: 2, name: "new.mp4" }] })
      .map((item) => item.suggestedName),
    ["new.mp4"]
  );
  assert.throws(
    () => resolveAgentRenamePlan({ selectedItems, agentRenamePlan: [{ rank: 2, name: "a" }, { rank: 2, name: "b" }] }),
    /duplicate rank/
  );
  assert.throws(
    () => resolveAgentRenamePlan({ selectedItems, agentRenamePlan: [{ rank: 3, name: "new.mp4" }] }),
    /not selected/
  );
});

test("Quark, Baidu and Aliyun adapters share the same default naming decisions", () => {
  const selectedItems = [
    { rank: 1, fid: "provider-id-1", name: "source.S01E01.mkv", isDir: false },
    { rank: 2, fid: "provider-id-2", name: "source.S01E02.mkv", isDir: false }
  ];
  const common = { resourceType: "series", contextName: "统一剧名 第一季", selectedItems };
  const quark = buildRenamePlan({ ...common, savedFids: ["q1", "q2"] });
  const baidu = buildBaiduRenamePlan({ ...common, savePath: "/目标目录" });
  const aliyun = buildAliyunRenamePlan(common);
  const names = (plan) => plan.map((item) => item.suggestedName);
  assert.deepEqual(names(quark), names(baidu));
  assert.deepEqual(names(baidu), names(aliyun));
});
