#!/usr/bin/env node
import { askUserSelection, classifyResource, escapeMarkdownCell, escapeMarkdownText, extractEpisodeLabel, formatBytes, formatTimestamp as formatTimestampCommon, getExtension, normalizeContextName, normalizeResourceType, parseJson, parseSelection, resolveCookie, sanitizeFileName, stripExtension, suggestSavedName } from "./cloud-save-common.mjs";
import { buildResourceRenamePlan, resolveAgentRenamePlan, resolveResourceContext } from "./resource-recognition.mjs";
import { loadEnvFile, mergeEnvValues } from "./env-config.mjs";
import { cliArgs, failCli, isCliEntryPoint as isCli } from "./cli-utils.mjs";
import { directoryPlanFields, resolveCloudDirectory, resolveDirectoryMode } from "./cloud-directory.mjs";

/**
 * 解析夸克分享资源、展示候选项并按明确选择保存到用户网盘；保存和重命名属于远端写操作。
 *
 * 本文件说明：函数注释描述职责和关键边界；除注释外不改变既有执行逻辑。
 * 安全约束：任何网盘/NAS 写操作都必须以明确目标和用户授权为前提；预览和查询流程保持只读。
 */

/**
 * 处理夸克分享链接解析、资源选择、保存到用户网盘以及必要的命名整理；其中保存和重命名属于会改变云盘内容的操作。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */



const DEFAULT_API_BASE = "https://drive-pc.quark.cn";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_COOKIE_ENV = "QUARK_COOKIE";
const DEFAULT_ENV_FILE = ".env";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch";

