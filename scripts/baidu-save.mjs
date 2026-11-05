#!/usr/bin/env node

/**
 * 处理百度网盘分享链接解析、分享文件选择、转存和命名整理；转存、重命名会改变用户网盘内容。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

import {
  classifyResource,
  normalizeContextName,
  parseSelection
} from "./quark-save.mjs";
import { parseDotEnv } from "./check-env.mjs";

const DEFAULT_API_BASE = "https://pan.baidu.com";
const DEFAULT_APP_ID = "250528";
const DEFAULT_COOKIE_ENV = "BAIDU_COOKIE";
const DEFAULT_ENV_FILE = ".env";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_SIZE = 100;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 仅在直接执行脚本时启动主流程；作为模块导入时不产生网络请求或其他副作用。
  if (isCliEntryPoint()) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    process.exit(1);
  });
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
async function main() {
  const args = applyEnvDefaults(parseArgs(process.argv.slice(2)));
  if (!args.shareUrl || !args.savePath) {
    printUsage();
    process.exit(2);
  }

  if (!isCloudDrivePath(parseBaiduSavePath(args.savePath))) {
    throw new Error(`百度保存目录必须是网盘内路径或百度目录 URL，例如 /我的资源/影视：${args.savePath}`);
  }

  const cookie = resolveCookie(args);
  if (!cookie && !args.dryRun) {
    throw new Error(`缺少百度网盘 Cookie。请设置 ${args.cookieEnv} 环境变量，或使用 --cookie-env 指向你的 Cookie 环境变量。`);
  }

  const result = await prepareBaiduSave({ ...args, cookie });
  const jsonOutput = args.format === "json";

  if (args.dryRun) {
    if (jsonOutput) {
      console.log(JSON.stringify(buildBaiduSubagentPreview({ args, result }), null, 2));
    } else {
      console.log(renderBaiduShareItemsTable(result));
      console.log("\n--dry-run 已启用：只预览资源和命名建议，不会调用转存接口。");
    }
    return;
  }

  if (!jsonOutput) {
    console.log(renderBaiduShareItemsTable(result));
  }
  if (jsonOutput && !args.yes) {
    throw new Error("--format json 保存模式必须在用户确认后搭配 --yes 使用；预览请使用 --dry-run。");
  }

  const selectedItems = args.yes
    ? result.selectedPreview
    : await askUserSelection(result.items, args.defaultSelection);

  if (selectedItems.length === 0) {
    console.log("没有选择任何资源，已退出。");
    return;
  }

  const saveResult = await saveSelectedItems({
    ...args,
    cookie: result.cookie || cookie,
    share: result.share,
    contextName: result.contextName,
    selectedItems,
    renamePlan: buildBaiduRenamePlanForSelection({
      args,
      result,
      selectedItems
    })
  });

  if (jsonOutput) {
    console.log(JSON.stringify(buildBaiduSubagentSave({ args, result, saveResult }), null, 2));
  } else {
    console.log(renderSaveSummary(saveResult));
  }
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
function parseArgs(argv) {
  const parsed = {
    shareUrl: "",
    savePath: "",
    contextName: "",
    cookieEnv: DEFAULT_COOKIE_ENV,
    envFile: DEFAULT_ENV_FILE,
    apiBase: DEFAULT_API_BASE,
    appId: DEFAULT_APP_ID,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    defaultSelection: "all",
    resourceType: "auto",
    agentRenamePlan: null,
    passcode: "",
    yes: false,
    dryRun: false,
    noRename: false,
    format: "markdown"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--share-url") {
      parsed.shareUrl = argv[++index] || "";
    } else if (arg === "--save-path" || arg === "--to-path" || arg === "--dest-path") {
      parsed.savePath = argv[++index] || "";
    } else if (arg === "--context-name" || arg === "--resource-name") {
      parsed.contextName = argv[++index] || "";
    } else if (arg === "--cookie-env") {
      parsed.cookieEnv = argv[++index] || DEFAULT_COOKIE_ENV;
    } else if (arg === "--env-file") {
      parsed.envFile = argv[++index] || DEFAULT_ENV_FILE;
    } else if (arg === "--api-base") {
      parsed.apiBase = argv[++index] || DEFAULT_API_BASE;
    } else if (arg === "--app-id") {
      parsed.appId = argv[++index] || DEFAULT_APP_ID;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
    } else if (arg === "--select") {
      parsed.defaultSelection = argv[++index] || "all";
    } else if (arg === "--resource-type") {
      parsed.resourceType = argv[++index] || "auto";
    } else if (arg === "--rename-plan-json") {
      parsed.agentRenamePlan = parseJson(argv[++index], "--rename-plan-json");
    } else if (arg === "--passcode" || arg === "--pwd") {
      parsed.passcode = argv[++index] || "";
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--no-rename") {
      parsed.noRename = true;
    } else if (arg === "--json") {
      parsed.format = "json";
    } else if (arg === "--format") {
      parsed.format = argv[++index] || "markdown";
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!parsed.shareUrl) {
      parsed.shareUrl = arg;
    } else if (!parsed.savePath) {
      parsed.savePath = arg;
    } else if (!parsed.contextName) {
      parsed.contextName = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return parsed;
}

/** 执行applyEnvDefaults相关的远端变更；调用前必须确保用户已明确选择目标并确认写入范围。 */
function applyEnvDefaults(args, injectedEnv = null) {
  const fileEnv = injectedEnv || loadEnvFile(args.envFile);
  const env = { ...fileEnv, ...process.env };
  const rawSavePath = args.savePath || env.BAIDU_DEFAULT_SAVE_PATH || "";
  return {
    ...args,
    env,
    savePath: rawSavePath ? parseBaiduSavePath(rawSavePath) : ""
  };
}

