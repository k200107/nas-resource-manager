#!/usr/bin/env node

/**
 * 通过 OpenList API 预览并发起 NAS/存储复制任务，跟踪复制状态；复制会写入目标存储。
 *
 * 本文件说明：函数注释描述职责和关键边界；除注释外不改变既有执行逻辑。
 * 安全约束：任何网盘/NAS 写操作都必须以明确目标和用户授权为前提；预览和查询流程保持只读。
 */

/**
 * 通过 OpenList API 发起 NAS/存储复制任务并跟踪完成情况；复制会写入目标存储，运行前必须确认目标路径。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */


import { loadEnvFile, mergeEnvValues } from "./env-config.mjs";
import { cliArgs, failCli, isCliEntryPoint } from "./cli-utils.mjs";
import { requestOpenListJson, isOpenListSuccess as isOpenListResponseSuccess } from "./openlist-client.mjs";

const DEFAULT_ENV_FILE = ".env";
const DEFAULT_TIMEOUT_MS = 20_000;

// 仅在直接执行脚本时启动主流程；作为模块导入时不产生网络请求或其他副作用。
  if (isCliEntryPoint(import.meta.url)) {
  main().catch((error) => failCli(error));
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
/** 命令行主入口：解析参数、加载配置、调用核心流程并输出结果。 */
async function main() {
  const args = parseArgs(cliArgs());
  const env = mergeEnvValues(loadEnvFile(args.envFile).values, process.env);
  const result = await runOpenListCopy({
    env,
    args,
    fetchImpl: globalThis.fetch
  });

  if (args.format === "text") {
    console.log(formatCopyResult(result));
  } else {
    const output = args.compact ? toCompactCopyResult(result) : result;
    console.log(args.compact ? JSON.stringify(output) : JSON.stringify(output, null, 2));
  }

  if (!result.ok) process.exit(1);
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；未知参数会报错，避免拼写错误被静默忽略。 */
function parseArgs(argv) {
  const parsed = {
    srcDir: "",
    dstDir: "",
    names: [],
    envFile: DEFAULT_ENV_FILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: 2_000,
    pollTimeoutMs: 120_000,
    poll: true,
    yes: false,
    format: "json",
    compact: false,
    sourceItemPath: "",
    baseUrl: "",
    token: ""
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--src-dir" || arg === "--source") {
      parsed.srcDir = argv[++index] || "";
    } else if (arg === "--dst-dir" || arg === "--dest" || arg === "--target") {
      parsed.dstDir = argv[++index] || "";
    } else if (arg === "--name") {
      parsed.names.push(argv[++index] || "");
    } else if (arg === "--names") {
      parsed.names.push(...parseList(argv[++index] || ""));
    } else if (arg === "--env-file" || arg === "--dotenv" || arg === "--config") {
      parsed.envFile = argv[++index] || DEFAULT_ENV_FILE;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
    } else if (arg === "--interval-ms") {
      parsed.intervalMs = Number(argv[++index] || DEFAULT_INTERVAL_MS);
    } else if (arg === "--poll-timeout-ms") {
      parsed.pollTimeoutMs = Number(argv[++index] || DEFAULT_POLL_TIMEOUT_MS);
    } else if (arg === "--no-poll") {
      parsed.poll = false;
    } else if (arg === "--poll") {
      parsed.poll = true;
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (arg === "--source-item-path") {
      parsed.sourceItemPath = argv[++index] || "";
    } else if (arg === "--compact") {
      parsed.compact = true;
    } else if (arg === "--json") {
      parsed.format = "json";
    } else if (arg === "--format") {
      parsed.format = argv[++index] || "json";
    } else if (arg === "--base-url") {
      parsed.baseUrl = argv[++index] || "";
    } else if (arg === "--token") {
      parsed.token = argv[++index] || "";
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (!parsed.srcDir && positionals[0]) parsed.srcDir = positionals[0];
  if (!parsed.dstDir && positionals[1]) parsed.dstDir = positionals[1];
  if (parsed.names.length === 0 && positionals.length > 2) parsed.names.push(...positionals.slice(2));
  parsed.names = parsed.names.map((name) => String(name || "").trim()).filter(Boolean);
  if (parsed.sourceItemPath) {
    if (parsed.srcDir || parsed.names.length > 0) {
      throw new Error("--source-item-path cannot be combined with --src-dir/--source or --name/--names/positional item names.");
    }
    const itemPath = normalizeOpenListPath(parsed.sourceItemPath);
    if (!itemPath || itemPath === "/") throw new Error("--source-item-path must identify a file or directory, not the OpenList root.");
    const separator = itemPath.lastIndexOf("/");
    parsed.srcDir = separator <= 0 ? "/" : itemPath.slice(0, separator);
    parsed.names = [itemPath.slice(separator + 1)];
  }
  return parsed;
}

/** 组织复制流程：校验参数、读取源信息、发起复制并返回任务结果。 */
/** 组织 OpenList 复制流程，完成参数检查、源/目标预览、确认门槛和任务提交。 */
async function runOpenListCopy({ env = {}, args = {}, fetchImpl = globalThis.fetch }) {
  const srcDir = normalizeOpenListPath(args.srcDir);
  const dstDir = normalizeOpenListPath(args.dstDir || env.OPENLIST_DEFAULT_COPY_DST_PATH);
  const names = (args.names || []).map((name) => String(name || "").trim()).filter(Boolean);
  const context = buildOpenListContext(env, args, fetchImpl);

  if (!srcDir) throw new Error("缺少 OpenList 源目录。请传 --src-dir。");
  if (!dstDir) throw new Error("缺少 OpenList 目标目录。请传 --dst-dir 或配置 OPENLIST_DEFAULT_COPY_DST_PATH。");
  if (names.length === 0) throw new Error("缺少要复制的对象名。请传 --name 或 --names。");

  const sourceListing = await listDirectory({ ...context, dirPath: srcDir, refresh: true });
  let destinationListing = null;
  let destinationExists = true;
  let destinationCreated = false;
  try {
    destinationListing = await listDirectory({ ...context, dirPath: dstDir, refresh: true });
  } catch (error) {
    if (!isOpenListNotFoundError(error)) throw error;
    destinationExists = false;
  }

  // 预览阶段不创建目录，保持 dry-run 只读；用户确认 --yes 后才自动创建目标目录。
  if (!destinationExists && args.yes) {
    await createDirectory({ ...context, dirPath: dstDir });
    destinationListing = await listDirectory({ ...context, dirPath: dstDir, refresh: true });
    destinationExists = true;
    destinationCreated = true;
  }

  const sourceNames = new Set(sourceListing.items.map((item) => item.name));
  const destinationNames = new Set((destinationListing?.items || []).map((item) => item.name));
  const missingNames = names.filter((name) => !sourceNames.has(name));
  const existingTargetNames = names.filter((name) => destinationNames.has(name));
  const expectedPaths = names.map((name) => joinOpenListPath(dstDir, name));
  const nextAction = missingNames.length > 0
    ? "fix_copy_source"
    : !destinationExists
      ? "confirm_create_destination_and_copy"
      : existingTargetNames.length > 0
        ? "confirm_copy_over_existing"
        : "confirm_before_copy";
  const baseResult = {
    ok: missingNames.length === 0,
    tool: "openlist-copy",
    mode: "agent-json",
    dryRun: !args.yes,
    nextAction,
    source: {
      dir: srcDir,
      itemCount: sourceListing.items.length,
      foundNames: names.filter((name) => sourceNames.has(name)),
      missingNames
    },
    destination: {
      dir: dstDir,
      exists: destinationExists,
      created: destinationCreated,
      itemCount: destinationListing?.items.length ?? 0,
      existingTargetNames
    },
    copyPlan: {
      srcDir,
      dstDir,
      names,
      expectedPaths
    },
    confirmation: {
      source: srcDir,
      selectedItems: names,
      target: dstDir,
      finalNaming: expectedPaths,
      commandHint: "Re-run this command with --yes --format json after the user confirms the copy plan."
    }
  };

  if (missingNames.length > 0) return baseResult;
  // 没有 --yes 时保持预览模式；目标目录不存在时只报告，确认执行后才自动创建。
  if (!args.yes) return baseResult;

  const copyResponse = await startCopyTask({ ...context, srcDir, dstDir, names });
  if (!copyResponse.ok) {
    return {
      ...baseResult,
      ok: false,
      dryRun: false,
      nextAction: "inspect_copy_error",
      copyRequest: copyResponse
    };
  }

  const copyTask = extractCopyTask(copyResponse.json);
  if (args.poll === false) {
    return {
      ...baseResult,
      ok: true,
      status: "SUBMITTED",
      dryRun: false,
      nextAction: "check_copy_progress",
      copyRequest: publicCopyResponse(copyResponse),
      copyTask
    };
  }

  const verification = await pollCopyCompletion({
    ...context,
    taskId: copyTask.id
  });

  return {
    ...baseResult,
    ok: verification.ok,
    status: verification.status,
    dryRun: false,
    nextAction: verification.status === "SUCCEEDED" ? "copy_complete"
      : verification.status === "FAILED" ? "inspect_copy_error"
        : "check_copy_progress",
    copyRequest: publicCopyResponse(copyResponse),
    copyTask,
    verification
  };
}


/** Return only the fields an Agent needs to confirm or report a copy operation. */
function toCompactCopyResult(result = {}) {
  const plan = result.copyPlan || {};
  const source = result.source || {};
  const destination = result.destination || {};
  const verification = result.verification || {};
  const task = result.copyTask || result.copyRequest?.task || {};
  const output = {
    ok: Boolean(result.ok),
    mode: result.dryRun ? "preview" : "copy",
    nextAction: result.nextAction || "",
    source: {
      dir: source.dir || plan.srcDir || "",
      found: source.foundNames || [],
      missing: source.missingNames || []
    },
    destination: {
      dir: destination.dir || plan.dstDir || "",
      exists: destination.exists ?? null,
      created: Boolean(destination.created),
      conflicts: destination.existingTargetNames || []
    },
    items: plan.names || source.foundNames || [],
    targetPaths: plan.expectedPaths || []
  };
  const status = result.status || verification.status;
  const taskId = task.id || verification.taskId || "";
  if (status) output.status = status;
  if (taskId) output.taskId = taskId;
  if (Number.isFinite(task.progress)) output.progress = task.progress;
  const error = result.error || result.copyRequest?.message || verification.error || "";
  if (error) output.error = error;
  return output;
}

/** 轮询 OpenList 任务状态，直到成功、失败或达到等待上限。 */
/** 轮询 OpenList 复制任务状态，直至成功、失败或达到等待上限。 */
async function pollCopyCompletion({ baseUrl, token, fetchImpl, timeoutMs, taskId }) {
  if (!taskId) {
    return { ok: true, status: "UNKNOWN", state: "task_id_missing", reason: "OpenList 未返回可追踪的 task ID。" };
  }

  const undone = await listTaskGroup({ baseUrl, token, fetchImpl, timeoutMs, group: "copy", state: "undone" });
  if (undone.error) {
    return { ok: true, status: "UNKNOWN", state: "undone_lookup_failed", taskId, error: undone.error };
  }
  const active = undone.tasks.find((task) => task.id === taskId);
  if (active) {
    return { ok: true, status: "ACTIVE", state: "copying", taskId, task: active };
  }

  const done = await listTaskGroup({ baseUrl, token, fetchImpl, timeoutMs, group: "copy", state: "done" });
  if (done.error) {
    return { ok: true, status: "UNKNOWN", state: "done_lookup_failed", taskId, error: done.error };
  }
  const completed = done.tasks.find((task) => task.id === taskId);
  if (!completed) {
    return { ok: true, status: "UNKNOWN", state: "task_not_found", taskId };
  }

  const errorText = String(completed.error || "").trim();
  const statusText = String(completed.status || "").toLowerCase();
  if (errorText || /fail|error|cancel/.test(statusText)) {
    return { ok: false, status: "FAILED", state: "task_failed", taskId, task: completed, error: errorText || completed.status };
  }

  // OpenList 的 done 列表代表任务已进入终态；部分版本 status 文本仍显示 uploading。
  return { ok: true, status: "SUCCEEDED", state: "task_done", taskId, task: completed };
}

/** 调用 OpenList fs/list 读取一个目录；只返回名称、类型、大小和修改时间等规划所需信息。 */
/** 通过 OpenList fs/list 读取目录内容，不修改目录或文件。 */
async function listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath, refresh }) {
  const response = await fetchOpenListJson({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs,
    path: "/api/fs/list",
    method: "POST",
    body: JSON.stringify({
      path: dirPath,
      password: "",
      page: 1,
      per_page: 200,
      refresh: Boolean(refresh)
    })
  });
  if (!response.ok || !isOpenListSuccess(response.json)) {
    throw new Error(`OpenList list failed for ${dirPath}: ${response.json?.message || response.status || "unknown"}`);
  }
  return {
    path: dirPath,
    items: normalizeListItems(response.json)
  };
}

/** 判断目录列表错误是否明确表示目标对象不存在；其他错误不得触发自动创建。 */
function isOpenListNotFoundError(error) {
  return /object not found|failed get dir|not found/i.test(String(error?.message || error || ""));
}

/** 创建 OpenList 目标目录；只在用户通过 --yes 确认执行时调用。 */
async function createDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath }) {
  const response = await fetchOpenListJson({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs,
    path: "/api/fs/mkdir",
    method: "POST",
    body: JSON.stringify({ path: dirPath })
  });
  if (!response.ok || !isOpenListSuccess(response.json)) {
    throw new Error(`OpenList mkdir failed for ${dirPath}: ${response.json?.message || response.status || "unknown"}`);
  }
  return { path: dirPath, created: true };
}

