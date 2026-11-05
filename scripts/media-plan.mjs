#!/usr/bin/env node

/**
 * 只读扫描 OpenList 暂存目录，识别电影/剧集候选并生成归档预览；不复制、移动、重命名或删除文件。
 *
 * 本文件说明：函数注释解释职责和关键边界；本次修改只增加注释，不改变原有执行逻辑。
 * 安全约束：只读预览与真实写入必须严格区分；测试写入必须限制在专用目录并要求显式确认。
 */

/**
 * 只读扫描 OpenList 暂存目录，识别电影/剧集候选并生成归档预览；不复制、移动、重命名或删除任何文件。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./check-env.mjs";
import { buildMovieFileName, buildSeriesFileName, extractEpisode, extractResolution, extractYear, parseChineseNumber as parseChineseNumberShared, resolveMediaTitle, DEFAULT_TITLE_ALIASES } from "./media-identity.mjs";

const DEFAULT_ENV_FILE = ".env";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_ITEMS = 1000;
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".wmv", ".ts", ".webm"]);

// 仅在直接执行脚本时启动主流程；作为模块导入时不产生网络请求或其他副作用。
  if (isCliEntryPoint()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
/** CLI 入口：组装任务字段并交由状态库验证；不在 CLI 层绕过状态机规则。 */
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
  // 此处只读取 OpenList 目录树，后续 buildMediaPlan 只生成建议，不执行文件操作。
  const scanned = await scanTree({ ...context, rootPath: sourcePath });
  // 只读建立目标库索引，用于检查精确目标文件是否已存在；扫描不完整时保守转人工复核。
  const [movieIndex, seriesIndex] = await Promise.all([
    scanTree({ ...context, rootPath: moviesPath }),
    scanTree({ ...context, rootPath: tvShowsPath })
  ]);
  const existingPaths = [...movieIndex.items, ...seriesIndex.items].map((item) => item.path);
  const destinationScanComplete = !movieIndex.truncated && !seriesIndex.truncated;
  const aliases = loadTitleAliases(env.MEDIA_TITLE_ALIASES_FILE);
  const plan = buildMediaPlan({ sourcePath, items: scanned.items, moviesPath, tvShowsPath, existingPaths, destinationScanComplete, aliases });
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

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；遇到未知参数时明确报错。 */
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

/** 读取指定 .env 文件并与当前进程环境变量合并；调用方环境变量优先，避免覆盖部署环境注入值。 */
/** 读取 .env 并合并进程环境变量；进程环境变量优先，不覆盖运行环境注入的配置。 */
function loadEnv(envFile) {
  if (!envFile || !fs.existsSync(envFile)) return {};
  return parseDotEnv(fs.readFileSync(envFile, "utf8"));
}

/** 从指定 OpenList 根目录递归读取目录树，并受最大深度和最大条目数限制，避免扫描失控。 */
/** 处理 scanTree 相关逻辑；请结合调用位置核对输入、返回值及错误处理。 */
async function scanTree({ baseUrl, token, fetchImpl, timeoutMs, rootPath }) {
  const items = [];
  let truncated = false;
  /** 处理 visit 相关逻辑；请结合调用位置核对输入、返回值及错误处理。 */
  async function visit(dirPath, depth) {
    if (depth > MAX_SCAN_DEPTH || items.length >= MAX_SCAN_ITEMS) {
      truncated = true;
      return;
    }
    const rows = await listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath });
    if (rows.length >= 200) truncated = true;
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

