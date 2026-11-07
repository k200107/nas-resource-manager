#!/usr/bin/env node
import { isCliEntryPoint } from "./cli-utils.mjs";
import { sortCloudLinksByPriority } from "./provider-priority.mjs";

/**
 * 通过 PanSou API 搜索资源、规范化网盘链接并输出结果；搜索及链接检查不执行网盘转存。
 *
 * 本文件说明：函数注释描述职责和关键边界；除注释外不改变既有执行逻辑。
 * 安全约束：任何网盘/NAS 写操作都必须以明确目标和用户授权为前提；预览和查询流程保持只读。
 */

/**
 * 通过 PanSou API 搜索资源、规范化网盘链接并按指定格式输出；搜索和链接检查不执行网盘转存。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */


const DEFAULT_API_BASE = "https://so.252035.xyz/api";
const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_RESULT_TYPE = "all";
const DEFAULT_SOURCE_TYPE = "all";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CLOUD_TYPES = ["aliyun", "quark", "baidu"];

const PROVIDER_LABELS = {
  baidu: "百度网盘",
  aliyun: "阿里云盘",
  quark: "夸克网盘",
  guangya: "光鸭云盘",
  tianyi: "天翼云盘",
  uc: "UC网盘",
  mobile: "移动云盘",
  "115": "115网盘",
  pikpak: "PikPak",
  xunlei: "迅雷网盘",
  "123": "123网盘",
  magnet: "磁力链接",
  ed2k: "电驴链接",
  others: "其他"
};

const CHECKABLE_TYPES = new Set(["baidu", "aliyun", "quark", "tianyi", "uc", "mobile", "115", "xunlei", "123"]);

