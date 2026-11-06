import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOUD_PROVIDER_PRIORITY,
  orderAvailableProviders,
  providerPriority,
  resolveProviderForShareUrl,
  sortCloudLinksByPriority
} from "../scripts/provider-priority.mjs";

test("default provider priority is Aliyun, Quark, then Baidu", () => {
  assert.deepEqual(CLOUD_PROVIDER_PRIORITY, ["aliyun", "quark", "baidu"]);
  assert.deepEqual(orderAvailableProviders(["baidu", "quark", "aliyun"]), ["aliyun", "quark", "baidu"]);
});

test("provider ordering is stable within each provider and leaves unknown providers last", () => {
  const links = [
    { diskType: "baidu", id: "b1" },
    { diskType: "quark", id: "q1" },
    { diskType: "aliyun", id: "a1" },
    { diskType: "quark", id: "q2" },
    { diskType: "others", id: "x1" }
  ];
  assert.deepEqual(sortCloudLinksByPriority(links).map((item) => item.id), ["a1", "q1", "q2", "b1", "x1"]);
  assert.equal(providerPriority("others"), Number.MAX_SAFE_INTEGER);
});

test("an explicit provider or provider URL is never silently switched", () => {
  assert.equal(resolveProviderForShareUrl("https://pan.baidu.com/s/abc"), "baidu");
  assert.equal(resolveProviderForShareUrl("https://www.alipan.com/s/abc"), "aliyun");
  assert.equal(resolveProviderForShareUrl("https://pan.quark.cn/s/abc", "quark"), "quark");
  assert.equal(resolveProviderForShareUrl("https://pan.baidu.com/s/abc", "baidu"), "baidu");
  assert.equal(resolveProviderForShareUrl("https://example.com/share"), "");
});
