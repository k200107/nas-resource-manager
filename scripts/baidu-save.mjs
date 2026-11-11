#!/usr/bin/env node
import path from "node:path";
import { askUserSelection, classifyResource, escapeMarkdownCell, escapeMarkdownText, extractEpisodeLabel, formatBytes, formatTimestamp as formatTimestampCommon, getExtension, normalizeContextName, parseJson, parseSelection, resolveCookie, sanitizeFileName, stripExtension, suggestSavedName } from "./cloud-save-common.mjs";
import { buildResourceRenamePlan, resolveAgentRenamePlan, resolveResourceContext } from "./resource-recognition.mjs";
import { loadEnvFile, mergeEnvValues } from "./env-config.mjs";
import { cliArgs, failCli, isCliEntryPoint as isCli } from "./cli-utils.mjs";
import { directoryPlanFields, resolveCloudDirectory, resolveDirectoryMode } from "./cloud-directory.mjs";

/**
 * 解析百度分享资源、展示候选项并按明确选择转存到用户网盘；转存和重命名属于远端写操作。
 *
 * 本文件说明：函数注释描述职责和关键边界；除注释外不改变既有执行逻辑。
 * 安全约束：任何网盘/NAS 写操作都必须以明确目标和用户授权为前提；预览和查询流程保持只读。
 */

/**
 * 处理百度网盘分享链接解析、分享文件选择、转存和命名整理；转存、重命名会改变用户网盘内容。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */




const DEFAULT_API_BASE = "https://pan.baidu.com";
const DEFAULT_APP_ID = "250528";
const DEFAULT_COOKIE_ENV = "BAIDU_COOKIE";
const DEFAULT_ENV_FILE = ".env";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_SIZE = 100;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 仅在直接执行脚本时启动主流程；作为模块导入时不产生网络请求或其他副作用。
  if (isCli(import.meta.url)) {
  main().catch((error) => failCli(error));
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
/** 命令行主入口：解析参数、加载配置、调用核心流程并输出结果。 */
async function main() {
  const args = applyEnvDefaults(parseArgs(cliArgs()));
  const jsonOutput = args.format === "json";

  if (args.resumeRename) {
    if (!args.sourcePath || !args.renameTo) throw new Error("--resume-rename requires --source-path and --rename-to.");
    if (!args.dryRun && !args.yes) throw new Error("重命名恢复执行必须先预览，再在确认后使用 --yes。");
    const resumeCookie = resolveCookie(args);
    if (!resumeCookie) throw new Error(`缺少百度网盘 Cookie。请设置 ${args.cookieEnv} 环境变量。`);
    const recovery = await resumeBaiduRename({
      sourcePath: args.sourcePath, newName: args.renameTo, expectedFsId: args.expectedFsId, apiBase: args.apiBase,
      appId: args.appId, timeoutMs: args.timeoutMs, cookie: resumeCookie, dryRun: args.dryRun
    });
    const payload = buildBaiduCompactRenameRecovery(recovery);
    if (jsonOutput) console.log(JSON.stringify(payload));
    else console.log(`${payload.state}: ${payload.sourcePath} -> ${payload.targetPath}${payload.error ? ` (${payload.error})` : ""}`);
    if (!payload.ok && payload.state !== "READY_TO_RENAME") process.exitCode = 1;
    return;
  }

  args.directoryMode = resolveDirectoryMode(args);
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

  if (args.dryRun) {
    if (jsonOutput) {
      console.log(JSON.stringify(args.compact ? buildBaiduCompactPreview({ args, result }) : buildBaiduSubagentPreview({ args, result }), null, 2));
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
    console.log(JSON.stringify(args.compact ? buildBaiduCompactSave({ args, result, saveResult }) : buildBaiduSubagentSave({ args, result, saveResult }), null, 2));
  } else {
    console.log(renderSaveSummary(saveResult));
  }
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；未知参数会报错，避免拼写错误被静默忽略。 */
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
    noCreateDir: false,
    format: "markdown",
    compact: false,
    resumeRename: false,
    sourcePath: "",
    renameTo: "",
    expectedFsId: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--resume-rename") {
      parsed.resumeRename = true;
    } else if (arg === "--source-path") {
      parsed.sourcePath = argv[++index] || "";
    } else if (arg === "--rename-to") {
      parsed.renameTo = argv[++index] || "";
    } else if (arg === "--expected-id") {
      parsed.expectedFsId = argv[++index] || "";
    } else if (arg === "--share-url") {
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
    } else if (arg === "--no-create-dir") {
      parsed.noCreateDir = true;
    } else if (arg === "--compact") {
      parsed.compact = true;
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
/** 处理 applyEnvDefaults 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function applyEnvDefaults(args, injectedEnv = null) {
  const env = mergeEnvValues(loadEnvFile(args.envFile).values, process.env, injectedEnv);
  const rawSavePath = args.savePath || env.BAIDU_DEFAULT_SAVE_PATH || "";
  return {
    ...args,
    env,
    savePath: rawSavePath ? parseBaiduSavePath(rawSavePath) : ""
  };
}

/** 读取指定 .env 文件并解析键值；不会改写文件。 */
/** 读取并解析 .env 文件；不会创建或修改配置文件。 */

/** 处理printUsage相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 printUsage 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
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
  console.error("  --resume-rename --source-path PATH --rename-to NAME 仅恢复重命名，不会再次转存");
  console.error("  --dry-run / --yes               重命名恢复先预览，确认后执行");
  console.error("  --no-create-dir                不自动创建缺失的保存目录，保持旧行为");
}

/** 解析百度分享资源并生成可供人工选择的预览；此阶段以读取和准备为主。 */
/** 解析百度分享链接、读取分享条目并生成待用户审阅的资源预览。 */
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
  const resourceContext = resolveResourceContext({
    resourceType: args.resourceType,
    contextName: args.contextName || shareTitle,
    shareTitle,
    items
  });
  const contextName = resourceContext.canonicalName;
  const classification = resourceContext.classification;
  const selectedPreview = parseSelection(args.defaultSelection, items);
  const renamePlan = buildBaiduRenamePlanForSelection({
    args,
    result: { contextName, shareTitle, items },
    selectedItems: selectedPreview
  });

  // strict 保持旧行为，不额外检查目录（由转存接口自行校验）。
  // preview 只列出将创建的路径；create 只会在用户 --yes 确认后被推导出来。
  const directoryPlan = args.directoryMode && args.directoryMode !== "strict"
    ? await planBaiduDirectory({
        apiBase: args.apiBase,
        appId: args.appId,
        timeoutMs: args.timeoutMs,
        cookie,
        bdstoken: context.bdstoken,
        savePath: args.savePath,
        mode: args.directoryMode
      })
    : null;

  return {
    ok: true,
    cookie,
    directoryPlan,
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
/** 仅对用户明确选中的资源执行网盘保存/转存；此流程会改变用户网盘内容。 */
async function saveSelectedItems(args) {
  const beforeRows = !args.noRename && args.renamePlan.length > 0
    ? await listBaiduDir({
        apiBase: args.apiBase, appId: args.appId, timeoutMs: args.timeoutMs,
        cookie: args.cookie, bdstoken: args.share.bdstoken, dir: args.savePath
      })
    : [];
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
    sekey: args.share.sekey || "",
    selectedItems: args.selectedItems
  });

  let renameResults = [];
  if (!args.noRename && args.renamePlan.length > 0) {
    try {
      const afterRows = await listBaiduDir({
        apiBase: args.apiBase, appId: args.appId, timeoutMs: args.timeoutMs,
        cookie: args.cookie, bdstoken: args.share.bdstoken, dir: args.savePath
      });
      const beforeIds = new Set(beforeRows.map((row) => String(row.fsId)));
      const newlyCreatedRows = afterRows.filter((row) => row.fsId && !beforeIds.has(String(row.fsId)));
      renameResults = await applyBaiduRenamePlan({
        apiBase: args.apiBase, appId: args.appId, timeoutMs: args.timeoutMs,
        cookie: args.cookie, bdstoken: args.share.bdstoken,
        targetRows: newlyCreatedRows, renamePlan: args.renamePlan
      });
    } catch (error) {
      // 转存接口已成功；后处理失败必须保留为可恢复状态，不能让调用方误以为转存失败并重跑。
      renameResults = args.renamePlan.map((item) => ({
        ...item, ok: false, recoverable: true,
        error: `转存已完成，但读取转存结果目录失败：${error.message || String(error)}`
      }));
    }
  }

  const renameFailed = renameResults.some((item) => !item.ok);
  const transferTaskId = transferResponse.task_id || transferResponse.taskid || "";
  const state = transferTaskId
    ? (renameFailed ? "TRANSFER_SUBMITTED_RENAME_PENDING" : "SUBMITTED")
    : (renameFailed ? "SAVED_RENAME_FAILED" : "COMPLETED");
  return {
    ok: !renameFailed,
    state,
    transferResponse,
    selectedItems: args.selectedItems,
    renamePlan: args.renamePlan,
    renameResults
  };
}

/**
 * 仅恢复已存在网盘项目的重命名；不会调用分享转存接口。
 * 首先检查源/目标状态，支持重复执行且不会覆盖同名目标。
 */
async function resumeBaiduRename({
  sourcePath, newName, expectedFsId = "", apiBase = DEFAULT_API_BASE, appId = DEFAULT_APP_ID,
  timeoutMs = DEFAULT_TIMEOUT_MS, cookie, dryRun = false, fetchImpl,
  getTokenImpl = getBaiduBdstoken, listDirImpl = listBaiduDir,
  renamePathImpl = renameBaiduPath, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const source = String(sourcePath || "").trim();
  const targetName = String(newName || "").trim();
  if (!source.startsWith("/") || source.endsWith("/") || source.includes("\\") || source.split("/").includes("..")) {
    throw new Error("sourcePath must be an absolute Baidu path without traversal segments.");
  }
  if (!targetName || targetName === "." || targetName === ".." || /[\\/]/.test(targetName)) {
    throw new Error("rename target must be a single non-empty path segment.");
  }
  const parentPath = path.posix.dirname(source);
  const sourceName = path.posix.basename(source);
  const targetPath = joinCloudPath(parentPath, targetName);
  const bdstoken = await getTokenImpl({ apiBase, timeoutMs, cookie, fetchImpl });
  if (!bdstoken) throw new Error("无法获取百度网盘 bdstoken。");
  const list = () => listDirImpl({ apiBase, appId, timeoutMs, cookie, bdstoken, dir: parentPath, fetchImpl });
  let rows = await list();
  const sourceRow = rows.find((row) => row.name === sourceName);
  const targetRow = rows.find((row) => row.name === targetName);
  const hasSource = Boolean(sourceRow);
  const hasTarget = Boolean(targetRow);
  if (sourceName === targetName && hasSource) {
    return { ok: true, state: "ALREADY_COMPLETED", sourcePath: source, targetPath, newName: targetName, expectedFsId: String(expectedFsId || targetRow?.fsId || "") };
  }
  if (!hasSource && hasTarget) {
    if (expectedFsId && String(targetRow.fsId) === String(expectedFsId)) {
      return { ok: true, state: "ALREADY_COMPLETED", sourcePath: source, targetPath, newName: targetName };
    }
    return { ok: false, state: "TARGET_EXISTS_UNVERIFIED", sourcePath: source, targetPath, newName: targetName, expectedFsId: String(expectedFsId || ""), recoverable: false };
  }
  if (!hasSource) {
    return { ok: false, state: "SOURCE_NOT_FOUND", sourcePath: source, targetPath, newName: targetName, expectedFsId: String(expectedFsId || ""), recoverable: false };
  }
  if (hasTarget) {
    return { ok: false, state: "TARGET_CONFLICT", sourcePath: source, targetPath, newName: targetName, expectedFsId: String(expectedFsId || ""), recoverable: false };
  }
  if (dryRun) {
    return { ok: true, state: "READY_TO_RENAME", sourcePath: source, targetPath, newName: targetName, expectedFsId: String(expectedFsId || sourceRow?.fsId || ""), recoverable: true };
  }

  let renameResponse;
  try {
    renameResponse = await renamePathImpl({
      apiBase, appId, timeoutMs, cookie, bdstoken,
      sourcePath: source, newName: targetName, fetchImpl
    });
  } catch (error) {
    return {
      ok: false, state: "SAVED_RENAME_FAILED", sourcePath: source, targetPath,
      newName: targetName, expectedFsId: String(expectedFsId || sourceRow?.fsId || ""), recoverable: true, error: error.message || String(error)
    };
  }

  const taskId = renameResponse?.taskid || renameResponse?.task_id || "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rows = await list();
      const sourceRemains = rows.some((row) => row.name === sourceName);
      const targetAppeared = rows.some((row) => row.name === targetName);
      if (!sourceRemains && targetAppeared) {
        return { ok: true, state: "COMPLETED", sourcePath: source, targetPath, newName: targetName, expectedFsId: String(expectedFsId || sourceRow?.fsId || ""), taskId };
      }
      if (sourceRemains && targetAppeared) {
        return { ok: false, state: "TARGET_CONFLICT", sourcePath: source, targetPath, newName: targetName, expectedFsId: String(expectedFsId || sourceRow?.fsId || ""), taskId, recoverable: false };
      }
    } catch (error) {
      return {
        ok: false, state: "RENAME_PENDING", sourcePath: source, targetPath,
        newName: targetName, expectedFsId: String(expectedFsId || sourceRow?.fsId || ""), taskId, recoverable: true, error: error.message || String(error)
      };
    }
    if (attempt < 4) await sleepImpl(500);
  }
  return { ok: false, state: "RENAME_PENDING", sourcePath: source, targetPath, newName: targetName, expectedFsId: String(expectedFsId || sourceRow?.fsId || ""), taskId, recoverable: true };
}

function buildBaiduCompactRenameRecovery(result) {
  return {
    ok: Boolean(result.ok), provider: "baidu", mode: "rename_recovery",
    state: result.state, sourcePath: result.sourcePath, targetPath: result.targetPath,
    renameTo: result.newName, expectedFsId: result.expectedFsId || "", taskId: result.taskId || "",
    recoverable: Boolean(result.recoverable), error: result.error || ""
  };
}

/** 解析百度分享 URL 中的分享码、提取码等必要信息。 */
/** 解析输入并返回规范化结果；无法识别的输入应明确报错。 */
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
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
function extractBaiduShareContextFromHtml(html) {
  const text = String(html || "");
  const mergedContext = mergeBaiduShareContexts([
    extractEmbeddedShareIds(text),
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

/** 验证提取码后的分享页会把 yunData 写成变量引用模板，真实 ID 只存在于页面内嵌 JSON 中。 */
function extractEmbeddedShareIds(text) {
  const body = String(text || "");
  const shareId = body.match(/["']?shareid["']?\s*:\s*["']?(\d{5,})["']?/);
  const shareUk = body.match(/["']?share_uk["']?\s*:\s*["']?(\d{5,})["']?/);
  if (!shareId || !shareUk) return null;
  return {
    bdstoken: "",
    shareId: shareId[1],
    shareUk: shareUk[1],
    title: "",
    rootPath: "",
    files: []
  };
}

/** 从页面内嵌 JSON 中提取登录/分享上下文。 */
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
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
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
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
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
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
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
function extractJsObjectProperty(body, key) {
  const pattern = new RegExp(`(?:^|,)\\s*${escapeRegExp(key)}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))`, "s");
  const match = String(body || "").match(pattern);
  if (!match) return "";
  const value = String(match[1] ?? match[2] ?? match[3] ?? "").trim();
  // 未加引号且含成员访问、运算等特征时，这是页面模板代码而非真实数据。
  if (match[1] === undefined && match[2] === undefined && /[^0-9A-Za-z_-]/.test(value)) return "";
  return value;
}

/** 合并页面不同位置提取到的分享上下文。 */
/** 处理 mergeBaiduShareContexts 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
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
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
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
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
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
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
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

/** share/verify 返回的 randsk 已 URL 编码，交给 URLSearchParams 前需先解码，避免二次编码。 */
function decodeBaiduSekey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 构造百度分享转存接口所需参数。 */
/** 构造百度分享转存接口所需的请求数据。 */
function buildBaiduTransferRequest({
  apiBase = DEFAULT_API_BASE,
  appId = DEFAULT_APP_ID,
  bdstoken,
  shareId,
  shareUk,
  savePath,
  sekey = "",
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
    sekey: decodeBaiduSekey(sekey),
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
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */
function buildBaiduRenamePlanForSelection({ args, result, selectedItems }) {
  if (args.noRename) return [];
  return buildBaiduRenamePlan({
    resourceType: args.resourceType, contextName: result.contextName || "",
    shareTitle: result.shareTitle || "", savePath: args.savePath,
    selectedItems, agentRenamePlan: args.agentRenamePlan ?? null
  });
}

function buildBaiduRenamePlan({
  resourceType = "auto", contextName = "", shareTitle = "", savePath = "/",
  selectedItems = [], agentRenamePlan = null
} = {}) {
  const neutralPlan = agentRenamePlan !== null
    ? resolveAgentRenamePlan({ selectedItems, agentRenamePlan })
    : buildResourceRenamePlan({ resourceType, contextName, shareTitle, selectedItems });
  return neutralPlan.map((item) => ({
    sourcePath: joinCloudPath(savePath, selectedItems[item.itemIndex].name),
    originalName: item.originalName, suggestedName: item.suggestedName, reason: item.reason
  }));
}

function resolveBaiduRenamePlan({ selectedItems = [], savePath = "/", agentRenamePlan = [] } = {}) {
  return buildBaiduRenamePlan({ selectedItems, savePath, agentRenamePlan });
}
/** 将renderBaiduShareItemsTable相关结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
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
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
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
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */

function buildBaiduCompactPreview({ args = {}, result }) {
  const selected = result.selectedPreview || parseSelection(result.defaultSelection || args.defaultSelection || "all", result.items || []);
  return {
    ok: true, provider: "baidu", mode: "preview", nextAction: "confirm_before_save",
    ...directoryPlanFields(result.directoryPlan),
    source: args.shareUrl || "", target: result.savePath || args.savePath || "",
    resource: result.contextName || result.shareTitle || "",
    type: result.classification?.type || "unknown",
    selectedItems: selected.map((item) => ({
      rank: item.rank, id: item.fsId, name: item.name, isDir: item.isDir, size: item.size
    })),
    renamePlan: (result.renamePlan || []).map((item, index) => ({
      rank: index + 1, originalName: item.originalName, suggestedName: item.suggestedName
    }))
  };
}
function buildBaiduCompactSave({ args = {}, result, saveResult }) {
  const transfer = saveResult.transferResponse || {};
  const taskId = transfer.task_id || transfer.taskid || "";
  const failures = (saveResult.renameResults || []).filter((item) => !item.ok);
  const state = saveResult.state || (failures.length ? "SAVED_RENAME_FAILED" : (taskId ? "SUBMITTED" : "COMPLETED"));
  return {
    ok: Boolean(saveResult.ok) && failures.length === 0, provider: "baidu", mode: "saved",
    status: state,
    nextAction: state === "SAVED_RENAME_FAILED" ? "resume_rename_without_resaving" : (state === "SUBMITTED" || state === "TRANSFER_SUBMITTED_RENAME_PENDING" ? "check_transfer_task_before_rename" : "continue_workflow"),
    source: args.shareUrl || "", target: result.savePath || args.savePath || "",
    taskId, selectedCount: (saveResult.selectedItems || []).length,
    rename: {
      succeeded: (saveResult.renameResults || []).length - failures.length,
      failed: failures.length,
      failures: failures.map((item) => ({
        name: item.originalName, sourcePath: item.sourcePath || item.expectedSourcePath || "",
        renameTo: item.suggestedName || "", expectedFsId: item.targetFsId || "", recoverable: Boolean(item.recoverable),
        error: item.error || "rename failed"
      }))
    }
  };
}

function buildBaiduSubagentPreview({ args = {}, result }) {
  const selectedItems = result.selectedPreview || parseSelection(result.defaultSelection || args.defaultSelection || "all", result.items || []);
  return {
    ok: true,
    provider: "baidu",
    mode: "preview",
    nextAction: "confirm_before_save",
    ...directoryPlanFields(result.directoryPlan),
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
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */
function buildBaiduSubagentSave({ args = {}, result, saveResult }) {
  return {
    ok: Boolean(saveResult.ok),
    state: saveResult.state || "COMPLETED",
    provider: "baidu",
    mode: "save",
    nextAction: saveResult.state === "SAVED_RENAME_FAILED" ? "resume_rename_without_resaving" : (saveResult.state === "SUBMITTED" || saveResult.state === "TRANSFER_SUBMITTED_RENAME_PENDING" ? "check_transfer_task_before_rename" : "verify_target_path_or_openlist"),
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
/** 将内部对象转换为稳定的输出结构，避免暴露无关字段。 */
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
/** 将内部对象转换为稳定的输出结构，避免暴露无关字段。 */
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
/** 将内部对象转换为稳定的输出结构，避免暴露无关字段。 */
function serializeRenameResults(results) {
  return (results || []).map((item) => ({
    ok: Boolean(item.ok),
    id: item.fid || item.sourcePath || "",
    originalName: item.originalName,
    suggestedName: item.suggestedName,
    reason: item.reason,
    sourcePath: item.sourcePath || item.expectedSourcePath || "",
    expectedFsId: item.targetFsId || "",
    recoverable: Boolean(item.recoverable),
    error: item.error || ""
  }));
}

/** 汇总百度转存接口响应，提取任务结果和错误信息。 */
/** 处理 summarizeBaiduTransferResponse 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function summarizeBaiduTransferResponse(response) {
  return {
    errno: response.errno ?? 0,
    showMsg: response.show_msg || "",
    taskId: response.task_id || response.taskid || ""
  };
}

/** 展示候选资源并收集明确选择；未获得选择时不应擅自保存全部资源。 */
/** 展示候选资源并收集明确选择；未获得用户选择时不得擅自保存全部候选。 */
/** 读取并核验百度分享上下文及可访问性。 */
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
/** 通过只读接口获取百度后续请求需要的 bdstoken。 */
async function getBaiduBdstoken({ apiBase, timeoutMs, cookie, fetchImpl }) {
  const url = new URL("/api/gettemplatevariable", normalizeApiBase(apiBase));
  url.searchParams.set("fields", '["bdstoken"]');
  const response = await fetchBaiduJson(url, {
    timeoutMs,
    cookie,
    fetchImpl,
    referer: normalizeApiBase(apiBase)
  });
  return response.result?.bdstoken || response.bdstoken || "";
}

/** 读取百度分享中的文件列表，不执行转存。 */
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
/** 向百度网盘提交分享转存请求；该操作会在用户网盘中新增文件。 */
async function transferBaiduShare({ apiBase, appId, timeoutMs, cookie, referer, bdstoken, shareId, shareUk, savePath, sekey = "", selectedItems }) {
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
    sekey,
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
/** 通过对应服务接口读取列表数据，不修改远端内容。 */
/**
 * 逐级检查百度保存目录；缺失时按 mode 决定只列出还是创建。
 *
 * 只有"明确的目录不存在"错误才视为缺失，凭据、网络等其它异常一律上抛，
 * 避免因为一次偶发故障而误建目录。
 */
async function planBaiduDirectory({ apiBase, appId, timeoutMs, cookie, bdstoken, savePath, mode = "preview", fetchImpl }) {
  if (!cookie) return null;
  const segments = parseBaiduSavePath(savePath || "/").split("/").filter(Boolean);
  if (segments.length === 0) return null;
  return resolveCloudDirectory({
    segments,
    mode: mode === "create" ? "create" : "preview",
    providerLabel: "百度网盘",
    joinPath: (parentPath, segment) => `${String(parentPath).replace(/\/+$/, "")}/${segment}`,
    placeholder: (parent, segment, pendingPath) => ({ id: null, name: segment, path: pendingPath, pendingCreate: true }),
    listSegment: async (parent, segment) => {
      const dirPath = `${String(parent.path).replace(/\/+$/, "")}/${segment}`;
      try {
        await listBaiduDir({ apiBase, appId, timeoutMs, cookie, bdstoken, dir: dirPath, fetchImpl });
        return { id: dirPath, name: segment, path: dirPath };
      } catch (error) {
        const message = String(error?.message || error);
        if (/Baidu API error (-9|31066)\b|目录不存在|does not exist/i.test(message)) return null;
        throw error;
      }
    },
    createSegment: async (parent, segment, pendingPath) => {
      await createBaiduDirectory({ apiBase, appId, timeoutMs, cookie, bdstoken, dirPath: pendingPath, fetchImpl });
      return { id: pendingPath, name: segment, path: pendingPath };
    }
  });
}

/** 在百度网盘创建单个目录；仅由 create 模式调用。 */
async function createBaiduDirectory({ apiBase, appId, timeoutMs, cookie, bdstoken, dirPath, fetchImpl }) {
  const url = new URL("/api/create", normalizeApiBase(apiBase));
  const query = {
    a: "commit",
    app_id: appId || DEFAULT_APP_ID,
    channel: "chunlei",
    web: "1",
    clienttype: "0",
    bdstoken: bdstoken || ""
  };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const body = new URLSearchParams();
  body.set("path", dirPath);
  body.set("isdir", "1");
  body.set("block_list", "[]");
  await fetchBaiduJson(url, {
    method: "POST",
    body,
    timeoutMs,
    cookie,
    fetchImpl,
    referer: normalizeApiBase(apiBase)
  });
  return { path: dirPath };
}

async function listBaiduDir({ apiBase, appId, timeoutMs, cookie, bdstoken, dir, fetchImpl }) {
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
    fetchImpl,
    referer: normalizeApiBase(apiBase)
  });
  return normalizeBaiduShareItems(response.list || []);
}

/** 按确认后的重命名计划调用百度接口修改网盘文件或目录名称。 */
/** 处理 applyBaiduRenamePlan 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
async function applyBaiduRenamePlan({ apiBase, appId, timeoutMs, cookie, bdstoken, targetRows = [], renamePlan, renamePathImpl = renameBaiduPath, listDirImpl = listBaiduDir, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const results = [];
  const usedIds = new Set();
  for (const item of renamePlan) {
    const extension = path.posix.extname(item.originalName || "");
    const stem = extension ? item.originalName.slice(0, -extension.length) : item.originalName;
    const copyNamePattern = new RegExp("^" + escapeRegExp(stem) + "(?:\\s*\\(\\d+\\))?" + escapeRegExp(extension) + "$", "i");
    const candidates = targetRows.filter((row) => row.fsId && !usedIds.has(String(row.fsId)) && copyNamePattern.test(row.name));
    if (candidates.length !== 1) {
      results.push({ ...item, sourcePath: item.sourcePath, ok: false, recoverable: candidates.length === 0, error: candidates.length
        ? "检测到多个新建候选文件，无法唯一确认本次转存副本，已跳过重命名。"
        : "未能从转存前后目录差异中唯一定位新建副本，已跳过重命名。" });
      continue;
    }
    const matched = candidates[0];
    usedIds.add(String(matched.fsId));
    try {
      const response = await renamePathImpl({ apiBase, appId, timeoutMs, cookie, bdstoken, sourcePath: matched.path, newName: item.suggestedName });
      let verified = false;
      let verifyError = "";
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const currentRows = await listDirImpl({
            apiBase, appId, timeoutMs, cookie, bdstoken,
            dir: path.posix.dirname(matched.path)
          });
          const sourceRemains = currentRows.some((row) => row.name === matched.name);
          const targetAppeared = currentRows.some((row) => row.name === item.suggestedName);
          if (!sourceRemains && targetAppeared) {
            verified = true;
            break;
          }
          if (sourceRemains && targetAppeared) {
            verifyError = "重命名后源名称和目标名称同时存在，检测到冲突。";
            break;
          }
        } catch (error) {
          verifyError = error.message || String(error);
        }
        if (attempt < 9) await sleepImpl(500);
      }
      results.push({
        ...item, targetFsId: matched.fsId, sourcePath: matched.path,
        ok: verified, recoverable: !verified, response,
        ...(verified ? {} : { error: verifyError || "重命名请求已提交，但尚未在目录列表中确认完成。" })
      });
    } catch (error) {
      results.push({ ...item, targetFsId: matched.fsId, sourcePath: matched.path, ok: false, recoverable: true, error: error.message || String(error) });
    }
  }
  return results;
}
/** 调用百度网盘接口重命名指定路径；该函数会改变网盘目录项。 */
/** 处理 renameBaiduPath 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
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
/** 封装网络请求、超时和响应解析；是否改变远端数据由调用的 API 决定。 */
async function fetchBaiduText(url, options = {}) {
  const result = await fetchWithTimeout(url, options);
  const text = await result.response.text();
  if (!result.response.ok) {
    throw new Error(`HTTP ${result.response.status} from ${result.url}: ${text.slice(0, 200)}`);
  }
  return text;
}

/** 发送百度 API 请求并解析 JSON 响应；具体读写属性由调用接口决定。 */
/** 封装网络请求、超时和响应解析；是否改变远端数据由调用的 API 决定。 */
async function fetchBaiduJson(url, options = {}) {
  return (await fetchBaiduJsonWithMeta(url, options)).json;
}

/** 发送百度 API 请求并保留 HTTP 状态、响应头等元数据，供后续兼容性判断。 */
/** 封装网络请求、超时和响应解析；是否改变远端数据由调用的 API 决定。 */
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
/** 执行带超时控制的 HTTP 请求，超时后主动中止请求。 */
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
    const response = await (options.fetchImpl || fetch)(requestUrl, {
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
/** 处理 getSetCookieHeaders 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function getSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  if (typeof headers.get !== "function") return [];
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

/** 合并响应中的 Set-Cookie 字段，形成后续请求可用的 Cookie 字符串。 */
/** 处理 mergeCookieString 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
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
/** 从参数或环境变量中解析 Cookie；不得在日志中回显完整凭证。 */
/** 规范化 API 根地址，清理多余斜杠或补齐所需路径。 */
/** 规范化 API 根地址，清理末尾斜杠或补齐所需路径。 */
function normalizeApiBase(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/g, "");
}

/** 检查网盘路径是否为以斜杠开头且不含路径穿越片段的路径。 */
/** 检查输入是否符合模块要求，返回布尔值供调用方分支处理。 */
function isCloudDrivePath(value) {
  return String(value || "").startsWith("/") && !String(value).includes("..");
}

/** 从路径或目录 URL 中提取百度网盘目标目录路径。 */
/** 解析输入并返回规范化结果；无法识别的输入应明确报错。 */
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
/** 根据已有资源信息生成建议值，不直接修改原始资源。 */
/** 从资源名中提取集数标签，供命名建议使用。 */
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
/** 提取文件扩展名。 */
/** 处理 getExtension 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
/** 移除文件名末尾扩展名。 */
/** 处理 stripExtension 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
/** 清理文件名中不适合用于文件系统/网盘路径的字符。 */
/** 处理 sanitizeFileName 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
/** 处理joinCloudPath相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 joinCloudPath 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function joinCloudPath(basePath, name) {
  const base = String(basePath || "/").replace(/\/+$/g, "") || "/";
  const cleanName = String(name || "").replace(/^\/+/g, "");
  return base === "/" ? `/${cleanName}` : `${base}/${cleanName}`;
}

/** 解析 JSON 参数字符串，遇到格式错误时给出带参数名的提示。 */
/** 解析 JSON 字符串；格式错误时明确抛出异常。 */
/** 处理stringOrEmpty相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 stringOrEmpty 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function stringOrEmpty(value) {
  return value === undefined || value === null ? "" : String(value);
}

/** 处理escapeRegExp相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 escapeRegExp 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把字节数转换为易读的容量单位。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 把时间戳或日期值转换为可读时间文本。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 转义 Markdown 表格单元格中的特殊字符。 */
/** 处理 escapeMarkdownCell 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
/** 清理文本中的换行和多余空白，避免破坏 Markdown 输出。 */
/** 处理 escapeMarkdownText 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
/** 确认模块是直接运行而非被导入，避免导入时触发命令行副作用。 */
/** 判断模块是否由 Node.js 直接执行；被其他模块导入时不自动启动 CLI。 */
function formatTimestamp(value) { return formatTimestampCommon(value, { unixSeconds: true }); }

export {
  applyEnvDefaults,
  buildBaiduRenamePlan,
  buildBaiduSubagentPreview,
  buildBaiduSubagentSave,
  buildBaiduTransferRequest,
  extractBaiduShareContextFromHtml,
  getBaiduBdstoken,
  normalizeBaiduShareItems,
  parseBaiduSavePath,
  parseBaiduShareUrl,
  parseArgs,
  planBaiduDirectory,
  renderBaiduShareItemsTable,
  buildBaiduCompactPreview,
  buildBaiduCompactSave,
  buildBaiduCompactRenameRecovery,
  applyBaiduRenamePlan,
  listBaiduDir,
  renameBaiduPath,
  resumeBaiduRename,
};
