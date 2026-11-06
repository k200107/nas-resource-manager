import test from "node:test";
import assert from "node:assert/strict";

import { classifyResource as quarkClassify, parseSelection as quarkSelection } from "../scripts/quark-save.mjs";
import { parseBaiduShareUrl } from "../scripts/baidu-save.mjs";
import { parseAliyunShareUrl } from "../scripts/aliyun-save.mjs";

test("provider modules remain import-safe and retain their public compatibility exports", () => {
  assert.equal(quarkClassify({resourceType:"series"}).type, "series");
  assert.deepEqual(quarkSelection("1", [{rank:1}]), [{rank:1}]);
  assert.equal(parseBaiduShareUrl("https://pan.baidu.com/s/1abc").verifySurl, "abc");
  assert.equal(parseAliyunShareUrl("https://www.alipan.com/s/aliyun-id").shareId, "aliyun-id");
});