// 仅在直接执行脚本时启动主流程；作为模块导入时不产生网络请求或其他副作用。
  if (isCli(import.meta.url)) {
  main().catch((error) => failCli(error));
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
/** 命令行主入口：解析参数、加载配置、调用核心流程并输出结果。 */
async function main() {
  const args = applyEnvDefaults(parseArgs(cliArgs()));
  args.directoryMode = resolveDirectoryMode(args);
  if (!args.shareUrl || !args.toUrl) {
    printUsage();
    process.exit(2);
  }

  const cookie = resolveCookie(args);
  const result = await prepareQuarkSave({ ...args, cookie });
  const jsonOutput = args.format === "json";

  if (args.dryRun) {
    if (jsonOutput) {
      console.log(JSON.stringify(args.compact ? buildQuarkCompactPreview({ args, result }) : buildQuarkSubagentPreview({ args, result }), null, 2));
    } else {
      console.log(renderShareItemsTable(result));
      console.log("\n--dry-run 已启用：只预览资源和重命名建议，不会调用转存接口。");
    }
    return;
  }

  if (!jsonOutput) {
    console.log(renderShareItemsTable(result));
  }

  if (!cookie) {
    throw new Error(`缺少夸克 Cookie。请设置 ${args.cookieEnv} 环境变量，或使用 --cookie-env 指向你的 Cookie 环境变量。`);
  }
  if (!result.destination?.fid) {
    throw new Error(`夸克保存目录无法解析为 fid：${args.toUrl}。如果使用 /备份资源 这种路径，请确认目录存在且 Cookie 有效。`);
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
    contextName: result.contextName,
    cookie,
    pwdId: result.share.pwdId,
    stoken: result.share.stoken,
    destinationFid: result.destination.fid,
    selectedItems
  });

  if (jsonOutput) {
    console.log(JSON.stringify(args.compact ? buildQuarkCompactSave({ args, result, saveResult }) : buildQuarkSubagentSave({ args, result, saveResult }), null, 2));
  } else {
    console.log(renderSaveSummary(saveResult));
  }
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；未知参数会报错，避免拼写错误被静默忽略。 */
function parseArgs(argv) {
  const parsed = {
    shareUrl: "",
    toUrl: "",
    contextName: "",
    cookieEnv: DEFAULT_COOKIE_ENV,
    envFile: DEFAULT_ENV_FILE,
    apiBase: DEFAULT_API_BASE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    defaultSelection: "all",
    resourceType: "auto",
    agentRenamePlan: null,
    yes: false,
    dryRun: false,
    noRename: false,
    noCreateDir: false,
    format: "markdown",
    compact: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--share-url") {
      parsed.shareUrl = argv[++index] || "";
    } else if (arg === "--to-url" || arg === "--dest-url") {
      parsed.toUrl = argv[++index] || "";
    } else if (arg === "--context-name" || arg === "--resource-name") {
      parsed.contextName = argv[++index] || "";
    } else if (arg === "--cookie-env") {
      parsed.cookieEnv = argv[++index] || DEFAULT_COOKIE_ENV;
    } else if (arg === "--env-file") {
      parsed.envFile = argv[++index] || DEFAULT_ENV_FILE;
    } else if (arg === "--api-base") {
      parsed.apiBase = argv[++index] || DEFAULT_API_BASE;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
    } else if (arg === "--select") {
      parsed.defaultSelection = argv[++index] || "all";
    } else if (arg === "--resource-type") {
      parsed.resourceType = normalizeResourceType(argv[++index] || "auto");
    } else if (arg === "--rename-plan-json") {
      parsed.agentRenamePlan = parseJson(argv[++index], "--rename-plan-json");
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
    } else if (!parsed.toUrl) {
      parsed.toUrl = arg;
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
  return {
    ...args,
    env,
    toUrl: args.toUrl || env.QUARK_DEFAULT_SAVE_URL || ""
  };
}

/** 读取指定 .env 文件并解析键值；不会改写文件。 */
/** 读取并解析 .env 文件；不会创建或修改配置文件。 */

/** 处理printUsage相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 printUsage 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function printUsage() {
  console.error("Usage: node scripts/quark-save.mjs <share-url> <destination-folder-url> [options]");
  console.error("Options:");
  console.error("  --context-name \"资源名\"       用上下文资源名修正保存后的文件名");
  console.error("  --resource-type auto|series|movie|collection");
  console.error("  --rename-plan-json '[{\"rank\":1,\"name\":\"修正名\",\"reason\":\"Agent 判断\"}]'");
  console.error("  --env-file .env                从 ENV 文件读取默认保存目录和 Cookie");
  console.error("  --cookie-env QUARK_COOKIE      从指定环境变量读取夸克 Cookie");
  console.error("  --select all|1,3|2-5           默认选择，交互确认时可覆盖");
  console.error("  --yes                          跳过确认，直接使用 --select");
  console.error("  --dry-run                      只列资源和命名建议，不转存");
  console.error("  --no-rename                    转存后不执行重命名修正");
  console.error("  --no-create-dir                不自动创建缺失的保存目录，保持旧行为");
}

/** 解析夸克分享资源并生成可供人工选择的预览；此阶段以读取和准备为主。 */
/** 解析夸克分享链接、读取分享条目并生成待用户审阅的资源预览。 */
async function prepareQuarkSave(args) {
  const share = parseQuarkShareUrl(args.shareUrl);
  const destination = await resolveQuarkDestination({
    apiBase: args.apiBase,
    timeoutMs: args.timeoutMs,
    cookie: args.cookie,
    value: args.toUrl,
    mode: args.directoryMode || "strict"
  });
  const tokenResponse = await getShareToken({
    apiBase: args.apiBase,
    timeoutMs: args.timeoutMs,
    pwdId: share.pwdId,
    passcode: share.passcode
  });
  const stoken = tokenResponse.data?.stoken;
  if (!stoken) {
    throw new Error(`无法获取分享 stoken：${tokenResponse.message || "分享可能失效或需要提取码"}`);
  }

  const detailResponse = await listShareItems({
    apiBase: args.apiBase,
    timeoutMs: args.timeoutMs,
    pwdId: share.pwdId,
    stoken,
    pdirFid: share.pdirFid
  });
  const items = normalizeShareItems(detailResponse.data?.list || []);
  const shareTitle = tokenResponse.data?.title || "";
  const resourceContext = resolveResourceContext({
    resourceType: args.resourceType,
    contextName: args.contextName || shareTitle,
    shareTitle,
    items
  });
  const contextName = resourceContext.canonicalName;
  const classification = resourceContext.classification;
  const selectedItems = parseSelection(args.defaultSelection, items);
  const renamePlan = args.agentRenamePlan
    ? resolveRenamePlan({
        selectedItems,
        savedFids: selectedItems.map((item) => item.fid),
        agentRenamePlan: args.agentRenamePlan
      })
    : buildRenamePlan({
        resourceType: args.resourceType,
        contextName,
        shareTitle: tokenResponse.data?.title || "",
        selectedItems,
        savedFids: selectedItems.map((item) => item.fid)
      });

  return {
    ok: true,
    share: {
      ...share,
      stoken,
      title: tokenResponse.data?.title || ""
    },
    destination,
    shareTitle,
    contextName,
    classification,
    items,
    defaultSelection: args.defaultSelection,
    selectedPreview: selectedItems,
    renamePlan
  };
}

/** 根据用户明确选择的资源执行网盘保存；这是会修改个人网盘内容的操作。 */
/** 仅对用户明确选中的资源执行网盘保存/转存；此流程会改变用户网盘内容。 */
async function saveSelectedItems(args) {
  const payload = buildSavePayload({
    pwdId: args.pwdId,
    stoken: args.stoken,
    destinationFid: args.destinationFid,
    selectedItems: args.selectedItems
  });
  const saveResponse = await postSave({
    apiBase: args.apiBase,
    timeoutMs: args.timeoutMs,
    cookie: args.cookie,
    payload
  });
  const taskId = saveResponse.data?.task_id;
  if (!taskId) {
    throw new Error(`转存接口未返回 task_id：${saveResponse.message || JSON.stringify(saveResponse).slice(0, 200)}`);
  }

  const task = await queryTask({
    apiBase: args.apiBase,
    timeoutMs: args.timeoutMs,
    cookie: args.cookie,
    taskId
  });
  const savedFids = task.data?.save_as?.save_as_top_fids || [];
  const renamePlan = args.noRename
    ? []
    : args.agentRenamePlan
      ? resolveRenamePlan({
          selectedItems: args.selectedItems,
          savedFids,
          agentRenamePlan: args.agentRenamePlan
        })
      : buildRenamePlan({
          resourceType: args.resourceType,
          contextName: args.contextName || "",
          shareTitle: "",
          selectedItems: args.selectedItems,
          savedFids
        });
  const renameResults = args.noRename
    ? []
    : await applyRenamePlan({
        apiBase: args.apiBase,
        timeoutMs: args.timeoutMs,
        cookie: args.cookie,
        renamePlan
      });

  return {
    ok: true,
    taskId,
    task,
    selectedItems: args.selectedItems,
    savedFids,
    renamePlan,
    renameResults
  };
}

/** 解析夸克分享链接中的分享标识和访问参数。 */
/** 解析输入并返回规范化结果；无法识别的输入应明确报错。 */
function parseQuarkShareUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Quark share URL: ${value}`);
  }
  const match = parsed.pathname.match(/\/s\/([^/?#]+)/);
  if (!match) throw new Error(`Quark share URL must include /s/<share-id>: ${value}`);

  return {
    pwdId: match[1],
    passcode: parsed.searchParams.get("pwd") || parsed.searchParams.get("passcode") || "",
    pdirFid: extractFidFromHash(parsed.hash, "share") || "0"
  };
}

/** 解析夸克文件夹 URL 或路径中的目标目录信息。 */
/** 解析输入并返回规范化结果；无法识别的输入应明确报错。 */
function parseQuarkFolderUrl(value) {
  const text = String(value || "").trim();
  if (isCloudDrivePath(text)) {
    return {
      fid: "",
      name: getCloudPathBasename(text),
      path: normalizeCloudDrivePath(text),
      inputType: "path",
      needsResolution: true
    };
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid Quark folder URL: ${value}`);
  }
  const fid = extractFidFromHash(parsed.hash, "all");
  if (!fid) throw new Error(`Destination folder URL must include /list/all/<fid-name>: ${value}`);
  const name = extractNameFromHash(parsed.hash, fid);
  return { fid, name: name || fid };
}

