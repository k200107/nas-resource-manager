/**
 * 媒体配套文件识别与目标命名。
 * 只做本地字符串分析，不访问 NAS；实际移动仍由 media-archive 统一执行。
 */
import path from "node:path";
import { extractEpisode, extractResolution } from "./media-identity.mjs";

const SIDECAR_EXTENSIONS = new Set([
  ".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".sup",
  ".nfo", ".jpg", ".jpeg", ".png", ".webp", ".tbn", ".bmp"
]);
const ARTWORK_NAMES = new Set([
  "poster", "folder", "cover", "fanart", "backdrop", "background",
  "logo", "clearlogo", "clearart", "banner", "landscape", "thumb",
  "thumbnail", "disc", "movie", "season"
]);

export function isSidecarFile(name) {
  return SIDECAR_EXTENSIONS.has(path.extname(String(name || "")).toLowerCase());
}

export function classifySidecar(name) {
  const extension = path.extname(String(name || "")).toLowerCase();
  const stem = path.basename(String(name || ""), extension);
  let episode = extractEpisode(String(name || ""));
  if (episode.episode != null && episode.season == null) {
    const seasonMatch = String(name || "").match(/Season\\s*(\\d{1,2})|第([零〇一二两三四五六七八九十\\d]+)季/i);
    if (seasonMatch) episode = { ...episode, season: Number(seasonMatch[1]) || chineseSeasonNumber(seasonMatch[2]) };
  }
  if ([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".sup"].includes(extension)) {
    const scope = episode.episode != null ? "episode" : extractResolution(name).value ? "version" : "resource";
    return { role: "subtitle", scope, episode };
  }
  if (extension === ".nfo") {
    return { role: "metadata", scope: "resource", episode };
  }
  const base = stem.toLowerCase().replace(/[ ._-]+/g, "");
  const knownArtwork = [...ARTWORK_NAMES].some((value) => base === value || base.startsWith(value));
  if (episode.episode != null) return { role: "episode-artwork", scope: "episode", episode };
  if (knownArtwork) return { role: "artwork", scope: "resource", episode };
  return { role: "unknown-sidecar", scope: "unknown", episode };
}

function chineseSeasonNumber(value) {\n  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };\n  const text = String(value || "");\n  if (/^\\d+$/.test(text)) return Number(text);\n  if (text === "十") return 10;\n  if (text.includes("十")) { const [a, b] = text.split("十"); return (a ? digits[a] || 0 : 1) * 10 + (b ? digits[b] || 0 : 0); }\n  return digits[text] ?? null;\n}\n\nfunction normalizeStem(value) {
  return String(value || "").toLowerCase().normalize("NFKC")
    .replace(/\.(mkv|mp4|avi|mov|m4v|wmv|ts|webm|srt|ass|ssa|sub|idx|vtt|sup|nfo|jpg|jpeg|png|webp|tbn|bmp)$/i, "")
    .replace(/(?:2160p|2048p|1440p|1080p|720p|480p|4k|2k|uhd|fhd)/ig, "")
    .replace(/[ ._()[\]{}（）【】-]+/g, "");
}

