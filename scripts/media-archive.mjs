#!/usr/bin/env node

/**
 * Execute a reviewed media plan through OpenList APIs.
 * Default mode is read-only. Mutations require an explicit --yes flag.
 * Existing targets are never overwritten; all items are rechecked immediately before execution.
 */
import fs from "node:fs";
import { loadEnvFile, mergeEnvValues } from "./env-config.mjs";
import { cliArgs, failCli, isCliEntryPoint } from "./cli-utils.mjs";
import { acquireResourceLock, getArchiveOperation, recordArchiveOperation } from "./media-task-store.mjs";
import { requestOpenListJson, isOpenListSuccess } from "./openlist-client.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

if (isCliEntryPoint(import.meta.url)) {
  main().catch((error) => failCli(error));
}

async function main() {
  const args = parseArgs(cliArgs());
  if (!args.planFile) throw new Error("请通过 --plan-file 指定 media-plan 输出的 JSON 文件。");
  const envFile = args.envFile || ".env";
  const env = mergeEnvValues(loadEnvFile(envFile).values, process.env);
  const raw = JSON.parse(fs.readFileSync(args.planFile, "utf8"));
  const plan = Array.isArray(raw) ? raw : raw.plan;
  if (!Array.isArray(plan)) throw new Error("计划文件必须是 media-plan JSON，且包含 plan 数组。");
  const result = await runMediaArchive({
    plan,
    baseUrl: args.baseUrl || env.OPENLIST_BASE_URL,
    token: args.token || env.OPENLIST_TOKEN,
    moviesPath: normalizePath(args.moviesPath || env.MEDIA_MOVIES_PATH),
    tvShowsPath: normalizePath(args.tvShowsPath || env.MEDIA_TVSHOWS_PATH),
    yes: args.yes,
    fetchImpl: globalThis.fetch,
    timeoutMs: args.timeoutMs,
    storePath: env.MEDIA_TASK_STORE_PATH,
    lockDir: env.MEDIA_TASK_LOCK_DIR
  });
  console.log(args.compact ? JSON.stringify(compactArchiveResult(result)) : JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const args = { planFile: "", envFile: ".env", baseUrl: "", token: "", moviesPath: "", tvShowsPath: "", yes: false, compact: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--compact") args.compact = true;
    else if (arg === "--plan-file") args.planFile = argv[++i] || "";
    else if (arg === "--env-file") args.envFile = argv[++i] || ".env";
    else if (arg === "--base-url") args.baseUrl = argv[++i] || "";
    else if (arg === "--token") args.token = argv[++i] || "";
    else if (arg === "--movies-dir") args.moviesPath = argv[++i] || "";
    else if (arg === "--tvshows-dir") args.tvShowsPath = argv[++i] || "";
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i] || DEFAULT_TIMEOUT_MS);
    else if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
  }
  return args;
}

/**
 * Plan contract: automatic candidates and proposed review items with source/target/type are preflighted.
 * Review items are executable only after a matching explicit confirmation record is added. No delete/copy endpoint is used.
 */
