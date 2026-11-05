/**
 * Shared OpenList HTTP/JSON transport.
 *
 * Owns authentication headers, URL normalization, timeout handling, and JSON parsing.
 * Feature modules remain responsible for endpoint semantics and authorization.
 */
export const DEFAULT_OPENLIST_TIMEOUT_MS = 20_000;

export function normalizeOpenListBaseUrl(value) {
  return String(value || "").trim().replace(/\\/+$/g, "");
}

export function isOpenListSuccess(json) {
  return json?.code === 200 || json?.code === 0 || json?.message === "success";
}

/** body may be a serialized JSON string, a JSON object, or binary data. */
export async function requestOpenListJson({
  baseUrl, token, endpoint, method = "POST", body, headers = {},
  fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_OPENLIST_TIMEOUT_MS,
  errorLabel = "OpenList"
}) {
  const normalizedBaseUrl = normalizeOpenListBaseUrl(baseUrl);
  if (!normalizedBaseUrl || !token) throw new Error("OPENLIST_BASE_URL 或 OPENLIST_TOKEN 缺失。");
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境没有 fetch，请升级到 Node.js 20 或更新版本。");
  if (!String(endpoint || "").startsWith("/")) throw new Error("OpenList endpoint 必须以 / 开头。");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_OPENLIST_TIMEOUT_MS);
  try {
    const requestHeaders = { Accept: "application/json", Authorization: token, ...headers };
    const hasBody = body !== undefined && body !== null;
    let requestBody = body;
    const customContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
    if (hasBody && typeof body !== "string" && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
      requestBody = JSON.stringify(body);
      if (!customContentType) requestHeaders["Content-Type"] = "application/json";
    } else if (hasBody && typeof body === "string" && !customContentType) {
      requestHeaders["Content-Type"] = "application/json";
    }
    const response = await fetchImpl(normalizedBaseUrl + endpoint, {
      method, headers: requestHeaders, ...(hasBody ? { body: requestBody } : {}), signal: controller.signal
    });
    const raw = await response.text();
    let json;
    try { json = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(errorLabel + " " + endpoint + " 返回非 JSON：" + raw.slice(0, 160)); }
    return { ok: Boolean(response.ok), status: response.status, json, text: raw };
  } finally {
    clearTimeout(timer);
  }
}
