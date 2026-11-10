import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOUD_PROVIDER_PRIORITY,
  interleaveByProviderPriority,
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

test("interleaving keeps every provider reachable after truncation", () => {
  const links = [
    { diskType: "aliyun", id: "a1" },
    { diskType: "aliyun", id: "a2" },
    { diskType: "aliyun", id: "a3" },
    { diskType: "quark", id: "q1" },
    { diskType: "baidu", id: "b1" }
  ];
  const interleaved = interleaveByProviderPriority(links);

  assert.deepEqual(interleaved.map((item) => item.id), ["a1", "q1", "b1", "a2", "a3"]);
  assert.equal(new Set(interleaved.slice(0, 3).map((item) => item.diskType)).size, 3);
});

test("interleaving preserves order inside each provider and puts unknown providers last", () => {
  const links = [
    { diskType: "others", id: "x1" },
    { diskType: "quark", id: "q1" },
    { diskType: "quark", id: "q2" },
    { diskType: "aliyun", id: "a1" }
  ];

  assert.deepEqual(interleaveByProviderPriority(links).map((item) => item.id), ["a1", "q1", "q2", "x1"]);
  assert.deepEqual(interleaveByProviderPriority([]), []);
});