async function runMediaArchive({
  plan, baseUrl, token, moviesPath, tvShowsPath, yes = false,
  fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
  storePath = undefined, lockDir = undefined
}) {
  if (!Array.isArray(plan)) throw new Error("plan 必须是数组。");
  if (!baseUrl || !token) throw new Error("OPENLIST_BASE_URL 或 OPENLIST_TOKEN 缺失。");
  if (!moviesPath || !tvShowsPath || moviesPath === "/" || tvShowsPath === "/") throw new Error("必须提供有效的 Movies 和 TVShows 根目录。");
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持 fetch，请使用 Node.js 20 或更新版本。");

  const preflightCandidates = plan.filter(isPreflightCandidate);
  const eligible = preflightCandidates.filter(isArchiveEligible);
  const skipped = plan.length - preflightCandidates.length;
  const allValidated = preflightCandidates.map((item) => validatePlanItem(item, { moviesPath, tvShowsPath }));
  const alreadyArchived = [];
  const preflightValidated = [];
  for (const item of allValidated) {
    const record = await getArchiveOperation(item.source, item.target, { storePath });
    if (record?.verified === true) alreadyArchived.push({ source: item.source, target: item.target, verified: true, verifiedAt: record.verifiedAt });
    else preflightValidated.push(item);
  }
  const activeCopyTasks = preflightValidated.length
    ? await listActiveCopyTasks({ baseUrl, token, fetchImpl, timeoutMs })
    : [];
  const blockedByActiveTasks = [];
  const safeCandidates = [];
  for (const item of preflightValidated) {
    const activeTask = activeCopyTasks.find((task) => activeCopyTaskMatchesItem(task, item));
    if (activeTask) {
      blockedByActiveTasks.push({
        source: item.source,
        target: item.target,
        taskId: activeTask.id,
        taskName: activeTask.name,
        progress: activeTask.progress ?? null,
        reason: "资源仍存在活动中的 OpenList 复制任务，暂缓归档。"
      });
    } else {
      safeCandidates.push(item);
    }
  }
  const validated = safeCandidates.filter(isArchiveEligible);
  const awaitingUserConfirmation = safeCandidates.filter((item) => !isArchiveEligible(item)).length;
  if (safeCandidates.length === 0) {
    const blocked = blockedByActiveTasks.length > 0;
    return {
      ok: !blocked, tool: "media-archive", mode: blocked ? "execution-blocked" : "idempotent-noop", mutated: false,
      eligible: eligible.length, skipped, alreadyArchived, preflight: [], executed: [],
      activeTaskCount: activeCopyTasks.length, blockedByActiveTasks,
      awaitingUserConfirmation: 0,
      safety: { overwrite: false, delete: false, copy: false },
      nextAction: blocked ? "wait_for_copy_tasks" : "archive_already_complete"
    };
  }
  const api = createApi({ baseUrl, token, fetchImpl, timeoutMs });
  const cache = new Map();

  async function list(dir) {
    if (!cache.has(dir)) cache.set(dir, await api.list(dir));
    return cache.get(dir);
  }
  async function inspectDirectory(dir) {
    const parts = dir.split("/").filter(Boolean);
    let current = "";
    let missingAt = -1;
    let rows = await list("/");
    for (let i = 0; i < parts.length; i += 1) {
      const row = rows.find((entry) => sameName(entry.name, parts[i]));
      if (!row) { missingAt = i; break; }
      if (!row.isDir) throw new Error(`目标路径中存在同名文件而非目录：/${parts.slice(0, i + 1).join("/")}`);
      current += "/" + parts[i];
      rows = await list(current);
    }
    return { missing: missingAt < 0 ? [] : parts.slice(missingAt).map((_, index) => "/" + parts.slice(0, missingAt + index + 1).join("/")), rows };
  }

  // Recheck only sources not protected by an active copy task.
  const preflight = [];
  for (const item of safeCandidates) {
    const sourceRows = await list(item.sourceDir);
    const sourceEntry = sourceRows.find((entry) => sameName(entry.name, item.sourceName));
    if (!sourceEntry || sourceEntry.isDir) {
      preflight.push({ source: item.source, target: item.target, ok: false, reason: "源文件不存在或不是普通文件。" });
      continue;
    }
    const targetInfo = await inspectDirectory(item.targetDir);
    const targetNameExists = targetInfo.missing.length === 0 &&
      targetInfo.rows.some((entry) => sameName(entry.name, item.targetName));
    preflight.push({
      source: item.source, target: item.target, ok: !targetNameExists,
      conflict: targetNameExists, missingDirectories: targetInfo.missing,
      reason: targetNameExists ? "目标已存在，禁止覆盖。" : ""
    });
  }

  const blocked = preflight.filter((entry) => !entry.ok);
  if (blocked.length) {
    return {
      ok: false, tool: "media-archive", mode: yes ? "execution-blocked" : "read-only-dry-run",
      mutated: false, eligible: eligible.length, skipped, alreadyArchived,
      preflight, executed: [], awaitingUserConfirmation, activeTaskCount: activeCopyTasks.length, blockedByActiveTasks,
      nextAction: "resolve_conflicts_or_missing_sources"
    };
  }

  if (!yes) {
    return {
      ok: true, tool: "media-archive", mode: "read-only-dry-run", mutated: false,
      eligible: eligible.length, skipped, alreadyArchived,
      preflight, executed: [], awaitingUserConfirmation, activeTaskCount: activeCopyTasks.length, blockedByActiveTasks,
      safety: { overwrite: false, delete: false, copy: false, note: "仅检查源文件和目标路径；未创建目录、移动或重命名文件。" },
      nextAction: blockedByActiveTasks.length > 0 ? "wait_for_copy_tasks" : awaitingUserConfirmation > 0 ? "confirm_review_items" : "review_and_confirm_with_yes"
    };
  }

  if (validated.length === 0) {
    return {
      ok: true, tool: "media-archive", mode: "awaiting-user-confirmation", mutated: false,
      eligible: 0, skipped, alreadyArchived, preflight, executed: [],
      awaitingUserConfirmation, activeTaskCount: activeCopyTasks.length, blockedByActiveTasks,
      safety: { overwrite: false, delete: false, copy: false },
      nextAction: blockedByActiveTasks.length > 0 ? "wait_for_copy_tasks" : "confirm_review_items"
    };
  }

  const lockHandles = [];
  const lockedGroups = new Set();
  try {
    for (const item of validated) {
      const groupKey = item.resourceGroupId || "";
      if (!groupKey || lockedGroups.has(groupKey)) continue;
      const handle = await acquireResourceLock(groupKey, { lockDir });
      lockHandles.push(handle);
      lockedGroups.add(groupKey);
    }
  } catch (error) {
    for (const handle of lockHandles.reverse()) await handle.release().catch(() => {});
    return {
      ok: false, tool: "media-archive", mode: "execution-blocked", mutated: false,
      eligible: eligible.length, skipped, alreadyArchived, preflight, executed: [],
      error: error.message || String(error), awaitingUserConfirmation,
      nextAction: "resolve_resource_lock"
    };
  }

  const executed = [];
  try {
    for (const item of validated) {
      const check = preflight.find((entry) => entry.source === item.source);
      try {
        // Create missing directories from the shallowest parent to the deepest.
        for (const dir of check.missingDirectories) await api.mkdir(dir);

        // Last-moment recheck prevents stale preflight data from overwriting a file created meanwhile.
        const freshSourceRows = await api.list(item.sourceDir);
        if (!freshSourceRows.some((entry) => sameName(entry.name, item.sourceName) && !entry.isDir)) {
          throw new Error("执行前源文件已不存在或类型发生变化，已停止。");
        }
        const freshTargetRows = await api.list(item.targetDir);
        if (item.sourceDir !== item.targetDir || item.sourceName !== item.targetName) {
          if (freshTargetRows.some((entry) => sameName(entry.name, item.targetName))) {
            throw new Error("执行前目标路径已被占用，已停止且不会覆盖。");
          }
        }

        let currentPath = item.source;
        if (item.sourceDir !== item.targetDir) {
          await api.move(item.sourceDir, item.targetDir, item.sourceName);
          currentPath = join(item.targetDir, item.sourceName);
        }
        if (item.sourceName !== item.targetName) {
          await api.rename(currentPath, item.targetName);
          currentPath = join(item.targetDir, item.targetName);
        }
        const verifyRows = await api.list(item.targetDir);
        if (!verifyRows.some((entry) => sameName(entry.name, item.targetName))) {
          throw new Error("OpenList 操作已返回成功，但目标目录回读未发现文件。");
        }
        if (item.resourceGroupId) {
          await recordArchiveOperation({
            source: item.source, target: item.target,
            resourceGroupId: item.resourceGroupId, verified: true
          }, { storePath });
        }
        executed.push({ source: item.source, target: item.target, ok: true, verified: true });
      } catch (error) {
        executed.push({ source: item.source, target: item.target, ok: false, verified: false, error: error.message || String(error) });
        // Stop on first uncertain result. Do not retry blindly or remove the source.
        break;
      }
    }
  } finally {
    for (const handle of lockHandles.reverse()) await handle.release().catch(() => {});
  }

  const success = executed.length === validated.length && executed.every((entry) => entry.ok);
  return {
    ok: success && blockedByActiveTasks.length === 0, tool: "media-archive", mode: "openlist-move-and-rename",
    mutated: executed.some((entry) => entry.ok), eligible: eligible.length, skipped, alreadyArchived,
    preflight, executed, activeTaskCount: activeCopyTasks.length, blockedByActiveTasks,
    safety: { overwrite: false, delete: false, copy: false, stopOnFirstError: true, idempotencyLedger: true, resourceLocks: true },
    confirmedReviewCount: validated.filter((item) => item.confirmedReview).length,
    awaitingUserConfirmation,
    nextAction: blockedByActiveTasks.length > 0 ? "wait_for_copy_tasks" : success ? "archive_complete" : "inspect_partial_execution_before_retry"
  };
}