function suffixFromSidecar(name, resourceName) {
  const extension = path.extname(name);
  let stem = path.basename(name, extension);
  const normalizedResource = normalizeStem(resourceName);
  if (normalizeStem(stem).startsWith(normalizedResource)) {
    // Preserve language / role suffixes while removing the resource title and resolution marker.
    stem = stem.replace(new RegExp("^" + escapeRegExp(resourceName), "i"), "");
  }
  stem = stem.replace(/(?:2160p|2048p|1440p|1080p|720p|480p|4k|2k|uhd|fhd)/ig, "");
  stem = stem.replace(/^[ ._-]+|[ ._-]+$/g, "");
  return stem ? "." + stem.replace(/[ ._-]+/g, ".") + extension : extension;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 将附件映射到影片级、剧集级或视频版本级目标。
 * 无法确认归属时保留 review_required，不猜测、不丢弃。
 */
export function buildSidecarPlans({ sidecarFiles, videoPlans, resourceType, resourceName, year, resourceFolder, seriesFolder }) {
  const result = [];
  for (const file of sidecarFiles) {
    let info = classifySidecar(file.name);\n    const fileExtension = path.extname(file.name).toLowerCase();\n    if (info.role === "unknown-sidecar" && [".jpg", ".jpeg", ".png", ".webp", ".tbn", ".bmp"].includes(fileExtension) && normalizeStem(file.name).includes(normalizeStem(resourceName))) {\n      info = { role: "artwork", scope: "resource", episode: info.episode };\n    }
    const extension = path.extname(file.name).toLowerCase();
    const isKnownArtwork = info.role === "artwork" || info.role === "episode-artwork";
    const matchingEpisode = info.episode?.episode != null
      ? videoPlans.filter((video) => video.season === (info.episode.season ?? video.season) && video.episode === info.episode.episode)
      : [];
    const sidecarResolution = extractResolution(file.name).value;
    let target = null;
    let associatedWith = null;
    let reason = "";

    if (info.role === "unknown-sidecar") {
      reason = "发现媒体目录中的附属文件，但无法可靠判断其用途或归属；保留待审核。";
    } else if (resourceType === "series" && info.scope === "episode") {
      let candidates = matchingEpisode;
      if (sidecarResolution) candidates = candidates.filter((video) => video.resolution === sidecarResolution);
      if (candidates.length === 1) {
        const video = candidates[0];
        const suffix = suffixFromSidecar(file.name, path.basename(video.source, path.extname(video.source)));
        target = video.target.replace(/\.[^.]+$/, "") + suffix;
        associatedWith = video.source;
        reason = "按季集编号关联到对应剧集" + (sidecarResolution ? "及清晰度版本。" : "。");
      } else if (candidates.length > 1 && !sidecarResolution) {
        const video = candidates[0];
        const episodeTag = "S" + String(video.season).padStart(2, "0") + "E" + String(video.episode).padStart(2, "0");
        target = path.posix.join(path.posix.dirname(video.target), resourceName + " - " + episodeTag + suffixFromSidecar(file.name, resourceName));
        associatedWith = candidates.map((item) => item.source);
        reason = "按季集编号关联到剧集级附件；该附件未标注清晰度，作为该集共享附件保留。";
      } else {
        reason = "附件包含季集线索，但没有唯一匹配的视频文件；需要审核。";
      }
    } else if (resourceType === "series" && info.scope === "resource") {
      const seriesRoot = seriesFolder;
      const targetName = info.role === "metadata" ? "tvshow.nfo"
        : isKnownArtwork ? path.basename(file.name) : resourceName + suffixFromSidecar(file.name, resourceName);
      target = path.posix.join(seriesRoot, targetName);
      associatedWith = seriesRoot;
      reason = "按剧集目录级配套文件关联。";
    } else if (resourceType === "movie" && info.scope === "resource") {
      const movieStem = resourceName + (year ? " (" + year + ")" : "");
      const targetName = info.role === "metadata" ? "movie.nfo"
        : isKnownArtwork ? path.basename(file.name) : movieStem + suffixFromSidecar(file.name, resourceName);
      target = path.posix.join(resourceFolder, targetName);
      associatedWith = resourceFolder;
      reason = "按电影目录级配套文件关联；多个清晰度版本共用，不重复复制。";
    } else if (resourceType === "movie" && sidecarResolution) {
      const candidates = videoPlans.filter((video) => video.resolution === sidecarResolution);
      if (candidates.length === 1) {
        const video = candidates[0];
        target = video.target.replace(/\.[^.]+$/, "") + suffixFromSidecar(file.name, resourceName);
        associatedWith = video.source;
        reason = "按文件名中的清晰度关联到对应电影版本。";
      } else {
        reason = "附件带有清晰度标记，但无法唯一匹配对应视频版本。";
      }
    } else {
      reason = "附件与媒体资源的关联范围不明确；需要审核。";
    }

    const status = target ? "auto_archive_candidate" : "review_required";
    result.push({
      source: file.path,
      target,
      resourceName,
      originalResourceName: resourceName,
      resourceType,
      confidence: target ? "high" : "low",
      status,
      year: year || null,
      season: info.episode?.season ?? null,
      episode: info.episode?.episode ?? null,
      resolution: sidecarResolution,
      resolutionSource: sidecarResolution ? "filename" : "unknown",
      assetRole: info.role,
      assetScope: info.scope,
      associatedWith,
      conflict: false,
      reason
    });
  }
  return result;
}
