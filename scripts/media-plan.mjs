#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./check-env.mjs";

const DEFAULT_ENV_FILE = ".env";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_ITEMS = 1000;
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".wmv", ".ts", ".webm"]);

if (isCliEntryPoint()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv(args.envFile);
  const sourcePath = normalizeOpenListPath(args.sourcePath || env.OPENLIST_STAGING_PATH);
  const moviesPath = normalizeOpenListPath(args.moviesPath || env.MEDIA_MOVIES_PATH);
  const tvShowsPath = normalizeOpenListPath(args.tvShowsPath || env.MEDIA_TVSHOWS_PATH);

  if (!sourcePath) throw new Error("缺少暂存目录。请配置 OPENLIST_STAGING_PATH 或传 --source-dir。");
  if (!moviesPath || !tvShowsPath) {
    throw new Error("缺少媒体库目标路径。请分别配置 MEDIA_MOVIES_PATH 和 MEDIA_TVSHOWS_PATH（均为 OpenList 路径）。");
  }

  const context = {
    baseUrl: args.baseUrl || env.OPENLIST_BASE_URL,
    token: args.token || env.OPENLIST_TOKEN,
    fetchImpl: globalThis.fetch,
    timeoutMs: args.timeoutMs
  };
  const scanned = await scanTree({ ...context, rootPath: sourcePath });
  const plan = buildMediaPlan({ sourcePath, items: scanned.items, moviesPath, tvShowsPath });
  const result = {
    ok: true,
    tool: "media-plan",
    mode: "read-only-dry-run",
    mutated: false,
    source: { path: sourcePath, scannedItems: scanned.items.length, truncated: scanned.truncated },
    targets: { movies: moviesPath, tvShows: tvShowsPath },
    summary: summarizePlan(plan),
    plan,
    safety: {
      executed: false,
      note: "本命令只调用 OpenList fs/list 读取暂存目录，不执行复制、移动、重命名或删除。"
    },
    nextAction: "review_plan"
  };
  console.log(args.format === "text" ? formatPlan(result) : JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const parsed = {
    sourcePath: "",
    moviesPath: "",
    tvShowsPath: "",
    envFile: DEFAULT_ENV_FILE,
    baseUrl: "",
    token: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    format: "json"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-dir" || arg === "--source") parsed.sourcePath = argv[++i] || "";
    else if (arg === "--movies-dir") parsed.moviesPath = argv[++i] || "";
    else if (arg === "--tvshows-dir") parsed.tvShowsPath = argv[++i] || "";
    else if (arg === "--env-file") parsed.envFile = argv[++i] || DEFAULT_ENV_FILE;
    else if (arg === "--base-url") parsed.baseUrl = argv[++i] || "";
    else if (arg === "--token") parsed.token = argv[++i] || "";
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++i] || DEFAULT_TIMEOUT_MS);
    else if (arg === "--format") parsed.format = argv[++i] || "json";
    else if (arg === "--json") parsed.format = "json";
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (!parsed.sourcePath) parsed.sourcePath = arg;
    else throw new Error(`Unexpected positional argument: ${arg}`);
  }
  if (!["json", "text"].includes(parsed.format)) throw new Error("--format 只支持 json 或 text。");
  return parsed;
}

function loadEnv(envFile) {
  return envFile ? parseDotEnv(readEnvFile(envFile)) : {};
}

function readEnvFile(envFile) {
  // Avoid a dependency on dotenv; the CLI only needs the existing shared parser.
  try {
    return requireFileText(envFile);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function requireFileText(envFile) {
  // Node's built-in fs is loaded lazily to keep this module's pure helpers easy to test.
  return fsReadFileSync(envFile, "utf8");
}

import { readFileSync as fsReadFileSync } from "node:fs";

async function scanTree({ baseUrl, token, fetchImpl, timeoutMs, rootPath }) {
  const items = [];
  let truncated = false;
  async function visit(dirPath, depth) {
    if (depth > MAX_SCAN_DEPTH || items.length >= MAX_SCAN_ITEMS) {
      truncated = true;
      return;
    }
    const rows = await listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath });
    for (const row of rows) {
      if (items.length >= MAX_SCAN_ITEMS) {
        truncated = true;
        return;
      }
      const item = { ...row, path: joinOpenListPath(dirPath, row.name), parentPath: dirPath };
      items.push(item);
      if (item.isDir) await visit(item.path, depth + 1);
    }
  }
  await visit(rootPath, 0);
  return { items, truncated };
}