/** Agent-facing output: keep decisions and execution evidence, omit verbose safety prose. */
function compactArchiveResult(result) {
  const pick = (item, keys) => Object.fromEntries(keys
    .filter((key) => item?.[key] !== undefined && item[key] !== "")
    .map((key) => [key, item[key]]));
  const compact = {
    ok: result.ok,
    tool: result.tool,
    mode: result.mode,
    mutated: result.mutated,
    eligible: result.eligible,
    skipped: result.skipped,
    awaitingUserConfirmation: result.awaitingUserConfirmation,
    alreadyArchived: (result.alreadyArchived || []).map((item) => pick(item, ["source", "target", "verified"])),
    activeTaskCount: result.activeTaskCount ?? 0,
    blockedByActiveTasks: (result.blockedByActiveTasks || []).map((item) => pick(item, ["source", "target", "taskId", "progress", "reason"])),
    preflight: (result.preflight || []).map((item) => pick(item, ["source", "target", "ok", "conflict", "missingDirectories", "reason"])),
    executed: (result.executed || []).map((item) => pick(item, ["source", "target", "ok", "verified", "error"])),
    nextAction: result.nextAction
  };
  for (const key of ["confirmedReviewCount", "error"]) {
    if (result[key] !== undefined) compact[key] = result[key];
  }
  return compact;
}