/** 调用 OpenList 复制接口发起复制任务；该操作会在目标存储产生数据。 */
/** 调用 OpenList 复制接口发起任务；该操作会在目标存储产生数据。 */
async function startCopyTask({ baseUrl, token, fetchImpl, timeoutMs, srcDir, dstDir, names }) {
  const response = await fetchOpenListJson({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs,
    path: "/api/fs/copy",
    method: "POST",
    body: JSON.stringify({
      src_dir: srcDir,
      dst_dir: dstDir,
      names
    })
  });
  return {
    ok: response.ok && isOpenListSuccess(response.json),
    status: response.status,
    json: response.json
  };
}

/** 读取TaskGroup列表并转换为模块内部使用的数据结构；列表读取不应被误认为文件写入。 */
/** 通过对应服务接口读取列表数据，不修改远端内容。 */
async function listTaskGroup({ baseUrl, token, fetchImpl, timeoutMs, group, state }) {
  const response = await fetchOpenListJson({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs,
    path: `/api/task/${group}/${state}`,
    method: "GET"
  });
  if (!response.ok || !isOpenListSuccess(response.json)) {
    return { tasks: [], error: response.json?.message || String(response.status || "unknown") };
  }
  return {
    tasks: Array.isArray(response.json?.data) ? response.json.data.map(normalizeTask) : []
  };
}