/** 解析用户配置的夸克保存目标，确认可用于后续保存操作。 */
/** 解析并确认路径、配置或计划，供后续步骤使用。 */
async function resolveQuarkDestination({ apiBase, timeoutMs, cookie, value, mode = "strict" }) {
  const parsed = parseQuarkFolderUrl(value);
  if (!parsed.needsResolution) return { ...parsed, directoryPlan: null };
  if (!cookie) return { ...parsed, directoryPlan: null };
  const plan = await resolveQuarkFolderPath({
    apiBase,
    timeoutMs,
    cookie,
    targetPath: parsed.path,
    mode
  });
  return {
    ...parsed,
    ...plan.folder,
    needsResolution: false,
    directoryPlan: plan
  };
}

/** 逐层读取夸克目录并解析目标路径对应的文件夹 ID。 */
/** 解析并确认路径、配置或计划，供后续步骤使用。 */
async function resolveQuarkFolderPath({ apiBase, timeoutMs, cookie, targetPath, mode = "strict", fetchImpl }) {
  const segments = splitCloudDrivePath(normalizeCloudDrivePath(targetPath));
  return resolveCloudDirectory({
    segments,
    mode,
    providerLabel: "夸克网盘",
    joinPath: (parentPath, segment) => joinCloudPath(parentPath, segment),
    placeholder: (parent, segment, pendingPath) => ({
      id: null, fid: null, name: segment, path: pendingPath, pendingCreate: true
    }),
    listSegment: async (parent, segment) => {
      const items = await listQuarkFolderItems({ apiBase, timeoutMs, cookie, pdirFid: parent.fid || "0", fetchImpl });
      const match = items.find((item) => item.isDir && item.name === segment);
      if (!match) return null;
      return {
        id: match.fid,
        fid: match.fid,
        name: match.name,
        path: joinCloudPath(parent.path || "/", match.name)
      };
    },
    createSegment: async (parent, segment, pendingPath) => {
      const response = await fetchQuarkJson(`${normalizeApiBase(apiBase)}/1/clouddrive/file`, {
        method: "POST",
        timeoutMs,
        cookie,
        fetchImpl,
        query: { pr: "ucpro", fr: "pc", uc_param_str: "" },
        body: {
          pdir_fid: parent.fid || "0",
          file_name: segment,
          dir_path: "",
          dir_init_lock: false
        }
      });
      const fid = response?.data?.fid;
      if (!fid) throw new Error(`夸克创建目录未返回 fid：${pendingPath}`);
      return { id: fid, fid, name: segment, path: pendingPath };
    }
  });
}