function isPreflightCandidate(item) {
  return Boolean(
    item && ["auto_archive_candidate", "review_required"].includes(item.status) &&
    item.source && item.target && ["movie", "series"].includes(item.resourceType) &&
    item.conflict !== true
  );
}

function isArchiveEligible(item) {
  if (item?.conflict === true) return false;
  if (item?.status === "auto_archive_candidate") return true;
  if (item?.status !== "review_required" || item.userConfirmed !== true) return false;
  const confirmation = item.confirmation;
  if (!confirmation || confirmation.scope !== "move-and-rename") return false;
  if (confirmation.source !== item.source || confirmation.target !== item.target) return false;
  if (confirmation.resourceType !== item.resourceType || confirmation.resourceName !== item.resourceName) return false;
  if (item.year != null && Number(confirmation.year) !== Number(item.year)) return false;
  if (item.year == null && confirmation.year != null) return false;
  return ["movie", "series"].includes(item.resourceType);
}

function validatePlanItem(item, roots) {
  const source = normalizePath(item.source);
  const target = normalizePath(item.target);
  if (!source || !target || source === "/" || target === "/") throw new Error("计划中存在无效源路径或目标路径。");
  const root = item.resourceType === "movie" ? roots.moviesPath : item.resourceType === "series" ? roots.tvShowsPath : "";
  if (!root || !(target.startsWith(root + "/"))) throw new Error(`目标路径不在对应媒体库根目录内：${target}`);
  const sourceName = basename(source);
  const targetName = basename(target);
  if (!sourceName || !targetName) throw new Error("计划路径缺少文件名。");
  return {
    ...item, source, target, sourceDir: parent(source), sourceName, targetDir: parent(target), targetName,
    confirmedReview: item.status === "review_required" && isArchiveEligible(item)
  };
}