/** 调用 OpenList fs/list 读取一个目录；只返回名称、类型、大小和修改时间等规划所需信息。 */
/** 读取 OpenList 指定目录，检查测试目录是否已经存在。 */
async function listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath }) {
  if (!baseUrl || !token) throw new Error("OPENLIST_BASE_URL 或 OPENLIST_TOKEN 缺失。");
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境没有 fetch，请升级到 Node.js 20 或更新版本。");
  // 为本次请求设置可中止控制器，避免网络无响应时脚本无限等待。
  const controller = new AbortController();
  // 请求超时后主动中止底层 fetch；finally 中会清理定时器。
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    // 通过 OpenList API 访问存储；不得改用本机 fs 操作绕过 OpenList 的路径和权限边界。
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

/** 根据暂存目录的一级资源和视频文件证据生成候选归档计划；模糊项目保留人工复核，不执行文件变更。 */
/** 构造流程需要的数据结构或预览计划；不应隐式执行远端写入。 */
function buildMediaPlan({ sourcePath, items = [], moviesPath, tvShowsPath, existingPaths = [], destinationScanComplete = true, aliases = undefined }) {
  const topLevel = items.filter((item) => item.parentPath === sourcePath);
  const existing = new Set(existingPaths.map((value) => String(value).toLocaleLowerCase("zh-CN")));
  const plan = [];

  for (const entry of topLevel) {
    const descendants = items.filter((item) => item.path.startsWith(\`\${entry.path}/\`) && !item.isDir);
    const files = entry.isDir ? descendants : [entry];
    const videoFiles = files.filter((item) => VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase()));
    if (videoFiles.length === 0) {
      plan.push({
        source: entry.path, target: null, resourceName: stripExtension(entry.name),
        resourceType: "non-video-or-unknown", confidence: "low", status: "review_required",
        reason: "未发现可识别的视频文件；保留在暂存目录，等待分析或人工处理。"
      });
      continue;
    }

    const rawName = sanitizeName(entry.isDir ? entry.name : stripExtension(entry.name));
    const year = extractYear(rawName);
    const identityInput = rawName
      .replace(/(?:19|20)\d{2}/, "")
      .replace(/S\d{1,2}(?:E\d{1,3})?|EP?\.?\s*\d{1,3}|第[一二三四五六七八九十百\d]+(?:季|集)/ig, "")
      .replace(/(?:2160p|2048p|1440p|1080p|720p|480p|2048|4k|2k|uhd|fhd)/ig, "")
      .replace(/[()[\]{}（）【】]/g, " ")
      .replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
    const identity = resolveMediaTitle(identityInput, aliases);
    const resourceName = identity.canonicalTitle || rawName;
    const relativeFiles = videoFiles.map((file) => ({
      ...file,
      relativeName: file.path.slice(entry.path.length).replace(/^\//, ""),
      name: entry.isDir ? file.path.slice(entry.path.length).replace(/^\//, "") : file.name
    }));
    const classification = classifyMedia({ resourceName: rawName, files: relativeFiles, isDirectory: entry.isDir });
    const aliasNeedsReview = identity.matchType === "alias" || identity.candidates?.length > 0;
    const base = classification.type === "movie" ? moviesPath : classification.type === "series" ? tvShowsPath : "";

    for (const file of relativeFiles) {
      const extension = path.extname(file.name).toLowerCase();
      const resolution = extractResolution(file.name);
      const episode = extractEpisode(file.name);
      const fileYear = extractYear(file.name) || year;
      let targetDir = "";
      let targetName = "";
      let reviewReasons = [];

      if (!base || classification.confidence === "low") {
        reviewReasons.push(classification.reason);
      } else if (classification.confidence !== "high") {
        reviewReasons.push("识别置信度一般；先展示归档建议，等待用户确认。");
      }
      if (base && classification.type === "movie" && classification.confidence !== "low") {
        const movieFolder = fileYear ? \`\${resourceName} (\${fileYear})\` : resourceName;
        targetDir = joinOpenListPath(base, movieFolder);
        targetName = buildMovieFileName(resourceName, fileYear, resolution.value, extension);
      } else {
        const season = episode.season || detectSeason(\`\${file.relativeName} \${rawName}\`);
        if (!season || !episode.episode) {
          reviewReasons.push("已识别为剧集，但季数或集数不完整；不能安全生成 Season 目录和集名。");
        } else {
          targetDir = joinOpenListPath(joinOpenListPath(base, resourceName), \`Season \${String(season).padStart(2, "0")}\`);
          targetName = buildSeriesFileName(resourceName, season, episode.episode, resolution.value, extension);
        }
      }

      if (aliasNeedsReview) {
        reviewReasons.push("片名疑似别名、谐音或近似写法；请确认候选影片后再归档。");
      }
      if (!destinationScanComplete) {
        reviewReasons.push("目标媒体库扫描达到安全上限，无法完整排除同名文件冲突。");
      }

      const target = targetDir && targetName ? joinOpenListPath(targetDir, targetName) : null;
      const conflict = target ? existing.has(target.toLocaleLowerCase("zh-CN")) : false;
      if (conflict) reviewReasons.push("目标路径已存在同名文件；已暂停该文件，不覆盖现有内容。");

      const reviewRequired = reviewReasons.length > 0;
      plan.push({
        source: file.path,
        target,
        resourceName,
        originalResourceName: rawName,
        resourceType: classification.type,
        confidence: aliasNeedsReview ? "medium" : classification.confidence,
        status: conflict ? "conflict" : reviewRequired ? "review_required" : "auto_archive_candidate",
        year: fileYear || null,
        season: episode.season || (classification.type === "series" ? detectSeason(\`\${file.relativeName} \${rawName}\`) : null),
        episode: episode.episode || null,
        resolution: resolution.value,
        resolutionSource: resolution.source,
        titleMatch: identity,
        conflict,
        reason: reviewReasons.length ? reviewReasons.join("；") : classification.reason
      });
    }
  }
  return plan;
}

/** 依据资源名称和文件名中的集数/季数标记判断电影或剧集；仅有视频文件本身不足以高置信度认定电影。 */
/** 处理 classifyMedia 相关逻辑；请结合调用位置核对输入、返回值及错误处理。 */
function classifyMedia({ resourceName, files, isDirectory = false }) {
  const haystack = [resourceName, ...files.map((file) => file.name)].join(" ");
  const hasVideo = files.some((file) => VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()));
  const episodeRecords = files.map((file) => extractEpisode(file.name));
  const hasExplicitEpisode = episodeRecords.some((item) => item.episode != null);
  const hasSeasonEpisode = episodeRecords.some((item) => item.season != null && item.episode != null) ||
    (episodeRecords.some((item) => item.episode != null) && detectSeason(haystack) != null);
  const seriesWords = /(电视剧|剧集|番剧|动漫|连续剧|美剧|英剧|韩剧|日剧|Season\s*\d{1,2}|S\d{1,2}(?:E\d{1,3})?|第[一二三四五六七八九十百\d]+季)/i;
  if (hasExplicitEpisode || seriesWords.test(haystack)) {
    return {
      type: "series",
      confidence: hasSeasonEpisode ? "high" : "medium",
      reason: hasSeasonEpisode ? "文件名包含明确的季集编号。" : "检测到剧集或集数线索，但季集信息仍需核实。"
    };
  }
  const year = extractYear(resourceName) || files.some((file) => extractYear(file.name));
  const directoryMatchesVideo = isDirectory && files.some((file) =>
    normalizeComparableName(stripExtension(file.name)) === normalizeComparableName(resourceName)
  );
  if (hasVideo && (year || directoryMatchesVideo)) {
    return {
      type: "movie",
      confidence: "high",
      reason: year ? "检测到明确电影年份。" : "目录名与主视频文件名一致，符合电影目录结构。"
    };
  }
  if (hasVideo && isDirectory && files.length === 1) {
    return { type: "movie", confidence: "medium", reason: "目录内只有一个视频文件，可能是电影；需要确认资源类型。" };
  }
  return { type: hasVideo ? "unknown" : "unknown", confidence: "low", reason: "视频文件缺少足够的电影或剧集身份线索；先分析候选，不自动归档。" };
}

function normalizeComparableName(value) {
  return String(value || "").normalize("NFKC").toLowerCase()
    .replace(/(?:2160p|2048p|1080p|720p|480p|4k|2k|uhd|fhd)/ig, "")
    .replace(/(?:19|20)\d{2}/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** 移除明确季集标记并规范化剧集名称。 */
/** 规范化数据或参数，统一字段和格式，减少上游差异。 */
function normalizeSeriesName(value) {
  return sanitizeName(String(value || "")
    .replace(/\s*(?:S\d{1,2}E\d{1,3}|EP?\.?\s*\d{1,3}|第[一二三四五六七八九十百\d]+集|全\d{1,4}集).*$/i, "")
    .replace(/\s*(?:Season\s*\d{1,2}|第[一二三四五六七八九十百\d]+季).*$/i, ""));
}

/** 从明确的 SxxExx、Season N 或“第 N 季”标记中提取季数；不根据标题中孤立数字猜季数。 */
/** 处理 detectSeason 相关逻辑；请结合调用位置核对输入、返回值及错误处理。 */
function detectSeason(value) {
  const text = String(value || "");
  const episode = text.match(/S(\d{1,2})E\d{1,3}/i);
  if (episode) return Number(episode[1]);
  const englishSeason = text.match(/Season\s*(\d{1,2})/i);
  if (englishSeason) return Number(englishSeason[1]);
  const chineseSeason = text.match(/第([一二三四五六七八九十百\d]+)季/);
  return chineseSeason ? parseChineseNumber(chineseSeason[1]) : null;
}

/** 将支持范围内的中文数字转换为整数，供季数识别使用。 */
/** 解析输入并返回规范化结果；不合法的输入应明确报错。 */
function parseChineseNumber(value) {
  const text = String(value || "");
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + (digits[text[1]] || 0);
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return (tens ? digits[tens] || 0 : 1) * 10 + (ones ? digits[ones] || 0 : 0);
  }
  return digits[text] ?? null;
}

/** 汇总计划条目数、电影/剧集数量、待复核数量和低置信度数量。 */
/** 处理 summarizePlan 相关逻辑；请结合调用位置核对输入、返回值及错误处理。 */
function summarizePlan(plan) {
  return {
    total: plan.length,
    movies: plan.filter((item) => item.resourceType === "movie").length,
    series: plan.filter((item) => item.resourceType === "series").length,
    autoArchiveCandidates: plan.filter((item) => item.status === "auto_archive_candidate").length,
    conflicts: plan.filter((item) => item.status === "conflict").length,
    reviewRequired: plan.filter((item) => item.status === "review_required").length,
    lowConfidence: plan.filter((item) => item.confidence === "low").length
  };
}

/** 把只读归档计划转换为便于人工审阅的文本，不会触发计划执行。 */
/** 将内部结果转换为可读输出，不执行数据变更。 */
function formatPlan(result) {
  const lines = ["### 媒体归档预览（只读）", "", `扫描：${result.source.path}（${result.source.scannedItems} 项）`, `电影：${result.targets.movies}`, `剧集：${result.targets.tvShows}`, ""];
  for (const item of result.plan) {
    lines.push(`- [${item.status}] ${item.source} → ${item.target || "暂不归档"}（${item.resourceType} / ${item.confidence}）：${item.reason}`);
  }
  lines.push("", "未执行任何文件变更。请先审阅计划，再决定是否开发后续归档执行功能。");
  return lines.join("\n");
}

/** 验证并规范化 OpenList 可见路径，拒绝空路径和路径穿越片段。 */
/** 规范化数据或参数，统一字段和格式，减少上游差异。 */
function normalizeOpenListPath(value) {
  const text = String(value || "").trim();
  if (!text || !text.startsWith("/") || text.includes("..")) return "";
  return text.replace(/\/+$/g, "") || "/";
}

/** 在 OpenList 路径规则下拼接父目录和子路径。 */
/** 处理 joinOpenListPath 相关逻辑；请结合调用位置核对输入、返回值及错误处理。 */
function joinOpenListPath(dir, name) {
  const base = String(dir || "").replace(/\/+$/g, "") || "/";
  const child = String(name || "").replace(/^\/+|\/+$/g, "");
  if (!child) return base;
  return base === "/" ? `/${child}` : `${base}/${child}`;
}

/** 处理sanitizeName相关逻辑。请结合调用位置检查输入来源、返回值及异常传播方式。 */
/** 处理 sanitizeName 相关逻辑；请结合调用位置核对输入、返回值及错误处理。 */
function sanitizeName(value) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() || "Unsorted";
}

/** 移除文件名末尾扩展名。 */
/** 处理 stripExtension 相关逻辑；请结合调用位置核对输入、返回值及错误处理。 */
function stripExtension(value) {
  return String(value || "").replace(/\.[^.]+$/, "");
}

/** 确认模块是直接运行而非被导入，避免导入时触发命令行副作用。 */
/** 判断当前模块是否作为命令行入口直接运行。 */
function isCliEntryPoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export {
  buildMediaPlan,
  classifyMedia,
  detectSeason,
  normalizeSeriesName,
  parseArgs,
  parseChineseNumber,
  resolveMediaTitle,
  scanTree
};/** 读取可选的本地片名别名表；文件不存在时使用内置示例，格式错误时中止而不是静默忽略。 */
function loadTitleAliases(filePath) {
  if (!filePath) return DEFAULT_TITLE_ALIASES;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return DEFAULT_TITLE_ALIASES;
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MEDIA_TITLE_ALIASES_FILE 必须是“标准片名: 别名数组”的 JSON 对象。");
  }
  return { ...DEFAULT_TITLE_ALIASES, ...parsed };
}