/** 读取指定 .env 文件并解析键值；不会改写文件。 */
function loadEnvFile(envFile = DEFAULT_ENV_FILE) {
  if (!envFile || !fs.existsSync(envFile)) return {};
  return parseDotEnv(fs.readFileSync(envFile, "utf8"));
}

/** 处理printUsage相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
function printUsage() {
  console.error("Usage: node scripts/baidu-save.mjs <share-url> <baidu-save-path> [options]");
  console.error("Options:");
  console.error("  --context-name \"资源名\"       用上下文资源名修正保存后的文件名");
  console.error("  --resource-type auto|series|movie|collection");
  console.error("  --rename-plan-json '[{\"rank\":1,\"name\":\"修正名\",\"reason\":\"Agent 判断\"}]'");
  console.error("  --passcode 8888               手动指定百度提取码；链接中的 pwd 会自动识别");
  console.error("  --env-file .env                从 ENV 文件读取默认保存目录和 Cookie");
  console.error("  --cookie-env BAIDU_COOKIE      从指定环境变量读取百度 Cookie");
  console.error("  --select all|1,3|2-5           默认选择，交互确认时可覆盖");
  console.error("  --yes                          跳过确认，直接使用 --select");
  console.error("  --dry-run                      只列资源和命名建议，不转存");
  console.error("  --no-rename                    转存后不执行重命名修正");
}

/** 解析百度分享资源并生成可供人工选择的预览；此阶段以读取和准备为主。 */
async function prepareBaiduSave(args) {
  const share = parseBaiduShareUrl(args.shareUrl);
  if (args.passcode) share.passcode = args.passcode;

  let cookie = args.cookie || "";
  let context = null;
  let pageHtml = "";

  try {
    pageHtml = await fetchBaiduText(share.sharePageUrl, {
      cookie,
      referer: share.sharePageUrl,
      timeoutMs: args.timeoutMs
    });
    context = extractBaiduShareContextFromHtml(pageHtml);
  } catch (error) {
    if (!share.passcode) throw error;
  }

  if (share.passcode) {
    const bdstoken = context?.bdstoken || (cookie ? await getBaiduBdstoken({
      apiBase: args.apiBase,
      timeoutMs: args.timeoutMs,
      cookie
    }) : "");
    const verifyResult = await verifyBaiduShare({
      apiBase: args.apiBase,
      timeoutMs: args.timeoutMs,
      cookie,
      bdstoken,
      verifySurl: share.verifySurl,
      passcode: share.passcode,
      referer: share.sharePageUrl
    });
    cookie = mergeCookieString(cookie, verifyResult.setCookies);
    share.sekey = verifyResult.randsk || "";
    pageHtml = await fetchBaiduText(share.sharePageUrl, {
      cookie,
      referer: share.sharePageUrl,
      timeoutMs: args.timeoutMs
    });
    context = extractBaiduShareContextFromHtml(pageHtml);
  }

  if (!context) {
    throw new Error("无法从百度分享页解析 shareid/share_uk/bdstoken，请确认链接有效且 Cookie 可访问该分享。");
  }

  if (!context.bdstoken && cookie) {
    context.bdstoken = await getBaiduBdstoken({
      apiBase: args.apiBase,
      timeoutMs: args.timeoutMs,
      cookie
    });
  }

  let rows = context.files || [];
  if (rows.length === 0 && context.shareId && context.shareUk) {
    rows = await listBaiduShareFiles({
      apiBase: args.apiBase,
      appId: args.appId,
      timeoutMs: args.timeoutMs,
      cookie,
      shareId: context.shareId,
      shareUk: context.shareUk,
      sekey: share.sekey || ""
    });
  }

  const items = normalizeBaiduShareItems(rows);
  const shareTitle = context.title || items[0]?.name || "";
  const contextName = normalizeContextName(args.contextName || shareTitle);
  const classification = classifyResource({
    resourceType: args.resourceType,
    contextName,
    shareTitle,
    items
  });
  const selectedPreview = parseSelection(args.defaultSelection, items);
  const renamePlan = buildBaiduRenamePlanForSelection({
    args,
    result: { contextName, shareTitle, items },
    selectedItems: selectedPreview
  });

  return {
    ok: true,
    cookie,
    share: {
      ...share,
      bdstoken: context.bdstoken,
      shareId: context.shareId,
      shareUk: context.shareUk,
      title: shareTitle
    },
    shareTitle,
    contextName,
    savePath: args.savePath,
    classification,
    items,
    defaultSelection: args.defaultSelection,
    selectedPreview,
    renamePlan
  };
}