async function listActiveCopyTasks({ baseUrl, token, fetchImpl, timeoutMs }) {
  const response = await requestOpenListJson({
    baseUrl, token, fetchImpl, timeoutMs,
    endpoint: "/api/task/copy/undone",
    method: "GET"
  });
  if (!response.ok || !isOpenListSuccess(response.json)) {
    throw new Error(`无法确认 OpenList 活动复制任务，已停止归档：${response.json?.message || response.status || "unknown"}`);
  }
  return Array.isArray(response.json?.data)
    ? response.json.data.map((task) => ({
      id: String(task.id || ""),
      name: String(task.name || ""),
      progress: task.progress ?? null
    })).filter((task) => task.id && task.name)
    : [];
}

function activeCopyTaskMatchesItem(task, item) {
  const taskName = String(task?.name || "");
  const resourceGroup = normalizePath(item.resourceGroupId);
  const resourceFolderName = resourceGroup ? basename(resourceGroup) : "";
  return taskName.includes(String(item.source || "")) ||
    Boolean(resourceGroup && taskName.includes(resourceGroup)) ||
    containsPathSegment(taskName, resourceFolderName);
}

function containsPathSegment(value, segment) {
  if (!segment) return false;
  const text = String(value || "").toLocaleLowerCase("zh-CN");
  const needle = String(segment).toLocaleLowerCase("zh-CN");
  let index = text.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? text[index - 1] : "";
    const after = text[index + needle.length] || "";
    const leftBoundary = before === "/" || before === "\\\\";
    const rightBoundary = after === "" || after === "/" || after === "\\\\" || after === ")" || after === "]";
    if (leftBoundary && rightBoundary) return true;
    index = text.indexOf(needle, index + 1);
  }
  return false;
}

function createApi({ baseUrl, token, fetchImpl, timeoutMs }) {
  async function request(endpoint, body) {
    const response = await requestOpenListJson({
      baseUrl, token, fetchImpl, timeoutMs, endpoint, method: "POST", body
    });
    if (!response.ok || !isOpenListSuccess(response.json)) {
      throw new Error(`OpenList ${endpoint} 失败：${response.json?.message || response.status}`);
    }
    return response.json;
  }

  return {
    async list(dir) {
      const all = [];
      const seen = new Set();
      for (let page = 1; page <= 10; page += 1) {
        const json = await request("/api/fs/list", {
          path: dir, password: "", page, per_page: 200, refresh: true
        });
        const rows = Array.isArray(json?.data?.content)
          ? json.data.content
          : Array.isArray(json?.data) ? json.data : [];
        for (const row of rows) {
          const name = String(row.name || "");
          if (name && !seen.has(name)) {
            seen.add(name);
            all.push({ name, isDir: Boolean(row.is_dir ?? row.isDir ?? row.type === 1) });
          }
        }
        if (rows.length < 200) return all;
        if (page === 10) throw new Error(`OpenList 目录 ${dir} 超过 2000 项，无法安全排除目标冲突。`);
      }
      return all;
    },
    mkdir: (dir) => request("/api/fs/mkdir", { path: dir }),
    move: (srcDir, dstDir, name) => request("/api/fs/move", { src_dir: srcDir, dst_dir: dstDir, names: [name] }),
    rename: (sourcePath, name) => request("/api/fs/rename", { path: sourcePath, name })
  };
}
function normalizePath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (!text || !text.startsWith("/") || text.split("/").some((part) => part === "..")) return "";
  return text.replace(/\/+$/g, "") || "/";
}
function parent(value) { const index = value.lastIndexOf("/"); return index <= 0 ? "/" : value.slice(0, index); }
function basename(value) { return value.split("/").filter(Boolean).at(-1) || ""; }
function join(dir, name) { return dir === "/" ? "/" + name : dir.replace(/\/+$/g, "") + "/" + name; }
function sameName(a, b) { return String(a).toLocaleLowerCase("zh-CN") === String(b).toLocaleLowerCase("zh-CN"); }

export { compactArchiveResult, isArchiveEligible, isPreflightCandidate, parseArgs, runMediaArchive, validatePlanItem };