// 仅在直接执行脚本时启动主流程；作为模块导入时不产生网络请求或其他副作用。
  if (isCliEntryPoint(import.meta.url)) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    process.exit(1);
  });
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
/** 命令行主入口：解析参数、加载配置、调用核心流程并输出结果。 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title) {
    printUsage();
    process.exit(2);
  }

  const searchResult = await searchPanSou(args);
  if (args.checkLinks) {
    searchResult.linkChecks = await checkSearchResultLinks(args, searchResult.downloadLinks);
  }

  console.log(formatSearchResult(searchResult, args.format, args.compact));
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；未知参数会报错，避免拼写错误被静默忽略。 */
function parseArgs(argv) {
  const parsed = {
    title: "",
    apiBase: DEFAULT_API_BASE,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    resultType: DEFAULT_RESULT_TYPE,
    sourceType: DEFAULT_SOURCE_TYPE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    channels: [],
    plugins: [],
    cloudTypes: [...DEFAULT_CLOUD_TYPES],
    include: [],
    exclude: [],
    ext: null,
    filter: null,
    concurrency: null,
    refresh: false,
    checkLinks: false,
    viewToken: "",
    proxyUrl: "",
    format: "markdown",
    compact: false
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--api-base") {
      parsed.apiBase = argv[++index] || DEFAULT_API_BASE;
    } else if (arg === "--max-candidates") {
      parsed.maxCandidates = Number(argv[++index] || DEFAULT_MAX_CANDIDATES);
    } else if (arg === "--res") {
      parsed.resultType = argv[++index] || DEFAULT_RESULT_TYPE;
    } else if (arg === "--src") {
      parsed.sourceType = argv[++index] || DEFAULT_SOURCE_TYPE;
    } else if (arg === "--channels") {
      parsed.channels = parseList(argv[++index]);
    } else if (arg === "--plugins") {
      parsed.plugins = parseList(argv[++index]);
    } else if (arg === "--cloud-types") {
      parsed.cloudTypes = parseList(argv[++index]);
    } else if (arg === "--include") {
      parsed.include = parseList(argv[++index]);
    } else if (arg === "--exclude") {
      parsed.exclude = parseList(argv[++index]);
    } else if (arg === "--ext-json") {
      parsed.ext = parseJson(argv[++index], "--ext-json");
    } else if (arg === "--filter-json") {
      parsed.filter = parseJson(argv[++index], "--filter-json");
    } else if (arg === "--conc") {
      parsed.concurrency = Number(argv[++index] || 0);
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
    } else if (arg === "--refresh") {
      parsed.refresh = true;
    } else if (arg === "--check-links") {
      parsed.checkLinks = true;
    } else if (arg === "--view-token") {
      parsed.viewToken = argv[++index] || "";
    } else if (arg === "--proxy-url" || arg === "--proxy") {
      parsed.proxyUrl = argv[++index] || "";
    } else if (arg === "--format") {
      parsed.format = argv[++index] || "markdown";
    } else if (arg === "--compact") {
      parsed.compact = true;
    } else if (arg === "--json") {
      parsed.format = "json";
    } else if (arg === "--markdown") {
      parsed.format = "markdown";
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  parsed.title = positionals.join(" ").trim();
  return parsed;
}

/** 处理printUsage相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 printUsage 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function printUsage() {
  console.error("Usage: node scripts/search-rrdynb.mjs <title> [options]");
  console.error("Options:");
  console.error("  --api-base https://so.252035.xyz/api");
  console.error("  --max-candidates 50");
  console.error("  --res all|merge|results");
  console.error("  --src all|tg|plugin");
  console.error("  --channels tgsearchers4,Aliyun_4K_Movies");
  console.error("  --plugins wanou,zhizhen");
  console.error("  --cloud-types baidu,quark");
  console.error("  --include 4K,合集 --exclude 预告");
  console.error("  --refresh");
  console.error("  --check-links [--proxy-url socks5://127.0.0.1:1080]");
  console.error("  --format markdown|json");
}

/** 将formatSearchResult相关结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
function formatSearchResult(searchResult, format = "markdown", compact = false) {
  if (format === "json") return JSON.stringify(compact ? toCompactAgentResult(searchResult) : searchResult, null, 2);
  if (format === "markdown") return renderMarkdownTable(searchResult);
  throw new Error(`Unsupported format: ${format}`);
}

function toCompactAgentResult(result) {
  return {
    ok: result.ok,
    query: result.selectedQuery || result.inputTitle || "",
    total: result.availableTotal || 0,
    returnedCount: result.returnedCount || 0,
    providerCounts: result.providerCounts || {},
    results: (result.downloadLinks || []).map((link, index) => ({
      rank: index + 1,
      title: link.note || link.label || result.inputTitle || "未命名资源",
      provider: link.provider || link.diskType || "",
      url: link.url || "",
      password: link.extractionCode || "",
      source: link.source || "",
      updatedAt: link.datetime || ""
    }))
  };
}

/** 处理searchPanSou相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 searchPanSou 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
async function searchPanSou(args) {
  const apiBase = normalizeApiBase(args.apiBase);
  const params = buildSearchQueryParams(args);
  const searchUrl = `${apiBase}/search?${params.toString()}`;
  const response = await fetchJson(searchUrl, { timeoutMs: args.timeoutMs });
  const normalized = normalizePanSouSearchResponse(response, {
    title: args.title,
    selectedQuery: args.title,
    maxCandidates: args.maxCandidates,
    cloudTypes: args.cloudTypes
  });

  return {
    ...normalized,
    apiBase,
    selectedQuery: args.title,
    searchAttempts: [
      {
        query: args.title,
        searchUrl,
        availableTotal: normalized.availableTotal,
        returnedCount: normalized.returnedCount,
        candidateCount: normalized.candidates.length
      }
    ],
    output: {
      directResourceLinks: "included_when_detected",
      extractionCodes: "included_when_detected",
      linkChecks: args.checkLinks ? "included_when_requested" : "not_requested"
    }
  };
}

/** 构造SearchQueryParams所需的数据结构或执行计划；除非函数说明明确涉及执行，否则只准备数据、不提交远端变更。 */
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */
function buildSearchQueryParams(args) {
  const params = new URLSearchParams();
  params.set("kw", args.title);
  if (args.channels && args.channels.length > 0) params.set("channels", args.channels.join(","));
  if (args.plugins && args.plugins.length > 0) params.set("plugins", args.plugins.join(","));
  if (args.concurrency) params.set("conc", String(args.concurrency));
  if (args.refresh) params.set("refresh", "true");
  if (args.resultType) params.set("res", args.resultType);
  if (args.sourceType) params.set("src", args.sourceType);
  if (args.cloudTypes && args.cloudTypes.length > 0) params.set("cloud_types", args.cloudTypes.join(","));
  if (args.ext) params.set("ext", JSON.stringify(args.ext));

  const filter = args.filter || buildFilter(args.include, args.exclude);
  if (filter) params.set("filter", JSON.stringify(filter));

  return params;
}

/** 把 PanSou 原始响应整理为统一候选资源和下载链接结构。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
function normalizePanSouSearchResponse(response, options = {}) {
  const data = unwrapData(response);
  const rankedLinks = data.results && data.results.length > 0 ? flattenResultsLinks(data.results) : [];
  const mergedByType = data.merged_by_type || groupResultsByType(data.results || []);
  const rawLinks = rankedLinks.length > 0 ? rankedLinks : flattenMergedLinks(mergedByType);
  const cloudTypes = Array.isArray(options.cloudTypes) ? options.cloudTypes : DEFAULT_CLOUD_TYPES;
  const allLinks = sortCloudLinksByPriority(filterLinksByCloudTypes(rawLinks, cloudTypes));
  const limit = Number.isFinite(options.maxCandidates) ? options.maxCandidates : DEFAULT_MAX_CANDIDATES;
  const downloadLinks = allLinks.slice(0, limit).map((link, index) => normalizeDownloadLink(link, index + 1));
  const candidates = downloadLinks.map((link) => ({
    rank: link.rank,
    name: link.note || link.label || options.title || "未命名资源",
    provider: link.provider,
    diskType: link.diskType,
    datetime: link.datetime,
    source: link.source,
    matchReason: link.note ? "PanSou 结果说明包含资源标题" : "PanSou 搜索结果",
    resourceProviders: [
      {
        provider: link.provider,
        diskType: link.diskType,
        available: true,
        links: [
          {
            label: link.label,
            url: link.url,
            extractionCode: link.extractionCode,
            extractionCodes: link.extractionCodes
          }
        ],
        extractionCodes: link.extractionCodes,
        note: link.source || "PanSou API"
      }
    ],
    downloadLinks: [stripRank(link)]
  }));

  return {
    ok: true,
    inputTitle: options.title || "",
    selectedQuery: options.selectedQuery || options.title || "",
    availableTotal: Number(data.total || allLinks.length || 0),
    returnedCount: downloadLinks.length,
    total: downloadLinks.length,
    providerCounts: countBy(downloadLinks, "diskType"),
    candidates,
    downloadLinks: downloadLinks.map(stripRank)
  };
}

/** 把链接检测接口的原始响应转换为统一的检测结果结构。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
function normalizeCheckLinksResponse(response) {
  const data = unwrapData(response);
  return {
    ok: true,
    results: (data.results || []).map((item) => ({
      provider: providerLabel(item.disk_type),
      diskType: item.disk_type,
      url: item.url,
      normalizedUrl: item.normalized_url || "",
      state: item.state,
      cacheHit: Boolean(item.cache_hit),
      checkedAt: item.checked_at || null,
      expiresAt: item.expires_at || null,
      summary: item.summary || ""
    }))
  };
}

/** 将规范化结果渲染为 Markdown 表格，供终端或聊天渠道阅读。 */
/** 把规范化资源结果渲染为 Markdown 表格。 */
function renderMarkdownTable(searchResult) {
  const title = searchResult.inputTitle || searchResult.selectedQuery || "搜索结果";
  const availableTotal = Number(searchResult.availableTotal || 0);
  const returnedCount = Number(searchResult.returnedCount || searchResult.candidates?.length || 0);
  const lines = [
    `### ${escapeMarkdownText(title)} 搜索结果`,
    "",
    `按 PanSou 相关度排序，返回前 ${returnedCount} 条。上游可用结果约 ${availableTotal} 条。`,
    "",
    "| # | 资源 | 网盘 | 链接 | 提取码 | 来源 | 时间 |",
    "|---:|---|---|---|---|---|---|"
  ];

  for (const candidate of searchResult.candidates || []) {
    const link = candidate.downloadLinks?.[0] || {};
    lines.push(
      [
        candidate.rank,
        escapeMarkdownCell(candidate.name || link.note || link.label || "未命名资源"),
        escapeMarkdownCell(candidate.provider || link.provider || providerLabel(link.diskType)),
        link.url ? `[打开](${escapeMarkdownUrl(link.url)})` : "-",
        escapeMarkdownCell(link.extractionCode || "-"),
        escapeMarkdownCell(candidate.source || link.source || "-"),
        escapeMarkdownCell(formatDate(candidate.datetime || link.datetime))
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    );
  }

  if (searchResult.linkChecks) {
    lines.push("", renderLinkCheckNote(searchResult.linkChecks));
  }

  return lines.join("\n");
}

/** 将renderLinkCheckNote相关结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
function renderLinkCheckNote(linkChecks) {
  if (linkChecks.ok) {
    const checked = linkChecks.results?.length || 0;
    return `链接检测：已检测 ${checked} 条。`;
  }
  return `链接检测：当前不可用（${escapeMarkdownText(linkChecks.error || "检测失败")}）。`;
}

/** 将formatDate相关结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
function formatDate(value) {
  if (!value || value === "0001-01-01T00:00:00Z") return "-";
  return String(value).slice(0, 10);
}

/** 转义 Markdown 表格单元格中的特殊字符。 */
/** 处理 escapeMarkdownCell 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function escapeMarkdownCell(value) {
  return escapeMarkdownText(value).replace(/\|/g, "\\|");
}

/** 清理文本中的换行和多余空白，避免破坏 Markdown 输出。 */
/** 处理 escapeMarkdownText 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function escapeMarkdownText(value) {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .trim();
}

/** 处理 Markdown 链接 URL 中的右括号等特殊字符。 */
/** 处理 escapeMarkdownUrl 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function escapeMarkdownUrl(value) {
  return String(value ?? "").replace(/\)/g, "%29");
}

/** 只保留用户指定网盘类型的搜索链接。 */
/** 处理 filterLinksByCloudTypes 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function filterLinksByCloudTypes(links, cloudTypes = []) {
  if (!cloudTypes || cloudTypes.length === 0) return links;
  const allowed = new Set(cloudTypes);
  return links.filter((link) => allowed.has(link.diskType));
}

/** 检查或分类checkSearchResultLinks相关输入，返回明确状态供主流程决定下一步动作。 */
/** 处理 checkSearchResultLinks 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
async function checkSearchResultLinks(args, downloadLinks) {
  const items = downloadLinks
    .filter((link) => CHECKABLE_TYPES.has(link.diskType))
    .map((link) => ({
      disk_type: link.diskType,
      url: link.url,
      ...(link.extractionCode ? { password: link.extractionCode } : {})
    }));

  if (items.length === 0) {
    return { ok: true, results: [], skipped: "no_checkable_links" };
  }

  const apiBase = normalizeApiBase(args.apiBase);
  const body = {
    items,
    ...(args.viewToken ? { view_token: args.viewToken } : {}),
    ...(args.proxyUrl ? { proxy_url: args.proxyUrl } : {})
  };
  const checkUrl = `${apiBase}/check/links`;
  try {
    const response = await fetchJson(checkUrl, {
      method: "POST",
      timeoutMs: args.timeoutMs,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    return normalizeCheckLinksResponse(response);
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      checkUrl,
      checkedItemCount: items.length
    };
  }
}

/** 发送 HTTP 请求并解析 JSON；是否产生远端变更取决于调用方传入的方法和请求体。 */
/** 发送 HTTP 请求并解析 JSON；远端是否发生变更取决于调用方选择的接口和请求方法。 */
async function fetchJson(url, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchJsonOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await delay(500 * (attempt + 1));
    }
  }
  throw lastError;
}