/** 读取夸克网盘指定文件夹的项目列表。 */
/** 通过对应服务接口读取列表数据，不修改远端内容。 */
async function listQuarkFolderItems({ apiBase, timeoutMs, cookie, pdirFid, fetchImpl }) {
  const response = await fetchQuarkJson(`${normalizeApiBase(apiBase)}/1/clouddrive/file/sort`, {
    method: "GET",
    timeoutMs,
    cookie,
    fetchImpl,
    query: {
      pr: "ucpro",
      fr: "pc",
      uc_param_str: "",
      pdir_fid: pdirFid || "0",
      _page: "1",
      _size: "200",
      _fetch_total: "1",
      _fetch_sub_dirs: "0",
      _sort: "file_type:asc,updated_at:desc"
    }
  });
  return normalizeShareItems(response.data?.list || []);
}

/** 检查网盘路径是否为以斜杠开头且不含路径穿越片段的路径。 */
/** 检查输入是否符合模块要求，返回布尔值供调用方分支处理。 */
function isCloudDrivePath(value) {
  return String(value || "").startsWith("/") && !String(value).includes("..");
}

/** 规范化CloudDrivePath数据，统一字段、格式和默认值，降低上游接口差异对后续流程的影响。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
function normalizeCloudDrivePath(value) {
  const parts = splitCloudDrivePath(value);
  return `/${parts.join("/")}`;
}

/** 将网盘路径拆分为有效目录层级。 */
/** 处理 splitCloudDrivePath 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function splitCloudDrivePath(value) {
  return String(value || "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 从网盘路径中提取最后一级目录/文件名。 */
/** 处理 getCloudPathBasename 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function getCloudPathBasename(value) {
  const parts = splitCloudDrivePath(value);
  return parts.at(-1) || "/";
}

/** 处理joinCloudPath相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 joinCloudPath 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function joinCloudPath(basePath, name) {
  const base = normalizeCloudDrivePath(basePath || "/");
  const cleanName = String(name || "").replace(/^\/+/g, "");
  return base === "/" ? `/${cleanName}` : `${base}/${cleanName}`;
}

/** 从夸克文件夹 URL 的 hash 中提取文件夹 ID。 */
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
function extractFidFromHash(hash, scope) {
  const decoded = safeDecode(hash || "");
  const match = decoded.match(new RegExp(`/list/${scope}/([a-zA-Z0-9]{16,64})(?:-|/|$)`));
  return match ? match[1] : "";
}

