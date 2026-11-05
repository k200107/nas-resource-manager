#!/usr/bin/env node

/**
 * Execute a reviewed media plan through OpenList APIs.
 * Default mode is read-only. Mutations require an explicit --yes flag.
 * Existing targets are never overwritten; all items are rechecked immediately before execution.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./check-env.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.planFile) throw new Error("请通过 --plan-file 指定 media-plan 输出的 JSON 文件。");
  const envFile = args.envFile || ".env";
  const fileEnv = envFile && fs.existsSync(envFile) ? parseDotEnv(fs.readFileSync(envFile, "utf8")) : {};
  const env = { ...fileEnv, ...process.env };
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
    timeoutMs: args.timeoutMs
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const args = { planFile: "", envFile: ".env", baseUrl: "", token: "", moviesPath: "", tvShowsPath: "", yes: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") args.yes = true;
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
 * Plan contract: each item has source, target, resourceType and status.
 * Only auto_archive_candidate entries are eligible. No delete/copy endpoint is used.
 */
async function runMediaArchive({
  plan, baseUrl, token, moviesPath, tvShowsPath, yes = false,
  fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!Array.isArray(plan)) throw new Error("plan 必须是数组。");
  if (!baseUrl || !token) throw new Error("OPENLIST_BASE_URL 或 OPENLIST_TOKEN 缺失。");
  if (!moviesPath || !tvShowsPath || moviesPath === "/" || tvShowsPath === "/") throw new Error("必须提供有效的 Movies 和 TVShows 根目录。");
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持 fetch，请使用 Node.js 20 或更新版本。");

  const eligible = plan.filter((item) => item?.status === "auto_archive_candidate" && item.source && item.target);
  const skipped = plan.length - eligible.length;
  const validated = eligible.map((item) => validatePlanItem(item, { moviesPath, tvShowsPath }));
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
  for (const item of validated) {
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
      mutated: false, eligible: eligible.length, skipped,
      preflight, executed: [], nextAction: "resolve_conflicts_or_missing_sources"
    };
  }

  if (!yes) {
    return {
      ok: true, tool: "media-archive", mode: "read-only-dry-run", mutated: false,
      eligible: eligible.length, skipped,
      preflight, executed: [],
      safety: { overwrite: false, delete: false, copy: false, note: "仅检查源文件和目标路径；未创建目录、移动或重命名文件。" },
      nextAction: "review_and_confirm_with_yes"
    };
  }

  const executed = [];
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
      executed.push({ source: item.source, target: item.target, ok: true, verified: true });
    } catch (error) {
      executed.push({ source: item.source, target: item.target, ok: false, verified: false, error: error.message || String(error) });
      // Stop on first uncertain result. Do not retry blindly or remove the source.
      break;
    }
  }

  const success = executed.length === validated.length && executed.every((entry) => entry.ok);
  return {
    ok: success, tool: "media-archive", mode: "openlist-move-and-rename",
    mutated: executed.some((entry) => entry.ok), eligible: eligible.length, skipped,
    preflight, executed,
    safety: { overwrite: false, delete: false, copy: false, stopOnFirstError: true },
    nextAction: success ? "archive_complete" : "inspect_partial_execution_before_retry"
  };
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
  return { ...item, source, target, sourceDir: parent(source), sourceName, targetDir: parent(target), targetName };
}

function createApi({ baseUrl, token, fetchImpl, timeoutMs }) {
  async function request(endpoint, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/g, "")}${endpoint}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify(body), signal: controller.signal
      });
      const raw = await response.text();
      let json;
      try { json = raw ? JSON.parse(raw) : {}; }
      catch { throw new Error(`OpenList ${endpoint} 返回非 JSON：${raw.slice(0, 160)}`); }
      if (!response.ok || !(json.code === 200 || json.code === 0 || json.message === "success")) {
        throw new Error(`OpenList ${endpoint} 失败：${json.message || response.status}`);
      }
      return json;
    } finally { clearTimeout(timer); }
  }
  return {
    async list(dir) {
      const all = [];
      const seen = new Set();
      for (let page = 1; page <= 10; page += 1) {
        const json = await request("/api/fs/list", { path: dir, password: "", page, per_page: 200, refresh: true });
        const rows = Array.isArray(json?.data?.content) ? json.data.content : Array.isArray(json?.data) ? json.data : [];
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

export { parseArgs, runMediaArchive, validatePlanItem };
