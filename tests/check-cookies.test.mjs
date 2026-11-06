import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCookieCheckError,
  formatCookieCheckResult,
  parseArgs,
  validateCookieConfig
} from "../scripts/check-cookies.mjs";

test("parseArgs defaults to checking Quark and Baidu cookies", () => {
  const args = parseArgs([]);

  assert.deepEqual(args.providers, ["aliyun", "quark", "baidu"]);
  assert.equal(args.envFile, ".env");
  assert.equal(args.format, "json");
});

test("parseArgs supports dotenv alias for npm-run-safe env file selection", () => {
  const args = parseArgs(["--dotenv", "/tmp/custom.env", "--provider", "baidu"]);

  assert.equal(args.envFile, "/tmp/custom.env");
  assert.deepEqual(args.providers, ["baidu"]);
});

test("validateCookieConfig reports missing cookies without making network calls", async () => {
  let fetchCalled = false;
  const result = await validateCookieConfig(
    { QUARK_COOKIE: "", BAIDU_COOKIE: "" },
    {
      fetchImpl: async () => {
        fetchCalled = true;
      }
    }
  );

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.nextAction, "configure_missing_cookies");
  assert.deepEqual(result.recommendations, ["填写 ALIYUN_REFRESH_TOKEN。", "填写 QUARK_COOKIE。", "填写 BAIDU_COOKIE。"]);
  assert.deepEqual(result.results.map((item) => item.state), ["missing", "missing", "missing"]);
});

test("validateCookieConfig checks Quark and Baidu with injected fetch", async () => {
  const seenUrls = [];
  const result = await validateCookieConfig(
    {
      QUARK_COOKIE: "quark-cookie",
      BAIDU_COOKIE: "baidu-cookie"
    },
    {
      providers: ["quark", "baidu"],
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        if (String(url).includes("drive-pc.quark.cn")) {
          return jsonResponse({ code: 0, data: { list: [] } });
        }
        return jsonResponse({ errno: 0, username: "tester" });
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.nextAction, "ready");
  assert.equal(result.results[0].provider, "quark");
  assert.equal(result.results[0].state, "valid");
  assert.equal(result.results[1].provider, "baidu");
  assert.equal(result.results[1].state, "valid");
  assert.equal(result.results[0].cookieConfigured, true);
  assert.equal(seenUrls.length, 2);
});

test("validateCookieConfig is ready when one default provider is valid", async () => {
  const result = await validateCookieConfig(
    { BAIDU_COOKIE: "baidu-cookie" },
    {
      fetchImpl: async () => jsonResponse({ errno: 0, username: "tester" })
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.nextAction, "ready");
  assert.deepEqual(result.validProviders, ["baidu"]);
  assert.equal(result.results.find((item) => item.provider === "quark").state, "missing");
});

test("validateCookieConfig still requires an explicitly requested provider", async () => {
  const result = await validateCookieConfig(
    { BAIDU_COOKIE: "baidu-cookie" },
    {
      providers: ["quark"],
      fetchImpl: async () => jsonResponse({ code: 0 })
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.nextAction, "configure_missing_cookies");
});

test("validateCookieConfig marks Baidu errno errors as invalid", async () => {
  const result = await validateCookieConfig(
    { BAIDU_COOKIE: "bad-cookie" },
    {
      providers: ["baidu"],
      fetchImpl: async () => jsonResponse({ errno: -6, errmsg: "user is not login" })
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.nextAction, "refresh_invalid_cookies");
  assert.equal(result.results[0].state, "invalid");
  assert.match(result.results[0].message, /重新复制百度网盘 Cookie/);
});

test("validateCookieConfig gives stable agent fields for network failures", async () => {
  const result = await validateCookieConfig(
    { QUARK_COOKIE: "quark-cookie" },
    {
      providers: ["quark"],
      fetchImpl: async () => {
        throw new Error("fetch failed");
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.nextAction, "retry_network_or_check_access");
  assert.equal(result.results[0].state, "network_error");
  assert.equal(result.results[0].cookieConfigured, true);
  assert.equal(result.results[0].cookieRaw, undefined);
});


test("validateCookieConfig validates Aliyun refresh token and never exposes it", async () => {
  const result = await validateCookieConfig(
    { ALIYUN_REFRESH_TOKEN: "aliyun-refresh-token" },
    {
      providers: ["aliyun"],
      aliyunStateFile: "/tmp/aliyun-check-cookies-test/auth.json",
      fetchImpl: async (url) => {
        assert.equal(new URL(String(url)).pathname, "/v2/account/token");
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "rotated-refresh-token",
          default_drive_id: "drive-1",
          nick_name: "tester"
        });
      }
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.validProviders, ["aliyun"]);
  assert.equal(result.results[0].state, "valid");
  assert.equal(result.results[0].account, "tester");
  assert.equal(result.results[0].cookieRaw, undefined);
  assert.doesNotMatch(JSON.stringify(result), /aliyun-refresh-token|rotated-refresh-token/);
});

test("classifyCookieCheckError marks expired Aliyun refresh tokens as invalid", () => {
  const classified = classifyCookieCheckError(new Error("阿里云盘登录态验证失败：RefreshTokenExpired"));
  assert.equal(classified.state, "invalid");
  assert.match(classified.message, /更新 ALIYUN_REFRESH_TOKEN/);
});

test("classifyCookieCheckError distinguishes network failures", () => {
  const classified = classifyCookieCheckError(new Error("fetch failed"));

  assert.equal(classified.state, "network_error");
  assert.match(classified.message, /网络请求失败/);
});

test("formatCookieCheckResult does not print raw cookies", () => {
  const text = formatCookieCheckResult({
    ok: false,
    results: [
      {
        provider: "quark",
        label: "夸克网盘",
        state: "invalid",
        ok: false,
        message: "Cookie 无效",
        cookiePreview: "secret-c...1234"
      }
    ]
  });

  assert.match(text, /夸克网盘/);
  assert.match(text, /secret-c\.\.\.1234/);
  assert.doesNotMatch(text, /secret-cookie-value/);
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