/** 从夸克文件夹 URL 的 hash 中提取文件夹名称。 */
/** 从原始文本、URL 或接口响应中提取所需字段，供后续校验和处理。 */
function extractNameFromHash(hash, fid) {
  const decoded = safeDecode(hash || "");
  const marker = `${fid}-`;
  const markerIndex = decoded.indexOf(marker);
  if (markerIndex === -1) return "";
  return decoded.slice(markerIndex + marker.length).split("/")[0].trim();
}

/** 安全解码 URL 编码文本；遇到非法编码时避免整个解析流程崩溃。 */
/** 处理 safeDecode 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 规范化ShareItems数据，统一字段、格式和默认值，降低上游接口差异对后续流程的影响。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
function normalizeShareItems(rows) {
  return (rows || []).map((row, index) => {
    const isDir = Boolean(row.dir);
    return {
      rank: index + 1,
      fid: row.fid,
      shareFidToken: row.share_fid_token,
      name: row.file_name || row.file_name_re || row.name || "未命名资源",
      isDir,
      typeLabel: isDir ? "文件夹" : "文件",
      size: Number(row.size || 0),
      sizeLabel: isDir ? "-" : formatBytes(Number(row.size || 0)),
      itemCount: isDir ? Number(row.include_items || row.file_count || 0) || null : null,
      updatedAt: row.updated_at || row.l_updated_at || row.created_at || row.l_created_at || null,
      updatedAtLabel: formatTimestamp(row.updated_at || row.l_updated_at || row.created_at || row.l_created_at),
      raw: row
    };
  });
}

/** 检查或分类classifyResource相关输入，返回明确状态供主流程决定下一步动作。 */
/** 处理 classifyResource 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
/** 为候选资源生成建议名称和重命名计划。 */
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */
function buildRenamePlan({ resourceType = "auto", contextName = "", shareTitle = "", selectedItems = [], savedFids = [] } = {}) {
  return buildResourceRenamePlan({ resourceType, contextName, shareTitle, selectedItems }).flatMap((item) => {
    const fid = savedFids[item.itemIndex];
    return fid ? [{ fid, originalName: item.originalName, suggestedName: item.suggestedName, reason: item.reason }] : [];
  });
}

