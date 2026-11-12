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
    openListTaskId: args.openListTaskId,
    fetchImpl: globalThis.fetch,
    timeoutMs: args.timeoutMs,
    storePath: env.MEDIA_TASK_STORE_PATH,
    lockDir: env.MEDIA_TASK_LOCK_DIR
  });
  console.log(args.compact ? JSON.stringify(compactArchiveResult(result)) : JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const args = { planFile: "", envFile: ".env", baseUrl: "", token: "", moviesPath: "", tvShowsPath: "", yes: false, compact: false, openListTaskId: "", timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--compact") args.compact = true;
    else if (arg === "--plan-file") args.planFile = argv[++i] || "";
    else if (arg === "--openlist-task-id") args.openListTaskId = argv[++i] || "";
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
  storePath = undefined, lockDir = undefined, openListTaskId = ""
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
    if (record?.verified === true) {
      if (openListTaskId) {
        await recordArchiveOperation({
          source: item.source, target: item.target, resourceGroupId: item.resourceGroupId,
          openListTaskId, verified: true
        }, { storePath });
      }
      alreadyArchived.push({ source: item.source, target: item.target, verified: true, verifiedAt: record.verifiedAt });
    } else preflightValidated.push(item);
  }
  const validated = preflightValidated.filter(isArchiveEligible);
  const awaitingUserConfirmation = preflightValidated.filter((item) => !isArchiveEligible(item)).length;
  if (preflightValidated.length === 0) {
    return {
      ok: true, tool: "media-archive", mode: "idempotent-noop", mutated: false,
      eligible: eligible.length, skipped, alreadyArchived, preflight: [], executed: [],
      awaitingUserConfirmation: 0,
      safety: { overwrite: false, delete: false, copy: false },
      nextAction: "archive_already_complete"
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

  // Recheck all sources and all targets before any mutation.
  const preflight = [];
  for (const item of preflightValidated) {
    // Do not issue a separate source-existence read. The OpenList move API is authoritative:
    // it succeeds for a valid source and returns an error for a missing/invalid one.
    const targetInfo = await inspectDirectory(item.targetDir);
    const existingTarget = targetInfo.missing.length === 0
      ? targetInfo.rows.find((entry) => sameName(entry.name, item.targetName))
      : null;
    const targetNameExists = Boolean(existingTarget);
    preflight.push({
      source: item.source, target: item.target, ok: !targetNameExists,
      conflict: targetNameExists,
      ...(existingTarget ? {
        existingTarget: {
          name: existingTarget.name,
          type: existingTarget.isDir ? "directory" : "file",
          ...(Number.isFinite(existingTarget.size) ? { size: existingTarget.size } : {}),
          ...(existingTarget.modified ? { modified: existingTarget.modified } : {})
        }
      } : {}),
      missingDirectories: targetInfo.missing,
      reason: targetNameExists ? "目标已存在，禁止覆盖；请先向用户展示现有目标信息并确认后续处理。" : ""
    });
  }

  const blocked = preflight.filter((entry) => !entry.ok);
  if (blocked.length) {
    return {
      ok: false, tool: "media-archive", mode: yes ? "execution-blocked" : "read-only-dry-run",
      mutated: false, eligible: eligible.length, skipped, alreadyArchived,
      preflight, executed: [], awaitingUserConfirmation,
      nextAction: "resolve_conflicts_or_missing_sources"
    };
  }

  if (!yes) {
    return {
      ok: true, tool: "media-archive", mode: "read-only-dry-run", mutated: false,
      eligible: eligible.length, skipped, alreadyArchived,
      preflight, executed: [], awaitingUserConfirmation,
      safety: { overwrite: false, delete: false, copy: false, note: "仅检查源文件和目标路径；未创建目录、移动或重命名文件。" },
      nextAction: awaitingUserConfirmation > 0 ? "confirm_review_items" : "review_and_confirm_with_yes"
    };
  }

  if (validated.length === 0) {
    return {
      ok: true, tool: "media-archive", mode: "awaiting-user-confirmation", mutated: false,
      eligible: 0, skipped, alreadyArchived, preflight, executed: [],
      awaitingUserConfirmation,
      safety: { overwrite: false, delete: false, copy: false },
      nextAction: "confirm_review_items"
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
        // OpenList move/rename API success is the completion signal; do not list the target again.
        // "verified" below preserves the ledger contract and means API-confirmed operation, not byte-level integrity.
        if (item.resourceGroupId || openListTaskId) {
          await recordArchiveOperation({
            source: item.source, target: item.target,
            resourceGroupId: item.resourceGroupId, openListTaskId, verified: true
          }, { storePath });
        }
        executed.push({ source: item.source, target: item.target, ok: true, apiConfirmed: true, verified: true });
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
    ok: success, tool: "media-archive", mode: "openlist-move-and-rename",
    mutated: executed.some((entry) => entry.ok), eligible: eligible.length, skipped, alreadyArchived,
    preflight, executed,
    safety: { overwrite: false, delete: false, copy: false, stopOnFirstError: true, idempotencyLedger: true, resourceLocks: true },
    confirmedReviewCount: validated.filter((item) => item.confirmedReview).length,
    awaitingUserConfirmation,
    ...(openListTaskId ? { openListTaskId } : {}),
    nextAction: success ? "archive_complete" : "inspect_partial_execution_before_retry"
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
    preflight: (result.preflight || []).map((item) => pick(item, ["source", "target", "ok", "conflict", "existingTarget", "missingDirectories", "reason"])),
    executed: (result.executed || []).map((item) => pick(item, ["source", "target", "ok", "apiConfirmed", "verified", "error"])),
    ...(result.openListTaskId ? { openListTaskId: result.openListTaskId } : {}),
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
            all.push({
              name,
              isDir: Boolean(row.is_dir ?? row.isDir ?? row.type === 1),
              ...(row.size != null && Number.isFinite(Number(row.size)) ? { size: Number(row.size) } : {}),
              ...((row.modified || row.updated_at) ? { modified: String(row.modified || row.updated_at) } : {})
            });
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