/** 根据用户明确选择的资源执行网盘保存；这是会修改个人网盘内容的操作。 */
async function saveSelectedItems(args) {
  const transferResponse = await transferBaiduShare({
    apiBase: args.apiBase,
    appId: args.appId,
    timeoutMs: args.timeoutMs,
    cookie: args.cookie,
    referer: args.share.sharePageUrl,
    bdstoken: args.share.bdstoken,
    shareId: args.share.shareId,
    shareUk: args.share.shareUk,
    savePath: args.savePath,
    selectedItems: args.selectedItems
  });

  const renameResults = args.noRename || args.renamePlan.length === 0
    ? []
    : await applyBaiduRenamePlan({
        apiBase: args.apiBase,
        appId: args.appId,
        timeoutMs: args.timeoutMs,
        cookie: args.cookie,
        bdstoken: args.share.bdstoken,
        savePath: args.savePath,
        renamePlan: args.renamePlan
      });

  return {
    ok: true,
    transferResponse,
    selectedItems: args.selectedItems,
    renamePlan: args.renamePlan,
    renameResults
  };
}

/** 解析百度分享 URL 中的分享码、提取码等必要信息。 */
function parseBaiduShareUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Baidu share URL: ${value}`);
  }
  if (!parsed.hostname.endsWith("pan.baidu.com")) {
    throw new Error(`Baidu share URL must be on pan.baidu.com: ${value}`);
  }

  let featureStr = "";
  const shareMatch = parsed.pathname.match(/\/s\/([^/?#]+)/);
  if (shareMatch) {
    featureStr = shareMatch[1];
  } else if (parsed.pathname === "/share/init" && parsed.searchParams.get("surl")) {
    const surl = parsed.searchParams.get("surl") || "";
    featureStr = surl.startsWith("1") ? surl : `1${surl}`;
  }

  if (!featureStr) {
    throw new Error(`Baidu share URL must include /s/<share-id> or /share/init?surl=...: ${value}`);
  }

  return {
    featureStr,
    verifySurl: featureStr.startsWith("1") ? featureStr.slice(1) : featureStr,
    passcode: parsed.searchParams.get("pwd") || parsed.searchParams.get("passcode") || parsed.searchParams.get("code") || "",
    sharePageUrl: `${DEFAULT_API_BASE}/s/${featureStr}`
  };
}

/** 从百度分享页面 HTML 中提取分享上下文。 */
function extractBaiduShareContextFromHtml(html) {
  const text = String(html || "");
  const mergedContext = mergeBaiduShareContexts([
    extractYunDataContext(text),
    extractLocalsMsetContext(text),
    extractJsonLoginContext(text)
  ]);
  if (mergedContext.shareId && mergedContext.shareUk) return mergedContext;

  if (!/["']?loginstate["']?\s*:|window\.yunData|locals\.mset/.test(text)) {
    throw new Error("百度分享页中没有找到 loginstate 数据。");
  }

  throw new Error("无法解析百度分享页中的分享上下文。");
}

/** 从页面内嵌 JSON 中提取登录/分享上下文。 */
function extractJsonLoginContext(text) {
  const markerIndex = text.search(/["']?loginstate["']?\s*:/);
  if (markerIndex === -1) {
    return null;
  }

  for (let start = text.lastIndexOf("{", markerIndex); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    const jsonText = extractBalancedJson(text, start);
    if (!jsonText) continue;
    try {
      const data = JSON.parse(jsonText);
      const context = normalizeBaiduShareContext(data);
      if (context.shareId && context.shareUk) return context;
    } catch {
      continue;
    }
  }

  return null;
}

/** 从页面数据对象中提取百度分享上下文。 */
function extractYunDataContext(text) {
  const match = String(text || "").match(/window\.yunData\s*=\s*\{([\s\S]*?)\};/);
  if (!match) return null;
  return {
    bdstoken: extractJsObjectProperty(match[1], "bdstoken"),
    shareId: extractJsObjectProperty(match[1], "shareid"),
    shareUk: extractJsObjectProperty(match[1], "share_uk"),
    files: []
  };
}

/** 从页面脚本变量中提取分享上下文。 */
function extractLocalsMsetContext(text) {
  let searchIndex = 0;
  while (searchIndex < text.length) {
    const markerIndex = text.indexOf("locals.mset", searchIndex);
    if (markerIndex === -1) return null;
    const start = text.indexOf("{", markerIndex);
    if (start === -1) return null;
    const jsonText = extractBalancedJson(text, start);
    searchIndex = start + 1;
    if (!jsonText) continue;
    try {
      return normalizeBaiduShareContext(JSON.parse(jsonText));
    } catch {
      continue;
    }
  }
  return null;
}

/** 从 JavaScript 片段中提取目标属性值，供分享页面兼容解析使用。 */
function extractJsObjectProperty(body, key) {
  const pattern = new RegExp(`(?:^|,)\\s*${escapeRegExp(key)}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))`, "s");
  const match = String(body || "").match(pattern);
  if (!match) return "";
  return String(match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** 合并页面不同位置提取到的分享上下文。 */
function mergeBaiduShareContexts(contexts) {
  const merged = {
    bdstoken: "",
    shareId: "",
    shareUk: "",
    title: "",
    rootPath: "",
    files: []
  };

  for (const context of contexts) {
    if (!context) continue;
    if (!merged.bdstoken && context.bdstoken) merged.bdstoken = context.bdstoken;
    if (!merged.shareId && context.shareId) merged.shareId = context.shareId;
    if (!merged.shareUk && context.shareUk) merged.shareUk = context.shareUk;
    if (!merged.title && context.title) merged.title = context.title;
    if (!merged.rootPath && context.rootPath) merged.rootPath = context.rootPath;
    if (merged.files.length === 0 && Array.isArray(context.files) && context.files.length > 0) {
      merged.files = context.files;
    }
  }

  return merged;
}

/** 定位并截取括号闭合的 JSON 内容，避免截断对象被误解析。 */
function extractBalancedJson(text, startIndex) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return "";
}

/** 规范化从百度页面提取的分享上下文。 */
function normalizeBaiduShareContext(data) {
  const files = data.file_list || data.list || [];
  return {
    bdstoken: String(data.bdstoken || ""),
    shareId: stringOrEmpty(data.shareid ?? data.share_id ?? data.shareId),
    shareUk: stringOrEmpty(data.share_uk ?? data.uk ?? data.shareUk),
    title: data.title || data.share_title || data.server_filename || files[0]?.server_filename || "",
    rootPath: files[0]?.parent_path || data.share_root || "",
    files
  };
}

/** 把百度分享接口返回的文件条目转换为统一结构。 */
function normalizeBaiduShareItems(rows) {
  return (rows || []).map((row, index) => {
    const isDir = Number(row.isdir ?? row.is_dir ?? row.is_directory ?? 0) === 1 || row.isDirectory === true;
    return {
      rank: index + 1,
      fsId: row.fs_id ?? row.fsid ?? row.id,
      path: row.path || "",
      name: row.server_filename || row.filename || row.name || "未命名资源",
      isDir,
      typeLabel: isDir ? "文件夹" : "文件",
      size: Number(row.size || 0),
      sizeLabel: isDir ? "-" : formatBytes(Number(row.size || 0)),
      updatedAt: row.server_mtime || row.local_mtime || row.mtime || null,
      updatedAtLabel: formatTimestamp(row.server_mtime || row.local_mtime || row.mtime),
      raw: row
    };
  });
}

/** 构造百度分享转存接口所需参数。 */
function buildBaiduTransferRequest({
  apiBase = DEFAULT_API_BASE,
  appId = DEFAULT_APP_ID,
  bdstoken,
  shareId,
  shareUk,
  savePath,
  selectedItems = []
}) {
  const url = new URL("/share/transfer", normalizeApiBase(apiBase));
  const query = {
    app_id: appId,
    channel: "chunlei",
    clienttype: "0",
    web: "1",
    shareid: shareId,
    from: shareUk,
    bdstoken,
    ondup: "newcopy"
  };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const body = new URLSearchParams();
  body.set("fsidlist", JSON.stringify(selectedItems.map((item) => item.fsId)));
  body.set("path", parseBaiduSavePath(savePath || "/"));
  return { url, body };
}

/** 构造BaiduRenamePlanForSelection所需的数据结构或执行计划；除非函数说明明确涉及执行，否则只准备数据、不提交远端变更。 */
function buildBaiduRenamePlanForSelection({ args, result, selectedItems }) {
  if (args.noRename) return [];
  if (args.agentRenamePlan) {
    return resolveBaiduRenamePlan({
      selectedItems,
      savePath: args.savePath,
      agentRenamePlan: args.agentRenamePlan
    });
  }
  return buildBaiduRenamePlan({
    resourceType: args.resourceType,
    contextName: result.contextName || "",
    shareTitle: result.shareTitle || "",
    savePath: args.savePath,
    selectedItems
  });
}

/** 为百度网盘候选文件生成建议名称和重命名计划。 */
function buildBaiduRenamePlan({ resourceType = "auto", contextName = "", shareTitle = "", savePath = "/", selectedItems = [] } = {}) {
  const baseName = sanitizeFileName(contextName || shareTitle || "");
  if (!baseName) return [];
  const classification = classifyResource({ resourceType, contextName: baseName, shareTitle, items: selectedItems });
  const plan = [];
  selectedItems.forEach((item) => {
    const suggestedName = suggestSavedName({
      baseName,
      item,
      selectedCount: selectedItems.length,
      isSeries: classification.isSeries
    });
    if (!suggestedName || suggestedName === item.name) return;
    plan.push({
      sourcePath: joinCloudPath(savePath, item.name),
      originalName: item.name,
      suggestedName,
      reason: classification.isSeries ? "按上下文资源名修正剧集文件名" : "按上下文资源名修正保存名称"
    });
  });
  return plan;
}

/** 根据资源信息和用户选择解析百度网盘重命名计划，不在此处执行修改。 */
function resolveBaiduRenamePlan({ selectedItems = [], savePath = "/", agentRenamePlan = [] } = {}) {
  if (!Array.isArray(agentRenamePlan)) {
    throw new Error("Agent rename plan must be a JSON array");
  }
  const plan = [];
  for (const decision of agentRenamePlan) {
    const rank = Number(decision.rank ?? decision.index);
    if (!Number.isFinite(rank) || rank < 1) {
      throw new Error(`Agent rename plan item is missing a valid rank/index: ${JSON.stringify(decision)}`);
    }
    const selectedIndex = selectedItems.findIndex((item) => item.rank === rank);
    const fallbackIndex = selectedItems[rank - 1] ? rank - 1 : -1;
    const itemIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;
    if (itemIndex < 0) {
      throw new Error(`Agent rename plan rank is not selected: ${rank}`);
    }

    const item = selectedItems[itemIndex];
    const suggestedName = sanitizeFileName(decision.name || decision.suggestedName || "");
    if (!suggestedName) {
      throw new Error(`Agent rename plan item is missing name/suggestedName: ${JSON.stringify(decision)}`);
    }
    if (suggestedName === item.name) continue;
    plan.push({
      sourcePath: joinCloudPath(savePath, item.name),
      originalName: item.name,
      suggestedName,
      reason: decision.reason || "Agent 指定重命名"
    });
  }
  return plan;
}

/** 将renderBaiduShareItemsTable相关结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
function renderBaiduShareItemsTable({
  shareTitle = "",
  contextName = "",
  savePath = "",
  items = [],
  classification,
  renamePlan = []
}) {
  const detected = classification || classifyResource({ contextName, shareTitle, items });
  const lines = [
    "### 百度网盘分享资源",
    "",
    `分享标题：${escapeMarkdownText(shareTitle || "-")}`,
    `修正资源名：${escapeMarkdownText(contextName || "-")}`,
    `目标目录：${escapeMarkdownText(savePath || "-")}`,
    `资源类型：${escapeMarkdownText(detected.label)}（${escapeMarkdownText(detected.reason)}）`,
    "",
    "| # | 类型 | 名称 | 大小 | 更新时间 |",
    "|---:|---|---|---|---|"
  ];

  for (const item of items) {
    lines.push(
      [
        item.rank,
        escapeMarkdownCell(item.typeLabel),
        escapeMarkdownCell(item.name),
        escapeMarkdownCell(item.sizeLabel),
        escapeMarkdownCell(item.updatedAtLabel)
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    );
  }

  if (renamePlan.length > 0) {
    lines.push("", "建议保存后重命名：", "", "| # | 原名称 | 建议名称 | 原因 |", "|---:|---|---|---|");
    renamePlan.forEach((item, index) => {
      lines.push(
        [
          index + 1,
          escapeMarkdownCell(item.originalName),
          escapeMarkdownCell(item.suggestedName),
          escapeMarkdownCell(item.reason)
        ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
      );
    });
  }

  return lines.join("\n");
}

/** 汇总网盘保存结果，包括成功、失败和待处理项目。 */
function renderSaveSummary(saveResult) {
  const lines = [
    "",
    "### 百度网盘转存结果",
    "",
    `已选择：${saveResult.selectedItems.length} 项`,
    `接口 errno：${saveResult.transferResponse.errno ?? 0}`
  ];
  if (saveResult.renameResults.length > 0) {
    lines.push("", "重命名修正：");
    saveResult.renameResults.forEach((item) => {
      lines.push(`- ${item.ok ? "成功" : "失败"}：${item.originalName} -> ${item.suggestedName}${item.error ? `（${item.error}）` : ""}`);
    });
  }
  return lines.join("\n");
}

/** 生成供自动化代理展示的百度资源预览，不执行转存。 */
function buildBaiduSubagentPreview({ args = {}, result }) {
  const selectedItems = result.selectedPreview || parseSelection(result.defaultSelection || args.defaultSelection || "all", result.items || []);
  return {
    ok: true,
    provider: "baidu",
    mode: "preview",
    nextAction: "confirm_before_save",
    source: {
      shareUrl: args.shareUrl || "",
      shareId: result.share?.featureStr || "",
      passcodePresent: Boolean(result.share?.passcode)
    },
    target: {
      provider: "baidu",
      pathOrUrl: result.savePath || args.savePath || ""
    },
    resource: {
      shareTitle: result.shareTitle || "",
      canonicalName: result.contextName || "",
      type: result.classification?.type || "unknown",
      label: result.classification?.label || "",
      isSeries: Boolean(result.classification?.isSeries),
      reason: result.classification?.reason || ""
    },
    selection: {
      defaultSelection: result.defaultSelection || args.defaultSelection || "all",
      selectedRanks: selectedItems.map((item) => item.rank),
      selectedItems: selectedItems.map(serializeBaiduItem)
    },
    items: (result.items || []).map(serializeBaiduItem),
    renamePlan: serializeRenamePlan(result.renamePlan || []),
    confirmation: {
      source: args.shareUrl || "",
      selectedItems: selectedItems.map(serializeBaiduItem),
      target: {
        provider: "baidu",
        pathOrUrl: result.savePath || args.savePath || ""
      },
      finalNaming: serializeRenamePlan(result.renamePlan || []),
      commandHint: "Re-run scripts/baidu-save.mjs with --yes after the user confirms this payload."
    }
  };
}

/** 构造百度转存动作所需的参数和结果结构。 */
function buildBaiduSubagentSave({ args = {}, result, saveResult }) {
  return {
    ok: true,
    provider: "baidu",
    mode: "save",
    nextAction: "verify_target_path_or_openlist",
    source: {
      shareUrl: args.shareUrl || "",
      shareId: result.share?.featureStr || "",
      passcodePresent: Boolean(result.share?.passcode)
    },
    target: {
      provider: "baidu",
      pathOrUrl: result.savePath || args.savePath || ""
    },
    resource: {
      shareTitle: result.shareTitle || "",
      canonicalName: result.contextName || "",
      type: result.classification?.type || "unknown",
      label: result.classification?.label || "",
      isSeries: Boolean(result.classification?.isSeries),
      reason: result.classification?.reason || ""
    },
    selectedItems: (saveResult.selectedItems || []).map(serializeBaiduItem),
    errno: saveResult.transferResponse?.errno ?? 0,
    transferResponse: summarizeBaiduTransferResponse(saveResult.transferResponse || {}),
    renamePlan: serializeRenamePlan(saveResult.renamePlan || []),
    renameResults: serializeRenameResults(saveResult.renameResults || [])
  };
}

/** 将百度资源对象转换为稳定、可输出的字段集合。 */
function serializeBaiduItem(item) {
  return {
    rank: item.rank,
    id: item.fsId,
    path: item.path,
    name: item.name,
    typeLabel: item.typeLabel,
    isDir: item.isDir,
    size: item.size,
    sizeLabel: item.sizeLabel,
    updatedAtLabel: item.updatedAtLabel
  };
}

/** 将重命名计划转换为可展示/传递的结构。 */
function serializeRenamePlan(plan) {
  return (plan || []).map((item, index) => ({
    rank: index + 1,
    id: item.fid || item.sourcePath || "",
    originalName: item.originalName,
    suggestedName: item.suggestedName,
    reason: item.reason
  }));
}

/** 将重命名执行结果转换为可展示结构。 */
function serializeRenameResults(results) {
  return (results || []).map((item) => ({
    ok: Boolean(item.ok),
    id: item.fid || item.sourcePath || "",
    originalName: item.originalName,
    suggestedName: item.suggestedName,
    reason: item.reason,
    error: item.error || ""
  }));
}

/** 汇总百度转存接口响应，提取任务结果和错误信息。 */
function summarizeBaiduTransferResponse(response) {
  return {
    errno: response.errno ?? 0,
    showMsg: response.show_msg || "",
    taskId: response.task_id || response.taskid || ""
  };
}

/** 展示候选资源并收集明确选择；未获得选择时不应擅自保存全部资源。 */
async function askUserSelection(items, defaultSelection) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`请选择要转存的序号（默认 ${defaultSelection}，支持 all、1,3、2-5）：`);
    return parseSelection(answer.trim() || defaultSelection, items);
  } finally {
    rl.close();
  }
}

/** 读取百度分享页面/接口信息，确认分享资源及访问上下文。 */
async function verifyBaiduShare({ apiBase, timeoutMs, cookie, bdstoken, verifySurl, passcode, referer }) {
  const url = new URL("/share/verify", normalizeApiBase(apiBase));
  const query = {
    surl: verifySurl,
    bdstoken,
    channel: "chunlei",
    web: "1",
    app_id: DEFAULT_APP_ID,
    clienttype: "0",
    t: Date.now()
  };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const body = new URLSearchParams();
  body.set("pwd", passcode || "");
  body.set("vcode", "");
  body.set("vcode_str", "");

  const result = await fetchBaiduJsonWithMeta(url, {
    method: "POST",
    timeoutMs,
    cookie,
    referer,
    body
  });
  if (result.json.errno !== 0) {
    throw new Error(`百度提取码校验失败 errno=${result.json.errno}: ${result.json.show_msg || result.json.errmsg || "unknown error"}`);
  }
  return {
    randsk: result.json.randsk || "",
    setCookies: result.setCookies
  };
}

/** 从百度网盘只读接口获取后续请求所需的 bdstoken。 */
async function getBaiduBdstoken({ apiBase, timeoutMs, cookie }) {
  const url = new URL("/api/gettemplatevariable", normalizeApiBase(apiBase));
  url.searchParams.set("fields", '["bdstoken"]');
  const response = await fetchBaiduJson(url, {
    timeoutMs,
    cookie,
    referer: normalizeApiBase(apiBase)
  });
  return response.result?.bdstoken || response.bdstoken || "";
}

/** 读取百度分享中的文件列表，不执行转存。 */
async function listBaiduShareFiles({ apiBase, appId, timeoutMs, cookie, shareId, shareUk, sekey = "", dir = "/" }) {
  const rows = [];
  let page = 1;
  while (true) {
    const url = new URL("/share/list", normalizeApiBase(apiBase));
    const query = {
      app_id: appId || DEFAULT_APP_ID,
      channel: "chunlei",
      clienttype: "0",
      web: "1",
      uk: shareUk,
      shareid: shareId,
      order: "name",
      desc: "0",
      showempty: "0",
      page,
      num: DEFAULT_PAGE_SIZE,
      dir
    };
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    if (sekey) url.searchParams.set("sekey", sekey);

    const response = await fetchBaiduJson(url, {
      timeoutMs,
      cookie,
      referer: normalizeApiBase(apiBase)
    });
    const list = response.list || [];
    rows.push(...list);
    if (list.length < DEFAULT_PAGE_SIZE) break;
    page += 1;
  }
  return rows;
}

/** 向百度网盘提交分享文件转存请求；该操作会在用户网盘中新增文件。 */
async function transferBaiduShare({ apiBase, appId, timeoutMs, cookie, referer, bdstoken, shareId, shareUk, savePath, selectedItems }) {
  if (!bdstoken) {
    throw new Error("缺少百度 bdstoken，无法调用 share/transfer。请确认 BAIDU_COOKIE 有效且已登录百度网盘。");
  }
  const request = buildBaiduTransferRequest({
    apiBase,
    appId,
    bdstoken,
    shareId,
    shareUk,
    savePath,
    selectedItems
  });
  return fetchBaiduJson(request.url, {
    method: "POST",
    timeoutMs,
    cookie,
    referer,
    body: request.body
  });
}

/** 读取百度网盘目标目录内容，不执行目录修改。 */
async function listBaiduDir({ apiBase, appId, timeoutMs, cookie, bdstoken, dir }) {
  const url = new URL("/api/list", normalizeApiBase(apiBase));
  const query = {
    app_id: appId || DEFAULT_APP_ID,
    channel: "chunlei",
    clienttype: "0",
    web: "1",
    order: "name",
    desc: "0",
    showempty: "0",
    page: "1",
    num: "1000",
    dir,
    bdstoken
  };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetchBaiduJson(url, {
    timeoutMs,
    cookie,
    referer: normalizeApiBase(apiBase)
  });
  return normalizeBaiduShareItems(response.list || []);
}

/** 按确认后的重命名计划调用百度接口修改网盘文件或目录名称。 */
async function applyBaiduRenamePlan({ apiBase, appId, timeoutMs, cookie, bdstoken, savePath, renamePlan }) {
  const targetRows = await listBaiduDir({
    apiBase,
    appId,
    timeoutMs,
    cookie,
    bdstoken,
    dir: savePath
  });
  const results = [];

  for (const item of renamePlan) {
    try {
      const matched = targetRows.find((row) => row.name === item.originalName);
      const sourcePath = matched?.path || item.sourcePath;
      const response = await renameBaiduPath({
        apiBase,
        appId,
        timeoutMs,
        cookie,
        bdstoken,
        sourcePath,
        newName: item.suggestedName
      });
      results.push({ ...item, ok: true, response });
    } catch (error) {
      results.push({ ...item, ok: false, error: error.message || String(error) });
    }
  }

  return results;
}

/** 调用百度网盘接口重命名指定路径；该函数会改变网盘目录项。 */
async function renameBaiduPath({ apiBase, appId, timeoutMs, cookie, bdstoken, sourcePath, newName }) {
  const url = new URL("/api/filemanager", normalizeApiBase(apiBase));
  const query = {
    app_id: appId || DEFAULT_APP_ID,
    channel: "chunlei",
    clienttype: "0",
    web: "1",
    opera: "rename",
    async: "2",
    onnest: "fail",
    bdstoken
  };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const body = new URLSearchParams();
  body.set("filelist", JSON.stringify([{ path: sourcePath, newname: newName }]));
  return fetchBaiduJson(url, {
    method: "POST",
    timeoutMs,
    cookie,
    referer: normalizeApiBase(apiBase),
    body
  });
}

/** 封装BaiduText相关网络请求，处理超时、响应解析和错误传递；是否改变远端数据取决于请求方法及接口。 */
async function fetchBaiduText(url, options = {}) {
  const result = await fetchWithTimeout(url, options);
  const text = await result.response.text();
  if (!result.response.ok) {
    throw new Error(`HTTP ${result.response.status} from ${result.url}: ${text.slice(0, 200)}`);
  }
  return text;
}

/** 发送百度 API 请求并解析 JSON 响应；具体读写属性由调用接口决定。 */
async function fetchBaiduJson(url, options = {}) {
  return (await fetchBaiduJsonWithMeta(url, options)).json;
}

/** 发送百度 API 请求并保留 HTTP 状态、响应头等元数据，供后续兼容性判断。 */
async function fetchBaiduJsonWithMeta(url, options = {}) {
  const result = await fetchWithTimeout(url, options);
  const text = await result.response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expected JSON from ${result.url}, got: ${text.slice(0, 200)}`);
  }
  if (!result.response.ok) {
    throw new Error(`HTTP ${result.response.status} from ${result.url}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  if (json && typeof json === "object" && "errno" in json && Number(json.errno) !== 0) {
    throw new Error(`Baidu API error ${json.errno}: ${json.show_msg || json.errmsg || json.errno_msg || "unknown error"}`);
  }
  return {
    json,
    setCookies: getSetCookieHeaders(result.response.headers)
  };
}

/** 执行带超时控制的网络请求；超时后通过 AbortController 中止。 */
async function fetchWithTimeout(url, options = {}) {
  const requestUrl = new URL(String(url));
  // 为本次请求设置可中止控制器，避免网络无响应时脚本无限等待。
  const controller = new AbortController();
  // 请求超时后主动中止底层 fetch；finally 中会清理定时器。
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const headers = {
      Accept: options.accept || "application/json, text/plain, */*",
      "User-Agent": USER_AGENT
    };
    if (options.body instanceof URLSearchParams) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.referer) headers.Referer = options.referer;
    const response = await fetch(requestUrl, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: controller.signal
    });
    return { response, url: requestUrl };
  } finally {
    clearTimeout(timeout);
  }
}

/** 从 HTTP 响应头中提取 Set-Cookie 值，兼容不同运行环境。 */
function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

/** 合并响应中的 Set-Cookie 字段，形成后续请求可用的 Cookie 字符串。 */
function mergeCookieString(cookie, setCookies = []) {
  const values = new Map();
  for (const part of String(cookie || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;
    values.set(trimmed.slice(0, equalIndex), trimmed.slice(equalIndex + 1));
  }
  for (const setCookie of setCookies || []) {
    const first = String(setCookie || "").split(";")[0].trim();
    const equalIndex = first.indexOf("=");
    if (equalIndex === -1) continue;
    values.set(first.slice(0, equalIndex), first.slice(equalIndex + 1));
  }
  return [...values.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

/** 从参数或环境变量中解析网盘 Cookie；避免在输出中回显完整凭证。 */
function resolveCookie(args) {
  return (args.env?.[args.cookieEnv] || process.env[args.cookieEnv] || "").trim();
}

/** 规范化 API 根地址，清理多余斜杠或补齐所需路径。 */
function normalizeApiBase(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/g, "");
}

/** 检查网盘路径是否为以斜杠开头且不含路径穿越片段的路径。 */
function isCloudDrivePath(value) {
  return String(value || "").startsWith("/") && !String(value).includes("..");
}

/** 从路径或目录 URL 中提取百度网盘目标目录路径。 */
function parseBaiduSavePath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (isCloudDrivePath(text)) return text;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`百度保存目录必须是网盘内路径或百度目录 URL：${value}`);
  }
  if (!parsed.hostname.endsWith("pan.baidu.com")) {
    throw new Error(`百度保存目录 URL 必须来自 pan.baidu.com：${value}`);
  }

  const hashQuery = parsed.hash.includes("?") ? parsed.hash.slice(parsed.hash.indexOf("?") + 1) : "";
  const pathValue = new URLSearchParams(hashQuery).get("path") || parsed.searchParams.get("path") || "";
  if (!isCloudDrivePath(pathValue)) {
    throw new Error(`百度目录 URL 必须包含有效 path 参数：${value}`);
  }
  return pathValue;
}

/** 根据资源类型和文件名信息生成建议保存名称，不直接修改原文件。 */
function suggestSavedName({ baseName, item, selectedCount, isSeries }) {
  const extension = item.isDir ? "" : getExtension(item.name);
  if (item.isDir) {
    if (selectedCount === 1) return baseName;
    return sanitizeFileName(`${baseName} - ${item.name}`);
  }
  if (isSeries) {
    const episode = extractEpisodeLabel(item.name);
    if (episode) return sanitizeFileName(`${baseName} ${episode}${extension}`);
  }
  if (selectedCount === 1) return sanitizeFileName(`${baseName}${extension}`);
  return sanitizeFileName(`${baseName} - ${stripExtension(item.name)}${extension}`);
}

/** 从资源名中提取集数标签，供命名建议使用。 */
function extractEpisodeLabel(value) {
  const text = String(value || "");
  const seasonEpisode = text.match(/S(\d{1,2})E(\d{1,3})/i);
  if (seasonEpisode) {
    return `S${seasonEpisode[1].padStart(2, "0")}E${seasonEpisode[2].padStart(2, "0")}`;
  }
  const cnEpisode = text.match(/第([一二三四五六七八九十百\d]+)集/);
  if (cnEpisode) return `第${cnEpisode[1]}集`;
  const ep = text.match(/\bEP?\.?(\d{1,3})\b/i);
  if (ep) return `E${ep[1].padStart(2, "0")}`;
  return "";
}

/** 提取文件扩展名。 */
function getExtension(value) {
  const ext = path.extname(String(value || ""));
  return ext.length <= 12 ? ext : "";
}

/** 移除文件名末尾扩展名。 */
function stripExtension(value) {
  const ext = getExtension(value);
  return ext ? String(value).slice(0, -ext.length) : String(value || "");
}

/** 清理文件名中不适合用于文件系统/网盘路径的字符。 */
function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 处理joinCloudPath相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
function joinCloudPath(basePath, name) {
  const base = String(basePath || "/").replace(/\/+$/g, "") || "/";
  const cleanName = String(name || "").replace(/^\/+/g, "");
  return base === "/" ? `/${cleanName}` : `${base}/${cleanName}`;
}

/** 解析 JSON 参数字符串，遇到格式错误时给出带参数名的提示。 */
function parseJson(value, label) {
  try {
    return JSON.parse(value || "[]");
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

/** 处理stringOrEmpty相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
function stringOrEmpty(value) {
  return value === undefined || value === null ? "" : String(value);
}

/** 处理escapeRegExp相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把字节数转换为易读的容量单位。 */
function formatBytes(bytes) {
  if (!bytes) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/** 把时间戳或日期值转换为可读时间文本。 */
function formatTimestamp(value) {
  if (!value) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().slice(0, 10);
}

/** 转义 Markdown 表格单元格中的特殊字符。 */
function escapeMarkdownCell(value) {
  return escapeMarkdownText(value).replace(/\|/g, "\\|");
}

/** 清理文本中的换行和多余空白，避免破坏 Markdown 输出。 */
function escapeMarkdownText(value) {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .trim();
}

/** 确认模块是直接运行而非被导入，避免导入时触发命令行副作用。 */
function isCliEntryPoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export {
  applyEnvDefaults,
  buildBaiduRenamePlan,
  buildBaiduSubagentPreview,
  buildBaiduSubagentSave,
  buildBaiduTransferRequest,
  extractBaiduShareContextFromHtml,
  normalizeBaiduShareItems,
  parseBaiduSavePath,
  parseBaiduShareUrl,
  renderBaiduShareItemsTable
};
