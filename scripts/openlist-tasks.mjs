#!/usr/bin/env node

/**
 * 查询、筛选或取消 OpenList 后台任务；查询是只读操作，取消会改变远端任务状态。
 *
 * 本文件说明：函数注释解释职责和关键边界；本次修改只增加注释，不改变原有执行逻辑。
 * 安全约束：只读预览与真实写入必须严格区分；测试写入必须限制在专用目录并要求显式确认。
 */

/**
 * 查询、筛选和管理 OpenList 后台任务；查询为读取操作，取消任务会改变任务执行状态。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */


import { loadEnvFile, mergeEnvValues } from "./env-config.mjs";
import { cliArgs, failCli, isCliEntryPoint } from "./cli-utils.mjs";
import { requestOpenListJson, isOpenListSuccess as isOpenListResponseSuccess } from "./openlist-client.mjs";

const DEFAULT_ENV_FILE = ".env";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_GROUP = "copy";
const DEFAULT_STATE = "undone";
const TASK_GROUPS = new Set(["copy", "offline_download", "offline_download_transfer", "upload", "decompress", "decompress_upload"]);
const TASK_STATES = new Set(["undone", "done"]);

// 仅在直接执行脚本时启动主流程；作为模块导入时不产生网络请求或其他副作用。
  if (isCliEntryPoint(import.meta.url)) {
  main().catch((error) => failCli(error));
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
/** CLI 入口：组装任务字段并交由状态库验证；不在 CLI 层绕过状态机规则。 */
async function main() {
  const args = parseArgs(cliArgs());
  if (args.help) {
    console.log(formatTaskHelp());
    return;
  }
  const env = mergeEnvValues(loadEnvFile(args.envFile).values, process.env);
  const result = await runOpenListTasks({
    env,
    args,
    fetchImpl: globalThis.fetch
  });

  if (args.format === "text") {
    console.log(formatTaskResult(result));
  } else {
    console.log(JSON.stringify(result));
  }

  if (!result.ok) process.exit(1);
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；遇到未知参数时明确报错。 */
function parseArgs(argv) {
  const parsed = {
    action: "list",
    group: DEFAULT_GROUP,
    state: DEFAULT_STATE,
    ids: [],
    taskId: "",
    match: "",
    provider: "",
    sourcePrefix: "",
    envFile: DEFAULT_ENV_FILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    yes: false,
    compact: false,
    help: false,
    format: "json"
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--compact") {
      parsed.compact = true;
    } else if (arg === "--group") {
      parsed.group = normalizeQueryGroup(argv[++index] || DEFAULT_GROUP);
    } else if (arg === "--state") {
      parsed.state = normalizeQueryState(argv[++index] || DEFAULT_STATE);
    } else if (arg === "--id") {
      parsed.taskId = argv[++index] || "";
    } else if (arg === "--ids") {
      parsed.ids.push(...parseList(argv[++index] || ""));
    } else if (arg === "--match") {
      parsed.match = argv[++index] || "";
    } else if (arg === "--provider") {
      parsed.provider = argv[++index] || "";
    } else if (arg === "--source-prefix" || arg === "--src-prefix") {
      parsed.sourcePrefix = argv[++index] || "";
    } else if (arg === "--env-file" || arg === "--dotenv" || arg === "--config") {
      parsed.envFile = argv[++index] || DEFAULT_ENV_FILE;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
    } else if (arg === "--base-url") {
      parsed.baseUrl = argv[++index] || "";
    } else if (arg === "--token") {
      parsed.token = argv[++index] || "";
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (arg === "--json") {
      parsed.format = "json";
    } else if (arg === "--format") {
      parsed.format = argv[++index] || "json";
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals[0]) parsed.action = normalizeAction(positionals[0]);
  if (positionals[1]) parsed.group = normalizeQueryGroup(positionals[1]);
  if (positionals[2]) parsed.state = normalizeQueryState(positionals[2]);
  return parsed;
}

/** 处理runOpenListTasks相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 按动作、任务组、状态和网盘来源组织 OpenList 任务查询或取消流程。 */
async function runOpenListTasks({ env = {}, args = {}, fetchImpl = globalThis.fetch }) {
  const group = args.group === "all" ? "all" : normalizeGroup(args.group || DEFAULT_GROUP);
  const state = args.state === "all" ? "all" : normalizeState(args.state || DEFAULT_STATE);
  const action = normalizeAction(args.action || "list");
  const context = buildOpenListContext(env, args, fetchImpl);
  if (action === "get") {
    if (group === "all") throw new Error("get 不支持 --group all，请指定任务组。");
    const taskIds = [...new Set([args.taskId, ...(args.ids || [])].map((id) => String(id || "").trim()).filter(Boolean))];
    if (taskIds.length === 0) throw new Error("查询任务时必须提供 --id TASK_ID 或 --ids ID1,ID2。");
    const results = await Promise.all(taskIds.map(async (taskId) => {
      try {
        const result = await lookupOpenListTaskById({ ...context, group, id: taskId });
        return {
          taskId,
          status: result.status,
          nextAction: result.status === "ACTIVE" ? "wait_for_task"
            : result.status === "SUCCEEDED" ? "report_complete"
              : result.status === "FAILED" ? "report_failure" : "inspect_unknown",
          task: result.task || null,
          reason: result.reason || ""
        };
      } catch (error) {
        return { taskId, status: "UNKNOWN", nextAction: "retry_lookup_later", reason: sanitizeTaskError(error.message) };
      }
    }));
    const counts = countTaskStatuses(results);
    return { ok: results.every((item) => item.status !== "FAILED"), tool: "openlist-tasks", action: "get", group, totalCount: results.length, counts, results };
  }
  if (action === "cancel" && (group === "all" || state === "all")) {
    throw new Error("为避免批量误取消，cancel 不支持 group=all 或 state=all。");
  }
  const groups = group === "all" ? [...TASK_GROUPS] : [group];
  const states = state === "all" ? [...TASK_STATES] : [state];
  const listed = await listTaskCollections({ ...context, groups, states });
  const filteredTasks = filterTasks(listed.tasks, args);
  const baseResult = {
    ok: true,
    tool: "openlist-tasks",
    mode: "agent-json",
    action,
    group,
    state,
    nextAction: "report_tasks",
    queryErrors: listed.errors,
    counts: countTaskStatuses(filteredTasks),
    groupsQueried: groups,
    statesQueried: states,
    filter: {
      ids: args.ids || [],
      match: args.match || "",
      provider: args.provider || "",
      sourcePrefix: args.sourcePrefix || ""
    },
    totalCount: listed.tasks.length,
    matchedCount: filteredTasks.length,
    tasks: args.compact ? filteredTasks.map(compactTask) : filteredTasks
  };

  if (action === "list") return { ...baseResult, ok: listed.errors.length === 0 };

  if (action === "cancel") {
    if (filteredTasks.length === 0) {
      return {
        ...baseResult,
        dryRun: !args.yes,
        nextAction: "no_matching_tasks",
        matchedIds: []
      };
    }
    const matchedIds = filteredTasks.map((task) => task.id).filter(Boolean);
    // 没有 --yes 时保持预览模式，避免误把测试数据写入真实目录。
  if (!args.yes) {
      return {
        ...baseResult,
        dryRun: true,
        nextAction: "confirm_task_cancel",
        matchedIds
      };
    }
    const cancelResult = await cancelTasks({ ...context, group, ids: matchedIds });
    return {
      ...baseResult,
      ok: cancelResult.ok,
      dryRun: false,
      nextAction: cancelResult.ok ? "verify_tasks_cancelled" : "inspect_cancel_errors",
      matchedIds,
      cancelledIds: cancelResult.cancelledIds,
      cancelErrors: cancelResult.errors
    };
  }

  throw new Error(`Unsupported action: ${action}`);
}

/** 根据任务状态、网盘类型等条件筛选任务列表。 */
/** 根据用户指定条件筛选 OpenList 任务，避免把其他来源的任务混入结果。 */
function filterTasks(tasks, filters = {}) {
  let result = tasks.map((rawTask) => {
    const task = normalizeTask(rawTask);
    const classification = classifyTask(task);
    return {
      ...task,
      ...(rawTask.group ? { group: rawTask.group } : {}),
      ...(rawTask.listState ? { listState: rawTask.listState } : {}),
      taskStatus: classification.status,
      ...(classification.reason ? { taskReason: classification.reason } : {})
    };
  }).filter((task) => task.id);
  if (filters.ids && filters.ids.length > 0) {
    const ids = new Set(filters.ids);
    result = result.filter((task) => ids.has(task.id));
  }
  if (filters.provider) {
    const provider = String(filters.provider).toLowerCase();
    result = result.filter((task) => taskMatchesProvider(task, provider));
  }
  if (filters.sourcePrefix) {
    const sourcePrefix = String(filters.sourcePrefix);
    result = result.filter((task) => task.name.includes(`](${sourcePrefix}`) || task.name.includes(sourcePrefix));
  }
  if (filters.match) {
    const needle = String(filters.match);
    result = result.filter((task) => task.name.includes(needle) || task.id.includes(needle));
  }
  return result;
}

/** 读取状态库中的任务集合，不改变任务状态。 */
/** 读取本地任务状态库中的任务列表，不修改状态。 */
async function listTasks({ baseUrl, token, fetchImpl, timeoutMs, group, state }) {
  const response = await fetchOpenListJson({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs,
    path: `/api/task/${group}/${state}`,
    method: "GET"
  });
  const success = response.ok && isOpenListSuccess(response.json);
  if (!success) {
    throw new Error(`OpenList task list failed: ${response.json?.message || response.status || "unknown"}`);
  }
  return {
    tasks: Array.isArray(response.json?.data) ? response.json.data.map(normalizeTask) : []
  };
}


/** Query each requested group/state once; retain successful results when an individual endpoint fails. */
async function listTaskCollections(context) {
  const combinations = context.groups.flatMap((group) => context.states.map((state) => ({ group, state })));
  const results = await Promise.all(combinations.map(async ({ group, state }) => {
    try {
      const listed = await listTasks({ ...context, group, state });
      return { group, state, tasks: listed.tasks, error: "" };
    } catch (error) {
      return { group, state, tasks: [], error: sanitizeTaskError(error.message) };
    }
  }));
  const seen = new Set();
  const tasks = [];
  for (const result of results) {
    for (const task of result.tasks) {
      const key = `${result.group}:${task.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ ...task, group: result.group, listState: result.state });
    }
  }
  return {
    tasks,
    errors: results.filter((item) => item.error).map(({ group, state, error }) => ({ group, state, error }))
  };
}


function compactTask(task) {
  return {
    id: task.id,
    group: task.group || "copy",
    listState: task.listState || "",
    name: task.name,
    taskStatus: task.taskStatus || "UNKNOWN",
    progress: task.progress,
    ...(task.taskReason ? { taskReason: task.taskReason } : {}),
    ...(task.error ? { error: task.error } : {})
  };
}
\nfunction countTaskStatuses(tasks) {
  return tasks.reduce((counts, task) => {
    const status = task.taskStatus || task.status || "UNKNOWN";
    const normalized = ["SUCCEEDED", "ACTIVE", "FAILED", "UNKNOWN"].includes(status) ? status : "UNKNOWN";
    counts[normalized] += 1;
    return counts;
  }, { SUCCEEDED: 0, ACTIVE: 0, FAILED: 0, UNKNOWN: 0 });
}

function normalizeQueryGroup(value) {
  const group = String(value || DEFAULT_GROUP).trim();
  return group === "all" ? group : normalizeGroup(group);
}

function normalizeQueryState(value) {
  const state = String(value || DEFAULT_STATE).trim();
  return state === "all" ? state : normalizeState(state);
}

function formatTaskHelp() {
  return [
    "OpenList task commands:",
    "  list [GROUP|all] [undone|done|all] [--compact] [filters]",
    "  get GROUP --id TASK_ID | --ids ID1,ID2 [--compact]",
    "  cancel GROUP [undone|done] [filters] [--yes]",
    "",
    `Groups: ${[...TASK_GROUPS].join(", ")}`,
    "Filters: --match TEXT --provider NAME --source-prefix PATH --ids ID1,ID2",
    "Examples:",
    "  npm run --silent openlist-tasks -- list copy undone --compact",
    "  npm run --silent openlist-tasks -- list copy all --compact",
    "  npm run --silent openlist-tasks -- list all all --compact",
    "  npm run --silent openlist-tasks -- get copy --ids ID1,ID2 --compact",
    "  npm run --silent openlist-tasks -- --help"
  ].join("\\n");
}
\n/** 按精确 OpenList task ID 查询任务，不按文件名或目录名猜测任务身份。 */
/** 按精确 OpenList task ID 查询任务，不使用文件名或路径猜测任务身份。 */
async function lookupOpenListTaskById({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, group = DEFAULT_GROUP, id }) {
  const taskId = String(id || "").trim();
  if (!taskId) throw new Error("OpenList task ID 不能为空。");
  const normalizedGroup = normalizeGroup(group);
  const response = await fetchOpenListJson({
    baseUrl, token, fetchImpl, timeoutMs,
    path: `/api/task/${normalizedGroup}/info?tid=${encodeURIComponent(taskId)}`,
    method: "POST"
  });
  if (!response.ok || !isOpenListSuccess(response.json)) {
    throw new Error("OpenList task info lookup failed: " + sanitizeTaskError(response.json?.message || response.status || "unknown"));
  }

  const data = response.json?.data;
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const found = rows.find((item) => String(item?.id || "") === taskId);
  if (!found) return { id: taskId, group: normalizedGroup, status: "UNKNOWN", reason: "task_not_found", task: null };

  const task = normalizeTask(found);
  const classification = classifyTask(task);
  return { id: taskId, group: normalizedGroup, ...classification, task };
}

/** 向 OpenList 请求取消匹配的后台任务；这是会改变远端任务状态的操作。 */
/** 向 OpenList 请求取消匹配任务；这是会改变远端任务状态的操作，必须先预览并获得确认。 */
async function cancelTasks({ baseUrl, token, fetchImpl, timeoutMs, group, ids }) {
  const response = await fetchOpenListJson({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs,
    path: `/api/task/${group}/cancel_some`,
    method: "POST",
    body: JSON.stringify(ids)
  });
  const success = response.ok && isOpenListSuccess(response.json);
  const errors = response.json?.data && typeof response.json.data === "object" ? response.json.data : {};
  return {
    ok: success && Object.keys(errors).length === 0,
    cancelledIds: ids.filter((id) => !errors[id]),
    errors
  };
}

/** 封装OpenListJson相关网络请求，处理超时、响应解析和错误传递；是否改变远端数据取决于请求方法及接口。 */
/** 封装 OpenList API 请求、超时、JSON 解析和错误处理。 */
async function fetchOpenListJson({ baseUrl, token, fetchImpl, timeoutMs, path: apiPath, method, body }) {
  return requestOpenListJson({ baseUrl, token, fetchImpl, timeoutMs, endpoint: apiPath, method, body });
}
/** 把 OpenList 原始任务对象转换为内部统一字段。 */
/** 把 OpenList 原始任务对象转换为内部统一字段。 */
function normalizeTask(task = {}) {
  return {
    id: String(task.id || ""),
    name: String(task.name || ""),
    state: task.state ?? null,
    status: task.status || "",
    progress: task.progress ?? null,
    endTime: task.endTime ?? task.end_time ?? "",
    totalBytes: task.totalBytes ?? task.total_bytes ?? null,
    error: sanitizeTaskError(task.error || "")
  };
}

/** Classify task state from explicit errors, active states, or conservative terminal metadata. */
function classifyTask(task) {
  const state = String(task.state ?? "").trim().toLowerCase();
  const statusText = String(task.status || "").trim().toLowerCase();
  const errorText = String(task.error || "").trim();
  if (errorText || ["errored", "error", "failed", "canceled", "cancelled"].includes(state)
      || /(^|[^a-z])(fail|failed|error|cancel|cancelled)([^a-z]|$)/.test(statusText)) {
    return { status: "FAILED", reason: errorText || task.state || task.status };
  }
  if (["pending", "running", "canceling", "1"].includes(state)) {
    return { status: "ACTIVE", reason: state };
  }
  const progress = Number(task.progress);
  if (state === "succeeded") {
    if (Number.isFinite(progress) && progress >= 100 && !/(uploading|copying|downloading|pending|running)/.test(statusText)) {
      return { status: "SUCCEEDED", reason: "" };
    }
    return { status: "UNKNOWN", reason: "success_state_incomplete_or_conflicting" };
  }
  if (state === "2") {
    if (/src object is dir, added all copy tasks of objs/.test(statusText)) {
      return { status: "UNKNOWN", reason: "directory_task_dispatch" };
    }
    const hasEndTime = Boolean(String(task.endTime || "").trim());
    const totalBytes = Number(task.totalBytes);
    if (Number.isFinite(progress) && progress >= 100 && hasEndTime && Number.isFinite(totalBytes) && totalBytes > 0) {
      return { status: "SUCCEEDED", reason: "legacy_numeric_terminal_metadata" };
    }
    return { status: "UNKNOWN", reason: "legacy_numeric_terminal_incomplete" };
  }
  return { status: "UNKNOWN", reason: "unrecognized_task_state" };
}

function sanitizeTaskError(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(/([?&])[A-Za-z0-9_.~-]+=[^\s&"'<>]*/g, "$1[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 240);
}

/** 判断 OpenList 任务是否属于指定网盘或任务来源。 */
/** 判断任务是否匹配指定网盘来源，防止误操作其他 provider 的任务。 */
function taskMatchesProvider(task, provider) {
  if (provider === "baidu") {
    return task.name.includes("[/bdy]") || task.name.includes("/NAS资源下载") || task.name.includes("baidu");
  }
  if (provider === "quark") {
    return task.name.includes("[/pan/quark]") || task.name.includes("/备份资源") || task.name.includes("quark");
  }
  return task.name.toLowerCase().includes(provider);
}

/** 从环境变量和参数构造 OpenList API 调用上下文。 */
/** 从参数和环境变量构造 OpenList API 调用上下文。 */
function buildOpenListContext(env, args, fetchImpl) {
  return {
    baseUrl: args.baseUrl || env.OPENLIST_BASE_URL,
    token: args.token || env.OPENLIST_TOKEN,
    fetchImpl,
    timeoutMs: args.timeoutMs || DEFAULT_TIMEOUT_MS
  };
}

/** 将 OpenList 任务结果整理为可读文本或 JSON。 */
/** 将任务列表或取消结果格式化为便于人工检查的输出。 */
function formatTaskResult(result) {
  const lines = [`### OpenList ${result.group} ${result.action}`, ""];
  if (result.counts) lines.push(`SUCCEEDED ${result.counts.SUCCEEDED} | ACTIVE ${result.counts.ACTIVE} | FAILED ${result.counts.FAILED} | UNKNOWN ${result.counts.UNKNOWN}`);
  lines.push(`匹配任务：${result.matchedCount}/${result.totalCount}`);
  for (const task of result.tasks || []) {
    lines.push(`- [${task.taskStatus || task.status || task.state || "-"}] ${task.id}: ${task.name} ${task.progress ?? "-"}%`);
    if (task.error) lines.push(`  error: ${task.error}`);
  }
  if (result.action === "cancel") {
    lines.push("", result.dryRun ? "未取消：请确认后加 --yes。" : `已请求取消：${(result.cancelledIds || []).length} 个。`);
  }
  return lines.join("\n");
}

/** 读取指定 .env 文件并与当前进程环境变量合并；调用方环境变量优先，避免覆盖部署环境注入值。 */
/** 读取 .env 并合并进程环境变量；进程环境变量优先，不覆盖运行环境注入的配置。 */

/** 把逗号分隔的参数转换为去空格、去空项的数组。 */
/** 解析输入并返回规范化结果；不合法的输入应明确报错。 */
function parseList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** 校验并规范化 OpenList 任务操作名称。 */
/** 规范化数据或参数，统一字段和格式，减少上游差异。 */
function normalizeAction(value) {
  const action = String(value || "list").trim();
  if (["list", "get", "cancel"].includes(action)) return action;
  throw new Error(`Unsupported action: ${value}. 可选值：list, get, cancel。`);
}

/** 校验并规范化 OpenList 任务分组名称。 */
/** 规范化数据或参数，统一字段和格式，减少上游差异。 */
function normalizeGroup(value) {
  const group = String(value || DEFAULT_GROUP).trim();
  if (TASK_GROUPS.has(group)) return group;
  throw new Error(`Unsupported task group: ${value}`);
}

/** 规范化 OpenList 任务状态值。 */
/** 规范化数据或参数，统一字段和格式，减少上游差异。 */
function normalizeState(value) {
  const state = String(value || DEFAULT_STATE).trim();
  if (TASK_STATES.has(state)) return state;
  throw new Error(`Unsupported task state: ${value}`);
}

/** 根据 OpenList 响应字段判断接口调用是否成功。 */
/** 判断输入是否满足约束并返回布尔结果。 */
function isOpenListSuccess(json) {
  return isOpenListResponseSuccess(json);
}

/** 确认模块是直接运行而非被导入，避免导入时触发命令行副作用。 */
/** 判断当前模块是否作为命令行入口直接运行。 */

export {
  filterTasks,
  lookupOpenListTaskById,
  parseArgs,
  runOpenListTasks,
  listTaskCollections,
  countTaskStatuses,
  formatTaskHelp
};
