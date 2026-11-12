/**
 * 媒体身份识别辅助模块。
 * 负责标题别名候选、季集和分辨率提取，以及 Emby 风格文件名生成。
 * 本模块只处理字符串和元数据，不访问 NAS、不执行文件操作。
 */

const DEFAULT_TITLE_ALIASES = {
  "肖申克的救赎": ["肖生客的救赎", "肖申客的救赎", "申克的救赎"]
};

// 仅用于已知规范片名的年份补全；别名匹配仍必须经过人工确认。
const DEFAULT_TITLE_YEARS = {
  "肖申克的救赎": 1994
};

const SIMPLIFIED_MAP = {
  "後":"后","來":"来","與":"与","國":"国","門":"门","風":"风","雲":"云",
  "愛":"爱","龍":"龙","馬":"马","東":"东","萬":"万","臺":"台","灣":"湾",
  "劇":"剧","說":"说","書":"书","畫":"画","樂":"乐","會":"会","開":"开",
  "發":"发","現":"现","學":"学","時":"时","間":"间","戰":"战","爭":"争"
};

const CHINESE_DIGITS = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };

export function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[後來與國門風雲愛龍馬東萬臺灣劇說書畫樂會開發現學時間戰爭]/g, (char) => SIMPLIFIED_MAP[char] || char)
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function parseChineseNumber(value) {
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (text === "十") return 10;
  if (!text.includes("十")) return CHINESE_DIGITS[text] ?? null;
  const [tens, ones] = text.split("十");
  return (tens ? (CHINESE_DIGITS[tens] ?? 0) : 1) * 10 + (ones ? (CHINESE_DIGITS[ones] ?? 0) : 0);
}