function resolveRenamePlan({ selectedItems = [], savedFids = [], agentRenamePlan = [] } = {}) {
  return resolveAgentRenamePlan({ selectedItems, agentRenamePlan }).flatMap((item) => {
    const fid = savedFids[item.itemIndex];
    return fid ? [{ fid, originalName: item.originalName, suggestedName: item.suggestedName, reason: item.reason }] : [];
  });
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
/** 规范化ContextName数据，统一字段、格式和默认值，降低上游接口差异对后续流程的影响。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
/** 规范化资源类型标识，避免不同输入使用不一致的值。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
/** 解析 JSON 参数字符串，遇到格式错误时给出带参数名的提示。 */
/** 解析 JSON 字符串；格式错误时明确抛出异常。 */
/** 解析用户选择的序号/范围，并转换为可处理的条目集合。 */
/** 解析输入并返回规范化结果；无法识别的输入应明确报错。 */
/** 构造提交给网盘保存接口的请求数据。 */
/** 构造提交给网盘保存接口的请求参数。 */
function buildSavePayload({ pwdId, stoken, destinationFid, selectedItems }) {
  return {
    fid_list: selectedItems.map((item) => item.fid),
    fid_token_list: selectedItems.map((item) => item.shareFidToken),
    to_pdir_fid: destinationFid,
    pwd_id: pwdId,
    stoken,
    pdir_fid: "0",
    scene: "link"
  };
}

/** 将renderShareItemsTable相关结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
function renderShareItemsTable({
  shareTitle = "",
  contextName = "",
  destinationName = "",
  destination = null,
  items = [],
  classification,
  renamePlan = []
}) {
  const detected = classification || classifyResource({ contextName, shareTitle, items });
  const targetName = destinationName || destination?.name || "";
  const lines = [
    "### 夸克分享资源",
    "",
    `分享标题：${escapeMarkdownText(shareTitle || "-")}`,
    `修正资源名：${escapeMarkdownText(contextName || "-")}`,
    `目标目录：${escapeMarkdownText(targetName || "-")}`,
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
    "### 夸克转存结果",
    "",
    `任务 ID：${saveResult.taskId}`,
    `已选择：${saveResult.selectedItems.length} 项`,
    `保存后的顶层 fid：${saveResult.savedFids.length > 0 ? saveResult.savedFids.join(", ") : "-"}`
  ];
  if (saveResult.renameResults.length > 0) {
    lines.push("", "重命名修正：");
    saveResult.renameResults.forEach((item) => {
      lines.push(`- ${item.ok ? "成功" : "失败"}：${item.originalName} -> ${item.suggestedName}${item.error ? `（${item.error}）` : ""}`);
    });
  }
  return lines.join("\n");
}

/** 生成供自动化代理展示的夸克资源预览，不执行保存。 */
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */

function buildQuarkCompactPreview({ args = {}, result }) {
  const selected = result.selectedPreview || parseSelection(result.defaultSelection || args.defaultSelection || "all", result.items || []);
  return {
    ok: true, provider: "quark", mode: "preview", nextAction: "confirm_before_save",
    ...directoryPlanFields(result.destination?.directoryPlan),
    source: args.shareUrl || "", target: args.toUrl || "",
    resource: result.contextName || result.shareTitle || "",
    type: result.classification?.type || "unknown",
    selectedItems: selected.map((item) => ({
      rank: item.rank, id: item.fid, name: item.name, isDir: item.isDir, size: item.size
    })),
    renamePlan: (result.renamePlan || []).map((item, index) => ({
      rank: index + 1, originalName: item.originalName, suggestedName: item.suggestedName
    }))
  };
}
function buildQuarkCompactSave({ args = {}, saveResult }) {
  const failures = (saveResult.renameResults || []).filter((item) => !item.ok);
  const taskStatus = Number(saveResult.task?.data?.status);
  const transferSucceeded = taskStatus === 2;
  const transferFailed = taskStatus === 3 || taskStatus === 4;
  const status = transferSucceeded ? "SUCCEEDED" : transferFailed ? "FAILED" : "UNKNOWN";
  return {
    ok: transferSucceeded && failures.length === 0, provider: "quark", mode: "saved", status,
    source: args.shareUrl || "", target: args.toUrl || "", taskId: saveResult.taskId || "",
    selectedCount: (saveResult.selectedItems || []).length,
    rename: {
      succeeded: (saveResult.renameResults || []).length - failures.length,
      failed: failures.length,
      failures: failures.map((item) => ({ name: item.originalName, error: item.error || "rename failed" }))
    }
  };
}

function buildQuarkSubagentPreview({ args = {}, result }) {
  const selectedItems = result.selectedPreview || parseSelection(result.defaultSelection || args.defaultSelection || "all", result.items || []);
  return {
    ok: true,
    provider: "quark",
    mode: "preview",
    nextAction: "confirm_before_save",
    ...directoryPlanFields(result.destination?.directoryPlan),
    source: {
      shareUrl: args.shareUrl || "",
      shareId: result.share?.pwdId || "",
      passcodePresent: Boolean(result.share?.passcode)
    },
    target: {
      provider: "quark",
      pathOrUrl: args.toUrl || "",
      fid: result.destination?.fid || "",
      name: result.destination?.name || ""
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
      selectedItems: selectedItems.map(serializeQuarkItem)
    },
    items: (result.items || []).map(serializeQuarkItem),
    renamePlan: serializeRenamePlan(result.renamePlan || []),
    confirmation: {
      source: args.shareUrl || "",
      selectedItems: selectedItems.map(serializeQuarkItem),
      target: {
        provider: "quark",
        pathOrUrl: args.toUrl || "",
        name: result.destination?.name || ""
      },
      finalNaming: serializeRenamePlan(result.renamePlan || []),
      commandHint: "Re-run scripts/quark-save.mjs with --yes after the user confirms this payload."
    }
  };
}

/** 构造夸克保存动作所需的参数和结果结构。 */
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */
function buildQuarkSubagentSave({ args = {}, result, saveResult }) {
  return {
    ok: true,
    provider: "quark",
    mode: "save",
    nextAction: "verify_in_openlist_or_report_saved",
    source: {
      shareUrl: args.shareUrl || "",
      shareId: result.share?.pwdId || "",
      passcodePresent: Boolean(result.share?.passcode)
    },
    target: {
      provider: "quark",
      pathOrUrl: args.toUrl || "",
      fid: result.destination?.fid || "",
      name: result.destination?.name || ""
    },
    resource: {
      shareTitle: result.shareTitle || "",
      canonicalName: result.contextName || "",
      type: result.classification?.type || "unknown",
      label: result.classification?.label || "",
      isSeries: Boolean(result.classification?.isSeries),
      reason: result.classification?.reason || ""
    },
    selectedItems: (saveResult.selectedItems || []).map(serializeQuarkItem),
    taskId: saveResult.taskId || "",
    savedFids: saveResult.savedFids || [],
    renamePlan: serializeRenamePlan(saveResult.renamePlan || []),
    renameResults: serializeRenameResults(saveResult.renameResults || [])
  };
}

/** 将夸克资源对象转换为稳定、可输出的字段集合。 */
/** 将内部对象转换为稳定的输出结构，避免暴露无关字段。 */
function serializeQuarkItem(item) {
  return {
    rank: item.rank,
    id: item.fid,
    name: item.name,
    typeLabel: item.typeLabel,
    isDir: item.isDir,
    size: item.size,
    sizeLabel: item.sizeLabel,
    itemCount: item.itemCount,
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
    error: item.error || ""
  }));
}