/** 封装OpenListJson相关网络请求，处理超时、响应解析和错误传递；是否改变远端数据取决于请求方法及接口。 */
/** 封装 OpenList API 请求、超时处理、JSON 解析和错误检查。 */
async function fetchOpenListJson({ baseUrl, token, fetchImpl, timeoutMs, path: apiPath, method, body }) {
  return requestOpenListJson({ baseUrl, token, fetchImpl, timeoutMs, endpoint: apiPath, method, body });
}
/** 从 OpenList 响应中提取复制任务信息。 */
/** 从 OpenList 响应中提取复制任务标识和状态。 */
function extractCopyTask(json = {}) {
  const task = json?.data?.task || (Array.isArray(json?.data?.tasks) ? json.data.tasks[0] : null) || {};
  return normalizeTask(task);
}

/** 处理publicCopyResponse相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 publicCopyResponse 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function publicCopyResponse(response) {
  return {
    ok: response.ok,
    status: response.status,
    code: response.json?.code ?? null,
    message: response.json?.message || "",
    task: extractCopyTask(response.json)
  };
}

/** 把 OpenList 目录列表转换为内部统一文件/目录结构。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
function normalizeListItems(json = {}) {
  const rawItems = Array.isArray(json?.data?.content)
    ? json.data.content
    : Array.isArray(json?.data)
      ? json.data
      : [];
  return rawItems.map((item) => ({
    name: String(item.name || ""),
    type: item.type ?? null,
    isDir: Boolean(item.is_dir ?? item.isDir ?? item.type === 1),
    size: item.size ?? null,
    modified: item.modified || item.updated_at || ""
  })).filter((item) => item.name);
}

/** 把 OpenList 原始任务对象转换为内部统一字段。 */
/** 把 OpenList 原始任务转换为内部统一字段。 */
function normalizeTask(task = {}) {
  return {
    id: String(task.id || ""),
    name: String(task.name || ""),
    state: task.state ?? null,
    status: task.status || "",
    progress: task.progress ?? null,
    error: task.error || ""
  };
}

