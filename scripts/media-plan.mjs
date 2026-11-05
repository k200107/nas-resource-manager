#!/usr/bin/env node

/**
 * 只读扫描 OpenList 暂存目录，识别电影/剧集候选并生成归档预览；不复制、移动、重命名或删除文件。
 *
 * 本模块负责只读扫描暂存资源、媒体身份分析、Emby 风格命名规划和目标路径冲突检查。
 * 安全约束：所有远端读取仅使用 OpenList fs/list；规划阶段绝不执行文件复制、移动、重命名或删除。
 */

/**
 * 只读扫描 OpenList 暂存目录，识别电影/剧集候选并生成归档预览；不复制、移动、重命名或删除任何文件。
 *
 * 维护说明：分类、命名和冲突检查均为纯规划逻辑；任何未来归档执行器都必须独立复核任务状态和目标路径。
 * 安全边界：不得绕过 OpenList API 直接访问 NAS 文件系统。
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./check-env.mjs";
import { requestOpenListJson, isOpenListSuccess } from "./openlist-client.mjs";
import { buildMovieFileName, buildSeriesFileName, extractEpisode, extractResolution, extractYear, parseChineseNumber, resolveMediaTitle, DEFAULT_TITLE_ALIASES } from "./media-identity.mjs";
import { buildSidecarPlans, isSidecarFile } from "./media-sidecar.mjs";

const DEFAULT_ENV_FILE = ".env";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_ITEMS = 1000;
const MAX_DIRECTORY_PAGES = 10;
const DIRECTORY_PAGE_SIZE = 200;
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
  // 媒体库根目录不存在时自动创建；只创建用户明确配置的 Movies/TVShows 根路径，不触碰其内部现有文件。
  const createdTargetDirectories = await ensureTargetDirectories({ ...context, paths: [moviesPath, tvShowsPath] });
  // 源目录及媒体库内容仍通过 OpenList fs/list 读取；规划阶段不移动、重命名或删除文件。
  const scanned = await scanTree({ ...context, rootPath: sourcePath });
  const aliases = loadTitleAliases(env.MEDIA_TITLE_ALIASES_FILE);
  const basePlan = buildMediaPlan({ sourcePath, items: scanned.items, moviesPath, tvShowsPath, aliases, sourceScanComplete: !scanned.truncated });
  // 只检查计划涉及的目标父目录，不递归扫描整个媒体库；目标目录读取不完整时保守转人工复核。
  const collisionIndex = await scanTargetConflicts({ ...context, plan: basePlan, moviesPath, tvShowsPath });
  const plan = buildMediaPlan({
    sourcePath, items: scanned.items, moviesPath, tvShowsPath, aliases,
    existingPaths: collisionIndex.existingPaths,
    destinationScanComplete: collisionIndex.complete,
    sourceScanComplete: !scanned.truncated
  });
  const result = {
    ok: true,
    tool: "media-plan",
    mode: createdTargetDirectories.length ? "prepare-target-roots-and-read-only-plan" : "read-only-dry-run",
    mutated: createdTargetDirectories.length > 0,
    createdTargetDirectories,
    source: { path: sourcePath, scannedItems: scanned.items.length, truncated: scanned.truncated },
    targets: { movies: moviesPath, tvShows: tvShowsPath },
    summary: summarizePlan(plan),
    plan,
    safety: {
      executed: false,
      fileOperations: false,
      note: "仅在配置的 Movies/TVShows 根目录或其上级目录不存在时通过 OpenList mkdir 创建；不复制、移动、重命名或删除任何文件。"
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
    if (rows.truncated) truncated = true;
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

/** 通过 OpenList fs/list 分页读取一个目录，并标记是否达到分页安全上限。 */
/** 读取 OpenList 指定目录，检查测试目录是否已经存在。 */
async function listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath }) {
  const allRows = [];
  const seen = new Set();
  let truncated = false;

  for (let page = 1; page <= MAX_DIRECTORY_PAGES; page += 1) {
    const response = await requestOpenListJson({
      baseUrl, token, fetchImpl, timeoutMs,
      endpoint: "/api/fs/list",
      method: "POST",
      body: { path: dirPath, password: "", page, per_page: DIRECTORY_PAGE_SIZE, refresh: true }
    });
    if (!response.ok || !isOpenListSuccess(response.json)) {
      throw new Error(`OpenList 读取失败（${dirPath}，第 ${page} 页）：${response.json?.message || response.status || "unknown"}`);
    }
    const rows = Array.isArray(response.json?.data?.content)
      ? response.json.data.content
      : Array.isArray(response.json?.data) ? response.json.data : [];
    for (const row of rows) {
      const name = String(row.name || "");
      if (!name || name === "." || name === ".." || seen.has(name)) continue;
      seen.add(name);
      allRows.push({
        name,
        isDir: Boolean(row.is_dir ?? row.isDir ?? row.type === 1),
        size: Number(row.size || 0),
        modified: row.modified || row.updated_at || ""
      });
    }
    if (rows.length < DIRECTORY_PAGE_SIZE) break;
    if (page === MAX_DIRECTORY_PAGES) truncated = true;
  }

  allRows.truncated = truncated;
  return allRows;
}
/**
 * 确保配置的目标根目录存在。逐级检查路径；缺少目录时通过 OpenList fs/mkdir 创建，
 * 若同名路径是文件或创建后无法回读，则停止，避免把异常误判为“空目录”。
 */