/** 展示候选资源并收集明确选择；未获得选择时不应擅自保存全部资源。 */
/** 展示候选资源并收集明确选择；未获得用户选择时不得擅自保存全部候选。 */
/** 处理 getShareToken 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
async function getShareToken({ apiBase, timeoutMs, pwdId, passcode }) {
  return fetchQuarkJson(`${normalizeApiBase(apiBase)}/1/clouddrive/share/sharepage/token`, {
    method: "POST",
    timeoutMs,
    body: { pwd_id: pwdId, passcode },
    query: { pr: "ucpro", fr: "pc", uc_param_str: "" }
  });
}

/** 读取夸克分享文件列表，不执行保存。 */
/** 读取夸克分享中的文件列表，不执行保存。 */
async function listShareItems({ apiBase, timeoutMs, pwdId, stoken, pdirFid }) {
  const allItems = [];
  let page = 1;
  let lastResponse = null;
  while (true) {
    lastResponse = await fetchQuarkJson(`${normalizeApiBase(apiBase)}/1/clouddrive/share/sharepage/detail`, {
      method: "GET",
      timeoutMs,
      query: {
        pr: "ucpro",
        fr: "pc",
        uc_param_str: "",
        pwd_id: pwdId,
        stoken,
        pdir_fid: pdirFid || "0",
        force: "0",
        _page: String(page),
        _size: String(DEFAULT_PAGE_SIZE),
        _fetch_banner: "0",
        _fetch_share: "0",
        _fetch_total: "1",
        _sort: "file_type:asc,updated_at:desc",
        ver: "2"
      }
    });
    const items = lastResponse.data?.list || [];
    allItems.push(...items);
    const total = Number(lastResponse.metadata?._total || allItems.length);
    if (items.length === 0 || allItems.length >= total) break;
    page += 1;
  }
  return {
    ...lastResponse,
    data: {
      ...(lastResponse?.data || {}),
      list: allItems
    }
  };
}

/** 向夸克网盘提交分享资源保存请求；这是会改变用户网盘内容的操作。 */
/** 向夸克网盘提交保存请求；该操作会改变用户网盘内容。 */
async function postSave({ apiBase, timeoutMs, cookie, payload }) {
  return fetchQuarkJson(`${normalizeApiBase(apiBase)}/1/clouddrive/share/sharepage/save`, {
    method: "POST",
    timeoutMs,
    cookie,
    body: payload,
    query: buildMutationQuery()
  });
}

/** 查询夸克保存任务的执行状态。 */
/** 查询网盘保存任务状态，不代表文件已完成后续 NAS 复制。 */
async function queryTask({ apiBase, timeoutMs, cookie, taskId }) {
  let retryIndex = 0;
  while (retryIndex < 120) {
    const response = await fetchQuarkJson(`${normalizeApiBase(apiBase)}/1/clouddrive/task`, {
      method: "GET",
      timeoutMs,
      cookie,
      query: {
        ...buildMutationQuery(),
        task_id: taskId,
        retry_index: String(retryIndex)
      }
    });
    if (response.data?.status === 2) return response;
    if (response.data?.status === 3 || response.data?.status === 4) {
      throw new Error(`转存任务失败：${response.data?.fail_msg || response.data?.message || JSON.stringify(response.data).slice(0, 200)}`);
    }
    retryIndex += 1;
    await delay(500);
  }
  throw new Error(`等待转存任务超时：${taskId}`);
}