/** 处理matchesCopyTask相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 matchesCopyTask 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function matchesCopyTask(task, { taskId, srcDir, dstDir, names }) {
  if (taskId && task.id === taskId) return true;
  const haystack = `${task.name} ${task.status}`.toLowerCase();
  const hasName = names.some((name) => haystack.includes(String(name).toLowerCase()));
  if (!hasName) return false;
  const sourceHint = basenameFromPath(srcDir);
  const destHint = basenameFromPath(dstDir);
  return haystack.includes(sourceHint.toLowerCase()) || haystack.includes(destHint.toLowerCase());
}

/** 从环境变量和参数构造 OpenList API 调用上下文。 */
/** 根据参数和环境变量构造 OpenList API 调用上下文。 */
function buildOpenListContext(env, args, fetchImpl) {
  return {
    baseUrl: args.baseUrl || env.OPENLIST_BASE_URL,
    token: args.token || env.OPENLIST_TOKEN,
    fetchImpl,
    timeoutMs: args.timeoutMs || DEFAULT_TIMEOUT_MS
  };
}

/** 格式化 OpenList 复制结果，展示源、目标、任务 ID 和执行状态。 */
/** 把复制结果格式化为可读输出，展示源、目标和任务状态。 */
function formatCopyResult(result) {
  const lines = ["### OpenList Copy", ""];
  lines.push(`状态：${result.ok ? "OK" : "失败"}`);
  lines.push(`下一步：${result.nextAction}`);
  if (result.copyPlan) {
    lines.push(`来源：${result.copyPlan.srcDir}`);
    lines.push(`目标：${result.copyPlan.dstDir}`);
    lines.push(`对象：${result.copyPlan.names.join(", ")}`);
  }
  if (result.dryRun) lines.push("未执行复制：确认后加 --yes。");
  if (result.verification?.errors?.length) {
    for (const error of result.verification.errors) {
      lines.push(`错误：${error.id || "-"} ${error.error || ""}`);
    }
  }
  return lines.join("\n");
}