async function listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath }) {
  if (!baseUrl || !token) throw new Error("OPENLIST_BASE_URL 或 OPENLIST_TOKEN 缺失。");
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境没有 fetch，请升级到 Node.js 20 或更新版本。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/g, "")}/api/fs/list`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: token
      },
      body: JSON.stringify({ path: dirPath, password: "", page: 1, per_page: 200, refresh: true }),
      signal: controller.signal
    });
    const raw = await response.text();
    let json;
    try { json = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`OpenList 返回非 JSON 内容：${raw.slice(0, 120)}`); }
    if (!response.ok || !(json.code === 200 || json.code === 0 || json.message === "success")) {
      throw new Error(`OpenList 读取失败（${dirPath}）：${json.message || response.status || "unknown"}`);
    }
    const rows = Array.isArray(json?.data?.content) ? json.data.content : Array.isArray(json?.data) ? json.data : [];
    return rows.map((row) => ({
      name: String(row.name || ""),
      isDir: Boolean(row.is_dir ?? row.isDir ?? row.type === 1),
      size: Number(row.size || 0),
      modified: row.modified || row.updated_at || ""
    })).filter((row) => row.name && row.name !== "." && row.name !== "..");
  } finally {
    clearTimeout(timeout);
  }
}

function buildMediaPlan({ sourcePath, items = [], moviesPath, tvShowsPath }) {
  const topLevel = items.filter((item) => item.parentPath === sourcePath);
  const plan = [];
  for (const entry of topLevel) {
    const descendants = items.filter((item) => item.path.startsWith(`${entry.path}/`) && !item.isDir);
    const files = entry.isDir ? descendants : [entry];
    const videoFiles = files.filter((item) => VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase()));
    if (videoFiles.length === 0) {
      plan.push({
        source: entry.path,
        target: null,
        resourceName: stripExtension(entry.name),
        resourceType: "non-video-or-unknown",
        confidence: "low",
        status: "review_required",
        reason: "未发现可识别的视频文件；保留在暂存目录，不自动归档。"
      });
      continue;
    }
    const resourceName = sanitizeName(entry.isDir ? entry.name : stripExtension(entry.name));
    const classification = classifyMedia({ resourceName, files: videoFiles });
    const base = classification.type === "movie" ? moviesPath : classification.type === "series" ? tvShowsPath : "";
    if (!base) {
      plan.push({
        source: entry.path,
        target: null,
        resourceName,
        resourceType: classification.type,
        confidence: classification.confidence,
        status: "review_required",
        reason: classification.reason
      });
      continue;
    }
    for (const file of videoFiles) {
      const relative = file.path.slice(entry.path.length).replace(/^\//, "");
      const season = classification.type === "series" ? detectSeason(file.name) : null;
      const targetDir = classification.type === "movie"
        ? joinOpenListPath(joinOpenListPath(base, resourceName), path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative))
        : season
          ? joinOpenListPath(joinOpenListPath(base, resourceName), `Season ${String(season).padStart(2, "0")}`)
          : joinOpenListPath(base, resourceName);
      plan.push({
        source: file.path,
        target: joinOpenListPath(targetDir, file.name),
        resourceName,
        resourceType: classification.type,
        confidence: classification.confidence,
        status: "preview_only",
        reason: classification.type === "series" && !season
          ? "已识别为剧集，但文件名未提供可靠季数；暂放剧集根目录，不猜测季数。"
          : classification.reason
      });
    }
  }
  return plan;
}

function classifyMedia({ resourceName, files }) {
  const haystack = [resourceName, ...files.map((file) => file.name)].join(" ");
  const episodePattern = /(?:S\d{1,2}E\d{1,3}|\bE\d{1,3}\b|EP\.?\s*\d{1,3}|第[一二三四五六七八九十百\d]+集|全\d{1,4}集)/i;
  const seriesWords = /(电视剧|剧集|番剧|动漫|连续剧|美剧|英剧|韩剧|日剧|第[一二三四五六七八九十\d]+季)/i;
  if (episodePattern.test(haystack) || seriesWords.test(haystack)) {
    return { type: "series", confidence: episodePattern.test(haystack) ? "high" : "medium", reason: "检测到明确集数或剧集关键词。" };
  }
  if (files.some((file) => VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()))) {
    return { type: "movie", confidence: "low", reason: "仅能确认包含视频文件，未发现明确剧集标记；电影归类仍需人工复核。" };
  }
  return { type: "unknown", confidence: "low", reason: "资源类型无法可靠判断。" };
}

function detectSeason(value) {
  const text = String(value || "");
  const match = text.match(/S(\d{1,2})E\d{1,3}|第([一二三四五六七八九十百\d]+)季/i);
  if (!match) return null;
  if (match[1]) return Number(match[1]);
  return parseChineseNumber(match[2]);
}

function parseChineseNumber(value) {
  const text = String(value || "");
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + (digits[text[1]] || 0);
  if (text.includes("十")) return (digits[text[0]] || 0) * 10 + (digits[text[2]] || 0);
  return digits[text] ?? null;
}

function summarizePlan(plan) {
  return {
    total: plan.length,
    movies: plan.filter((item) => item.resourceType === "movie").length,
    series: plan.filter((item) => item.resourceType === "series").length,
    reviewRequired: plan.filter((item) => item.status === "review_required").length,
    lowConfidence: plan.filter((item) => item.confidence === "low").length
  };
}

function formatPlan(result) {
  const lines = ["### 媒体归档预览（只读）", "", `扫描：${result.source.path}（${result.source.scannedItems} 项）`, `电影：${result.targets.movies}`, `剧集：${result.targets.tvShows}`, ""];
  for (const item of result.plan) {
    lines.push(`- [${item.status}] ${item.source} → ${item.target || "暂不归档"}（${item.resourceType} / ${item.confidence}）：${item.reason}`);
  }
  lines.push("", "未执行任何文件变更。请先审阅计划，再决定是否开发后续归档执行功能。");
  return lines.join("\n");
}

function normalizeOpenListPath(value) {
  const text = String(value || "").trim();
  if (!text || !text.startsWith("/") || text.includes("..")) return "";
  return text.replace(/\/+$/g, "") || "/";
}

function joinOpenListPath(dir, name) {
  const base = String(dir || "").replace(/\/+$/g, "") || "/";
  const child = String(name || "").replace(/^\/+|\/+$/g, "");
  if (!child) return base;
  return base === "/" ? `/${child}` : `${base}/${child}`;
}

function sanitizeName(value) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() || "Unsorted";
}

function stripExtension(value) {
  return String(value || "").replace(/\.[^.]+$/, "");
}

function isCliEntryPoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export {
  buildMediaPlan,
  classifyMedia,
  detectSeason,
  parseArgs,
  parseChineseNumber,
  scanTree
};