async function ensureTargetDirectories({ baseUrl, token, fetchImpl, timeoutMs, paths }) {
  const createdDirectories = [];
  for (const targetPath of [...new Set(paths)]) {
    const segments = String(targetPath).split("/").filter(Boolean);
    let current = "/";
    for (const segment of segments) {
      const rows = await listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath: current });
      const existing = rows.find((row) => row.name.toLocaleLowerCase("zh-CN") === segment.toLocaleLowerCase("zh-CN"));
      const next = joinOpenListPath(current, segment);
      if (existing) {
        if (!existing.isDir) throw new Error(`目标目录路径中存在同名文件：${next}`);
      } else {
        const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/g, "")}/api/fs/mkdir`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: token },
          body: JSON.stringify({ path: next }),
          signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS)
        });
        const raw = await response.text();
        let json;
        try { json = raw ? JSON.parse(raw) : {}; }
        catch { throw new Error(`OpenList 创建目录返回非 JSON：${raw.slice(0, 120)}`); }
        if (!response.ok || !(json.code === 200 || json.code === 0 || json.message === "success")) {
          throw new Error(`OpenList 创建目标目录失败（${next}）：${json.message || response.status}`);
        }
        const verifyRows = await listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath: current });
        const created = verifyRows.find((row) => row.name.toLocaleLowerCase("zh-CN") === segment.toLocaleLowerCase("zh-CN"));
        if (!created || !created.isDir) throw new Error(`目标目录创建后验证失败：${next}`);
        createdDirectories.push(next);
      }
      current = next;
    }
  }
  return createdDirectories;
}

/**
 * 仅沿着计划目标的目录链检查目标文件是否存在。
 * 不遍历整个 Movies/TVShows 库；所有读取均通过 OpenList fs/list。
 * 如果目录列表达到 API 分页上限，则不能证明目标不存在，必须交由人工复核。
 */
async function scanTargetConflicts({ baseUrl, token, fetchImpl, timeoutMs, plan, moviesPath, tvShowsPath }) {
  const cache = new Map();
  const existingPaths = new Set();
  let complete = true;

  async function listCached(dirPath) {
    if (!cache.has(dirPath)) {
      const rows = await listDirectory({ baseUrl, token, fetchImpl, timeoutMs, dirPath });
      cache.set(dirPath, rows);
      if (rows.truncated) complete = false;
    }
    return cache.get(dirPath);
  }

  for (const item of plan) {
    if (!item.target) continue;
    const root = item.resourceType === "movie" ? moviesPath : item.resourceType === "series" ? tvShowsPath : "";
    if (!root || !item.target.startsWith(root + "/")) continue;
    const relative = item.target.slice(root.length + 1);
    const segments = relative.split("/");
    if (segments.length < 2) continue;

    let current = root;
    let parentExists = true;
    for (const segment of segments.slice(0, -1)) {
      const rows = await listCached(current);
      const row = rows.find((candidate) => candidate.name.toLocaleLowerCase("zh-CN") === segment.toLocaleLowerCase("zh-CN"));
      if (!row) {
        parentExists = false;
        break;
      }
      if (!row.isDir) {
        existingPaths.add(item.target);
        parentExists = false;
        break;
      }
      current = joinOpenListPath(current, segment);
    }

    if (parentExists) {
      const rows = await listCached(current);
      const targetName = segments.at(-1);
      if (rows.some((candidate) => candidate.name.toLocaleLowerCase("zh-CN") === targetName.toLocaleLowerCase("zh-CN"))) {
        existingPaths.add(item.target);
      }
    }
  }

  return { existingPaths: [...existingPaths], complete };
}

/** 根据暂存目录的一级资源和视频文件证据生成候选归档计划；模糊项目保留人工复核，不执行文件变更。 */
/** 构造流程需要的数据结构或预览计划；不应隐式执行远端写入。 */
function buildMediaPlan({ sourcePath, items = [], moviesPath, tvShowsPath, existingPaths = [], destinationScanComplete = true, sourceScanComplete = true, aliases = undefined }) {
  const topLevel = items.filter((item) => item.parentPath === sourcePath);
  const existing = new Set(existingPaths.map((value) => String(value).toLocaleLowerCase("zh-CN")));
  const plan = [];

  // 年份父目录只作为分类线索，不作为片名；把其下每个资源目录提升为独立识别单元。
  const entries = topLevel.flatMap((entry) => {
    if (!entry.isDir || !extractExplicitYear(entry.name)) return [entry];
    const children = items.filter((item) => item.parentPath === entry.path && item.isDir);
    return children.length ? children.map((child) => ({ ...child, parentYear: extractExplicitYear(entry.name) })) : [entry];
  });

  for (const entry of entries) {
    const descendants = items.filter((item) => item.path.startsWith(`${entry.path}/`) && !item.isDir);
    const files = entry.isDir ? descendants : [entry];
    const videoFiles = files.filter((item) => VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase()));
    const sidecarFiles = files.filter((item) => isSidecarFile(item.name));
    if (videoFiles.length === 0) {
      plan.push({
        source: entry.path, target: null, resourceName: stripExtension(entry.name),
        resourceType: "non-video-or-unknown", confidence: "low", status: "review_required",
        reason: "未发现可识别的视频文件；保留在暂存目录，等待分析或人工处理。"
      });
      continue;
    }

    const rawName = sanitizeName(entry.isDir ? entry.name : stripExtension(entry.name));
    const year = extractExplicitYear(rawName) || entry.parentYear || null;
    const identityInput = rawName
      .replace(/(?:19|20)\d{2}/, "")
      .replace(/S\d{1,2}(?:E\d{1,3})?|EP?\.?\s*\d{1,3}|第[一二三四五六七八九十百\d]+(?:季|集)/ig, "")
      .replace(/(?:2160p|2048p|1440p|1080p|720p|480p|2048|4k|2k|uhd|fhd)/ig, "")
      .replace(/[()[\]{}（）【】]/g, " ")
      .replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
    const identity = resolveMediaTitle(identityInput, aliases);
    const resourceName = sanitizeName(identity.canonicalTitle || rawName);
    const relativeFiles = videoFiles.map((file) => ({
      ...file,
      relativeName: file.path.slice(entry.path.length).replace(/^\//, ""),
      name: entry.isDir ? file.path.slice(entry.path.length).replace(/^\//, "") : file.name
    }));
    const detectedClassification = classifyMedia({ resourceName: rawName, files: relativeFiles, isDirectory: entry.isDir });
    // 明确季集优先于年份；年份父目录作为明确年份线索，不把年份本身当成片名。
    const classification = detectedClassification.type === "series"
      ? detectedClassification
      : year
        ? { type: "movie", confidence: "high", reason: "资源目录或其年份父目录包含明确年份，按电影候选处理。" }
        : detectedClassification;
    const aliasNeedsReview = identity.matchType === "alias" || identity.candidates?.length > 0;
    const base = classification.type === "movie" ? moviesPath : classification.type === "series" ? tvShowsPath : "";
    const videoPlans = [];

    for (const file of relativeFiles) {
      const extension = path.extname(file.name).toLowerCase();
      const resolution = extractResolution(file.name);
      const episode = extractEpisode(file.name);
      const fileYear = extractExplicitYear(file.name) || year;
      let targetDir = "";
      let targetName = "";
      const reviewReasons = [];
      if (!sourceScanComplete) reviewReasons.push("暂存目录扫描未完成，不能确认资源目录和视频文件清单完整。");

      if (!base || classification.confidence === "low") {
        reviewReasons.push(classification.reason);
      } else if (classification.confidence !== "high") {
        reviewReasons.push("识别置信度一般；先展示归档建议，等待用户确认。");
      }
      if (base && classification.type === "movie" && classification.confidence !== "low") {
        const movieFolder = fileYear ? `${resourceName} (${fileYear})` : resourceName;
        targetDir = joinOpenListPath(base, movieFolder);
        targetName = buildMovieFileName(resourceName, fileYear, resolution.value, extension);
      } else if (base && classification.type === "series") {
        const season = episode.season || detectSeason(`${file.relativeName} ${rawName}`);
        if (!season || !episode.episode) {
          reviewReasons.push("已识别为剧集，但季数或集数不完整；不能安全生成 Season 目录和集名。");
        } else {
          targetDir = joinOpenListPath(joinOpenListPath(base, resourceName), `Season ${String(season).padStart(2, "0")}`);
          targetName = buildSeriesFileName(resourceName, season, episode.episode, resolution.value, extension);
        }
      }

      if (aliasNeedsReview) reviewReasons.push("片名疑似别名、谐音或近似写法；请确认候选影片后再归档。");
      if (!destinationScanComplete) reviewReasons.push("目标媒体库扫描达到安全上限，无法完整排除同名文件冲突。");

      const target = targetDir && targetName ? joinOpenListPath(targetDir, targetName) : null;
      const conflict = target ? existing.has(target.toLocaleLowerCase("zh-CN")) : false;
      if (conflict) reviewReasons.push("目标路径已存在同名文件；已暂停该文件，不覆盖现有内容。");
      const reviewRequired = reviewReasons.length > 0;
      videoPlans.push({
        source: file.path, target, resourceName, originalResourceName: rawName,
        resourceType: classification.type, confidence: aliasNeedsReview ? "medium" : classification.confidence,
        status: conflict ? "conflict" : reviewRequired ? "review_required" : "auto_archive_candidate",
        year: fileYear || null,
        season: episode.season || (classification.type === "series" ? detectSeason(`${file.relativeName} ${rawName}`) : null),
        episode: episode.episode || null,
        resolution: resolution.value, resolutionSource: resolution.source,
        titleMatch: identity, conflict,
        resourceGroupId: entry.path,
        assetRole: "video", assetScope: "video",
        reason: reviewReasons.length ? reviewReasons.join("；") : classification.reason
      });
    }
    plan.push(...videoPlans);

    const normalizedSidecars = sidecarFiles.map((file) => ({
      ...file,
      name: entry.isDir ? file.path.slice(entry.path.length).replace(/^\//, "") : file.name
    }));
    const movieFolder = year ? `${resourceName} (${year})` : resourceName;
    const resourceFolder = joinOpenListPath(moviesPath, movieFolder);
    const seriesFolder = joinOpenListPath(tvShowsPath, resourceName);
    const sidecarPlans = buildSidecarPlans({
      sidecarFiles: normalizedSidecars, videoPlans, resourceType: classification.type,
      resourceName, year, resourceFolder, seriesFolder
    });
    for (const sidecar of sidecarPlans) {
      const targetKey = sidecar.target?.toLocaleLowerCase("zh-CN");
      const conflict = Boolean(targetKey && existing.has(targetKey));
      const reviewReasons = [];
      if (!sourceScanComplete) reviewReasons.push("暂存目录扫描未完成，无法确认配套文件清单完整。");
      if (!destinationScanComplete) reviewReasons.push("目标媒体库扫描未完成，无法排除附件冲突。");
      if (aliasNeedsReview) reviewReasons.push("主媒体身份需要人工确认，附件暂不自动归档。");
      if (conflict) reviewReasons.push("配套文件目标路径已存在同名文件；禁止覆盖。");
      const unresolved = !sidecar.target || reviewReasons.length > 0;
      plan.push({
        ...sidecar,
        resourceGroupId: entry.path,
        titleMatch: identity,
        conflict,
        status: conflict ? "conflict" : unresolved ? "review_required" : "auto_archive_candidate",
        confidence: unresolved ? "medium" : "high",
        reason: [...(sidecar.reason ? [sidecar.reason] : []), ...reviewReasons].join("；")
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
  const year = Boolean(extractExplicitYear(resourceName) || files.some((file) => extractExplicitYear(file.name)));
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
    .replace(/(?:2160p|2048p|1440p|1080p|720p|480p|2048|4k|2k|uhd|fhd)/ig, "")
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
function extractExplicitYear(value) {
  const match = String(value || "").match(/(?:^|[^A-Za-z0-9])((?:19|20)[0-9]{2})(?=$|[^A-Za-z0-9])/);
  return match ? Number(match[1]) : null;
}

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
  scanTargetConflicts,
  scanTree,
  ensureTargetDirectories
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