function editDistance(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * 从本地别名目录中解析片名。
 * 精确别名只生成候选，不直接作为“已确认身份”；模糊匹配也只供人工挑选。
 * 需要覆盖更多谐音写法时，将用户确认的别名追加到 MEDIA_TITLE_ALIASES_FILE。
 */
export function resolveMediaTitle(rawTitle, aliasCatalog = DEFAULT_TITLE_ALIASES) {
  const raw = String(rawTitle || "").trim();
  const normalized = normalizeTitle(raw);
  if (!normalized) return { matched: false, canonicalTitle: raw, candidates: [], requiresReview: true };

  const entries = Object.entries(aliasCatalog || {}).filter(([canonicalTitle]) => !canonicalTitle.startsWith("_"));
  for (const [canonicalTitle, aliases] of entries) {
    const names = [canonicalTitle, ...(Array.isArray(aliases) ? aliases : [])];
    const exact = names.find((name) => normalizeTitle(name) === normalized);
    if (exact) {
      const isCanonical = normalizeTitle(canonicalTitle) === normalized;
      return {
        matched: true,
        canonicalTitle,
        matchType: isCanonical ? "canonical" : "alias",
        candidates: [{ title: canonicalTitle, matchType: isCanonical ? "canonical" : "alias" }],
        requiresReview: !isCanonical
      };
    }
  }

  const candidates = [];
  for (const [canonicalTitle, aliases] of entries) {
    const names = [canonicalTitle, ...(Array.isArray(aliases) ? aliases : [])];
    const bestDistance = Math.min(...names.map((name) => editDistance(normalized, normalizeTitle(name))));
    const threshold = normalized.length >= 6 ? 2 : 1;
    if (bestDistance > 0 && bestDistance <= threshold) {
      candidates.push({ title: canonicalTitle, matchType: "fuzzy", distance: bestDistance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.title.localeCompare(b.title, "zh-CN"));
  return {
    matched: false,
    canonicalTitle: raw,
    candidates: candidates.slice(0, 5),
    requiresReview: candidates.length > 0
  };
}

export function extractResolution(value, mediaInfo = {}) {
  const width = Number(mediaInfo.width || mediaInfo.videoWidth || 0);
  const height = Number(mediaInfo.height || mediaInfo.videoHeight || 0);
  if (width > 0 && height > 0) {
    const dimensionTag = width >= 3800 || height >= 2100 ? "2160p"
      : width >= 2500 ? "1440p"
      : width >= 2000 ? "2048p"
      : height >= 1000 ? "1080p" : height >= 700 ? "720p" : height >= 400 ? "480p" : null;
    if (dimensionTag) return { value: dimensionTag, source: "media-info", width, height };
  }
  const text = String(value || "");
  const patterns = [
    [/(?:2160p|4k|uhd)/i, "2160p"],
    [/(?:2048p|2k|(?:^|[._\s-])2048(?:[._\s-]|$))/i, "2048p"],
    [/1440p/i, "1440p"],
    [/(?:1080p|fhd)/i, "1080p"],
    [/(?:720p|hd)/i, "720p"],
    [/(?:480p|sd)/i, "480p"]
  ];
  for (const [pattern, resolution] of patterns) {
    if (pattern.test(text)) return { value: resolution, source: "filename" };
  }
  return { value: null, source: "unknown" };
}

export function extractEpisode(value) {
  const text = String(value || "");
  let match = text.match(/S(\d{1,2})\s*E(\d{1,3})/i);
  if (match) return { season: Number(match[1]), episode: Number(match[2]), source: "sxxexx" };
  // E/EP 集数标记必须位于独立分隔边界，避免把 Example.1080p 中的 “e.108” 误判为第 108 集。
  match = text.match(/(?:^|[ ._/-])(?:EP|E)\.?\s*(\d{1,3})(?=$|[ ._/-])/i);
  if (match) return { season: null, episode: Number(match[1]), source: "episode-tag" };
  match = text.match(/第([零〇一二两三四五六七八九十\d]+)季/);
  const season = match ? parseChineseNumber(match[1]) : null;
  const episodeMatch = text.match(/第([零〇一二两三四五六七八九十\d]+)集/);
  if (episodeMatch) return { season, episode: parseChineseNumber(episodeMatch[1]), source: "chinese-episode" };
  return { season, episode: null, source: season ? "season-only" : null };
}

export function extractYear(value) {
  const match = String(value || "").match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  return match ? Number(match[1]) : null;
}

export function extractMovieVersion(value, resolution = null) {
  const text = String(value || "");
  const tags = [];
  if (resolution) tags.push(resolution);
  const source = [
    [/(?:blu[ ._-]?ray|bdrip|brrip)/i, "BluRay"],
    [/(?:web[ ._-]?dl)/i, "WEB-DL"],
    [/(?:webrip)/i, "WEBRip"],
    [/(?:hdtv)/i, "HDTV"],
    [/(?:remux)/i, "Remux"],
    [/(?:hdrip)/i, "HDRip"],
    [/(?:dvdrip)/i, "DVDRip"]
  ].find(([pattern]) => pattern.test(text));
  if (source) tags.push(source[1]);
  const dynamicRange = [
    [/(?:dolby[ ._-]?vision|\bDV\b)/i, "Dolby Vision"],
    [/HDR10\+/i, "HDR10+"],
    [/HDR10/i, "HDR10"],
    [/\bHDR\b/i, "HDR"]
  ].find(([pattern]) => pattern.test(text));
  if (dynamicRange) tags.push(dynamicRange[1]);
  const codec = [
    [/(?:HEVC|H\\.?265|x265)/i, "HEVC"],
    [/(?:AV1)/i, "AV1"],
    [/(?:AVC|H\\.?264|x264)/i, "H.264"]
  ].find(([pattern]) => pattern.test(text));
  if (codec) tags.push(codec[1]);

  if (tags.length) return [...new Set(tags)].join(" ");
  const edition = [
    [/(?:extended[ ._-]+edition|extended)/i, "extended edition"],
    [/(?:director[’']?s?[ ._-]+cut)/i, "director's cut"],
    [/(?:theatrical[ ._-]+cut)/i, "theatrical cut"],
    [/(?:unrated)/i, "unrated"],
    [/(?:remastered)/i, "remastered"],
    [/(?:imax)/i, "IMAX"]
  ].find(([pattern]) => pattern.test(text));
  return edition?.[1] || null;
}

export function buildMovieFileName(title, year, resolution, extension) {
  const stem = year ? `${title} (${year})` : title;
  return `${stem}${resolution ? ` - ${resolution}` : ""}${extension}`;
}

export function buildSeriesFileName(title, season, episode, resolution, extension) {
  const episodeTag = season == null
    ? `E${String(episode).padStart(2, "0")}`
    : `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return `${title} - ${episodeTag}${resolution ? ` - ${resolution}` : ""}${extension}`;
}

export { DEFAULT_TITLE_ALIASES, DEFAULT_TITLE_YEARS };