/** 执行单次 HTTP 请求，统一处理超时、响应解析和非成功状态。 */
/** 执行单次 HTTP 请求，处理超时、响应解析和非成功状态。 */
async function fetchJsonOnce(url, options = {}) {
  // 为本次请求设置可中止控制器，避免网络无响应时脚本无限等待。
  const controller = new AbortController();
  // 请求超时后主动中止底层 fetch；finally 中会清理定时器。
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      },
      body: options.body,
      signal: controller.signal
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    if (json && typeof json === "object" && "code" in json && json.code !== 0) {
      throw new Error(`PanSou API error: ${json.message || json.error || json.code}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

/** 异步等待指定时间，通常用于请求重试间隔。 */
/** 等待指定时间，通常用于请求重试间隔。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 处理unwrapData相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 unwrapData 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function unwrapData(response) {
  if (response && typeof response === "object" && response.data && typeof response.data === "object") {
    return response.data;
  }
  return response || {};
}

/** 将按网盘类型分组的链接展开为统一数组。 */
/** 处理 flattenMergedLinks 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function flattenMergedLinks(mergedByType) {
  const flattened = [];
  for (const [diskType, links] of Object.entries(mergedByType || {})) {
    for (const link of links || []) {
      flattened.push({ diskType, ...link });
    }
  }
  return flattened;
}

/** 将搜索结果中的链接展开为统一数组。 */
/** 处理 flattenResultsLinks 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function flattenResultsLinks(results) {
  const flattened = [];
  for (const result of results || []) {
    for (const link of result.links || []) {
      flattened.push({
        diskType: link.type || "others",
        url: link.url,
        password: link.password,
        note: link.work_title || result.title,
        datetime: link.datetime || result.datetime,
        source: result.channel ? `tg:${result.channel}` : "unknown",
        images: result.images || []
      });
    }
  }
  return flattened;
}

/** 按网盘类型归并搜索结果链接。 */
/** 处理 groupResultsByType 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function groupResultsByType(results) {
  const grouped = {};
  for (const result of results || []) {
    for (const link of result.links || []) {
      const diskType = link.type || "others";
      if (!grouped[diskType]) grouped[diskType] = [];
      grouped[diskType].push({
        url: link.url,
        password: link.password,
        note: link.work_title || result.title,
        datetime: link.datetime || result.datetime,
        source: result.channel ? `tg:${result.channel}` : "unknown",
        images: result.images || []
      });
    }
  }
  return grouped;
}

/** 规范化单条网盘分享链接，提取网盘类型、提取码和来源信息。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
function normalizeDownloadLink(link, rank) {
  const extractionCode = link.password || extractCodeFromUrl(link.url) || null;
  const provider = providerLabel(link.diskType);
  const label = link.note || provider;
  return {
    rank,
    provider,
    diskType: link.diskType,
    label,
    note: link.note || "",
    url: link.url,
    extractionCode,
    extractionCodes: extractionCode ? [extractionCode] : [],
    datetime: link.datetime || "",
    source: link.source || "",
    images: link.images || []
  };
}

/** 处理stripRank相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 stripRank 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function stripRank(link) {
  const { rank, ...rest } = link;
  return rest;
}

/** 把网盘类型代码转换为中文显示名称。 */
/** 处理 providerLabel 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function providerLabel(diskType) {
  return PROVIDER_LABELS[diskType] || diskType || "未知来源";
}

/** 从分享 URL 查询参数中提取可能的提取码。 */
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
function extractCodeFromUrl(url) {
  try {
    const parsed = new URL(url);
    return ["pwd", "password", "passcode", "extract_code", "extraction_code"]
      .map((name) => parsed.searchParams.get(name))
      .find(Boolean) || null;
  } catch {
    return null;
  }
}

/** 根据 include/exclude 参数构造搜索过滤条件。 */
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */
function buildFilter(include, exclude) {
  const filter = {};
  if (include && include.length > 0) filter.include = include;
  if (exclude && exclude.length > 0) filter.exclude = exclude;
  return Object.keys(filter).length > 0 ? filter : null;
}

/** 按指定字段统计条目数量。 */
/** 处理 countBy 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] || "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

/** 规范化 API 根地址，清理多余斜杠或补齐所需路径。 */
/** 规范化 API 根地址，清理末尾斜杠或补齐所需路径。 */
function normalizeApiBase(value) {
  const trimmed = (value || DEFAULT_API_BASE).replace(/\/+$/g, "");
  if (trimmed.endsWith("/api")) return trimmed;
  return `${trimmed}/api`;
}

/** 把逗号分隔的参数转换为去空格、去空项的数组。 */
/** 解析输入并返回规范化结果；无法识别的输入应明确报错。 */
function parseList(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 解析 JSON 参数字符串，遇到格式错误时给出带参数名的提示。 */
/** 解析 JSON 字符串；格式错误时明确抛出异常。 */
function parseJson(value, label) {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

/** 确认模块是直接运行而非被导入，避免导入时触发命令行副作用。 */
/** 判断模块是否由 Node.js 直接执行；被其他模块导入时不自动启动 CLI。 */

export {
  buildSearchQueryParams,
  formatSearchResult,
  normalizeCheckLinksResponse,
  normalizePanSouSearchResponse,
  parseArgs,
  renderMarkdownTable
};
