import test from "node:test";
import assert from "node:assert/strict";

import { formatSearchResult } from "../scripts/search-rrdynb.mjs";

test("compact search JSON keeps selection fields and omits diagnostic metadata", () => {
  const output = formatSearchResult({
    ok: true,
    inputTitle: "奥本海默",
    selectedQuery: "奥本海默",
    availableTotal: 124,
    returnedCount: 2,
    providerCounts: { baidu: 1, aliyun: 1 },
    candidateTotal: 57,
    providerAvailable: { aliyun: 9, quark: 41, baidu: 7 },
    dedupeRemoved: 21,
    downloadLinks: [
      {
        rank: 1,
        note: "奥本海默 (2023) 4K REMUX",
        provider: "百度网盘",
        url: "https://pan.baidu.com/s/1example",
        extractionCode: "Yu66",
        source: "tg:example",
        datetime: "0001-01-01T00:00:00Z"
      }
    ]
  }, "json", true);

  const parsed = JSON.parse(output);
  assert.equal(parsed.total, 124);
  assert.deepEqual(parsed.providerAvailable, { aliyun: 9, quark: 41, baidu: 7 });
  assert.deepEqual(parsed.results[0], {
    rank: 1,
    title: "奥本海默 (2023) 4K REMUX",
    provider: "百度网盘",
    url: "https://pan.baidu.com/s/1example",
    password: "Yu66"
  });
  assert.equal("candidateTotal" in parsed, false);
  assert.equal("dedupeRemoved" in parsed, false);
  assert.equal("providerCounts" in parsed, false);
  assert.equal("source" in parsed.results[0], false);
  assert.equal("updatedAt" in parsed.results[0], false);
  assert.equal(output.includes(": "), false);
});