/** 读取指定 .env 文件并与当前进程环境变量合并；调用方环境变量优先，避免覆盖部署环境注入值。 */
/** 合并 .env 文件与进程环境变量，进程环境变量优先。 */

/** 验证并规范化 OpenList 可见路径，拒绝空路径和路径穿越片段。 */
/** 规范化接口或用户输入数据，统一字段和格式，屏蔽上游差异。 */
function normalizeOpenListPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith("/") ? text.replace(/\/+$/g, "") || "/" : `/${text.replace(/\/+$/g, "")}`;
}

/** 在 OpenList 路径规则下拼接父目录和子路径。 */
/** 处理 joinOpenListPath 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function joinOpenListPath(dirPath, name) {
  if (dirPath === "/") return `/${name}`;
  return `${dirPath.replace(/\/+$/g, "")}/${name}`;
}

/** 从路径中提取最后一级名称。 */
/** 处理 basenameFromPath 相关逻辑；请结合调用位置核对输入、返回值和异常传播。 */
function basenameFromPath(value) {
  return String(value || "").split("/").filter(Boolean).at(-1) || "";
}

/** 把逗号分隔的参数转换为去空格、去空项的数组。 */
/** 解析输入并返回规范化结果；无法识别的输入应明确报错。 */
function parseList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** 根据 OpenList 响应字段判断接口调用是否成功。 */
/** 依据 OpenList 响应字段判断接口是否成功。 */
function isOpenListSuccess(json) {
  return isOpenListResponseSuccess(json);
}

/** 等待指定毫秒数，通常用于轮询任务状态时控制请求频率。 */
/** 等待指定时间，用于控制任务轮询频率。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/** 确认模块是直接运行而非被导入，避免导入时触发命令行副作用。 */
/** 判断模块是否由 Node.js 直接执行；被其他模块导入时不自动启动 CLI。 */

export {
  parseArgs,
  runOpenListCopy,
  toCompactCopyResult
};
