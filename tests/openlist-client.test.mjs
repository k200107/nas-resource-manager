import test from "node:test";
import assert from "node:assert/strict";
import {
  isOpenListSuccess,
  normalizeOpenListBaseUrl,
  requestOpenListJson
} from "../scripts/openlist-client.mjs";

test("normalizes OpenList base URLs without changing their scheme or path", () => {
  assert.equal(normalizeOpenListBaseUrl(" http://nas.local:5244/// "), "http://nas.local:5244");
});

test("sends authenticated JSON requests and parses OpenList responses", async () => {
  let requested;
  const result = await requestOpenListJson({
    baseUrl: "http://openlist.local/",
    token: "test-token",
    endpoint: "/api/fs/list",
    body: { path: "/Downloads", page: 1 },
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, message: "success", data: [] }) };
    }
  });

  assert.equal(requested.url, "http://openlist.local/api/fs/list");
  assert.equal(requested.options.headers.Authorization, "test-token");
  assert.equal(requested.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requested.options.body), { path: "/Downloads", page: 1 });
  assert.equal(result.ok, true);
  assert.equal(isOpenListSuccess(result.json), true);
});

test("preserves binary request bodies and caller-provided headers", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let requested;
  await requestOpenListJson({
    baseUrl: "http://openlist.local",
    token: "test-token",
    endpoint: "/api/fs/put",
    method: "PUT",
    body: bytes,
    headers: { "Content-Type": "application/octet-stream", "File-Path": "/test.bin" },
    fetchImpl: async (_url, options) => {
      requested = options;
      return { ok: true, status: 200, text: async () => '{"code":200,"message":"success"}' };
    }
  });
  assert.equal(requested.body, bytes);
  assert.equal(requested.headers["Content-Type"], "application/octet-stream");
  assert.equal(requested.headers["File-Path"], "/test.bin");
});

test("rejects malformed JSON and invalid endpoints", async () => {
  await assert.rejects(
    requestOpenListJson({
      baseUrl: "http://openlist.local", token: "x", endpoint: "/api/fs/list",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>bad</html>" })
    }),
    /返回非 JSON/
  );
  await assert.rejects(
    requestOpenListJson({ baseUrl: "http://openlist.local", token: "x", endpoint: "api/fs/list" }),
    /endpoint 必须以 \/ 开头/
  );
});