/** 按确认后的重命名计划调用网盘接口修改文件或目录名称；执行前应核对计划。 */
/** 按已确认的重命名计划调用网盘接口修改名称；执行前应核对资源和目标名称。 */
async function applyRenamePlan({ apiBase, timeoutMs, cookie, renamePlan }) {
  const results = [];
  for (const item of renamePlan) {
    try {
      const response = await fetchQuarkJson(`${normalizeApiBase(apiBase)}/1/clouddrive/file/rename`, {
        method: "POST",
        timeoutMs,
        cookie,
        body: {
          fid: item.fid,
          file_name: item.suggestedName
        },
        query: { pr: "ucpro", fr: "pc", uc_param_str: "" }
      });
      results.push({ ...item, ok: true, response });
    } catch (error) {
      results.push({ ...item, ok: false, error: error.message || String(error) });
    }
  }
  return results;
}

/** 发送夸克 API 请求并解析 JSON 响应；具体读写属性由调用接口决定。 */
/** 封装网络请求、超时和响应解析；是否改变远端数据由调用的 API 决定。 */
async function fetchQuarkJson(url, options = {}) {
  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries(options.query || {})) {
    requestUrl.searchParams.set(key, String(value));
  }
  // 为本次请求设置可中止控制器，避免网络无响应时脚本无限等待。
  const controller = new AbortController();
  // 请求超时后主动中止底层 fetch；finally 中会清理定时器。
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const headers = {
      Accept: "application/json",
      "User-Agent": USER_AGENT
    };
    if (options.method === "POST") headers["Content-Type"] = "application/json";
    if (options.cookie) headers.Cookie = options.cookie;
    const response = await (options.fetchImpl || fetch)(requestUrl, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Expected JSON from ${requestUrl}, got: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${requestUrl}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    if (json && typeof json === "object" && "code" in json && json.code !== 0) {
      throw new Error(`Quark API error ${json.code}: ${json.message || json.status || "unknown error"}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

/** 构造MutationQuery所需的数据结构或执行计划；除非函数说明明确涉及执行，否则只准备数据、不提交远端变更。 */
/** 构造后续流程使用的数据结构或执行计划；本函数只准备数据，不应隐式执行写入。 */
function buildMutationQuery() {
  return {
    pr: "ucpro",
    fr: "pc",
    uc_param_str: "",
    app: "clouddrive",
    __dt: String(Math.floor(60_000 + Math.random() * 240_000)),
    __t: String(Date.now())
  };
}

/** 从参数或环境变量中解析网盘 Cookie；避免在输出中回显完整凭证。 */
/** 从参数或环境变量中解析 Cookie；不得在日志中回显完整凭证。 */
/** 规范化 API 根地址，清理多余斜杠或补齐所需路径。 */
/** 规范化 API 根地址，清理末尾斜杠或补齐所需路径。 */
function normalizeApiBase(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/g, "");
}

/** 把字节数转换为易读的容量单位。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 把时间戳或日期值转换为可读时间文本。 */
/** 将处理结果转换为便于用户阅读的文本或结构化输出，不执行数据变更。 */
/** 转义 Markdown 表格单元格中的特殊字符。 */
/** 处理 escapeMarkdownCell 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
/** 清理文本中的换行和多余空白，避免破坏 Markdown 输出。 */
/** 处理 escapeMarkdownText 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
/** 异步等待指定时间，通常用于请求重试间隔。 */
/** 等待指定时间，通常用于请求重试间隔。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 确认模块是直接运行而非被导入，避免导入时触发命令行副作用。 */
/** 判断模块是否由 Node.js 直接执行；被其他模块导入时不自动启动 CLI。 */
function formatTimestamp(value) { return formatTimestampCommon(value); }

export {
  applyEnvDefaults,
  buildQuarkSubagentPreview,
  buildQuarkSubagentSave,
  buildRenamePlan,
  buildSavePayload,
  classifyResource,
  normalizeShareItems,
  normalizeContextName,
  parseQuarkFolderUrl,
  parseQuarkShareUrl,
  parseArgs,
  parseSelection,
  resolveQuarkFolderPath,
  resolveRenamePlan,
  renderShareItemsTable,
  buildQuarkCompactPreview,
  buildQuarkCompactSave,
};
