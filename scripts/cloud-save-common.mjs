#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

function classifyResource({ resourceType = "auto", contextName = "", shareTitle = "", items = [] } = {}) {
  const explicitType = normalizeResourceType(resourceType);
  if (explicitType === "series") {
    return {
      type: "series",
      isSeries: true,
      label: "剧集",
      reason: "Agent 根据上下文判定为剧集"
    };
  }
  if (explicitType === "movie") {
    return {
      type: "movie",
      isSeries: false,
      label: "电影",
      reason: "Agent 根据上下文判定为电影"
    };
  }
  if (explicitType === "collection") {
    return {
      type: "collection",
      isSeries: false,
      label: "合集",
      reason: "Agent 根据上下文判定为合集"
    };
  }

  const haystack = [contextName, shareTitle, ...items.map((item) => item.name)].join(" ");
  const seriesPattern =
    /(S\d{1,2}E\d{1,3}|EP?\d{1,3}|第[一二三四五六七八九十百\d]+[季集]|全\d{1,4}集|完结|剧集|电视剧|美剧|英剧|韩剧|日剧|番剧|动漫|连载)/i;
  if (seriesPattern.test(haystack)) {
    return {
      type: "series",
      isSeries: true,
      label: "剧集",
      reason: "匹配到剧集/季/集关键词"
    };
  }
  return {
    type: "unknown",
    isSeries: false,
    label: "电影/合集",
    reason: "未匹配到明显剧集关键词"
  };
}

function normalizeContextName(value) {
  return String(value || "")
    .replace(/[丨｜|]/g, "")
    .replace(/[\u200b-\u200f\uFEFF]/g, "")
    .replace(/^[A-Z]\s+(?=.*[\u4e00-\u9fff])/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeResourceType(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (["auto", "series", "movie", "collection"].includes(normalized)) return normalized;
  throw new Error(`Unsupported resource type: ${value}`);
}

function parseSelection(selection, items) {
  const value = String(selection || "").trim().toLowerCase();
  if (!value || value === "all" || value === "*") return [...items];
  const ranks = new Set();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start) throw new Error(`Invalid selection range: ${trimmed}`);
      for (let rank = start; rank <= end; rank += 1) ranks.add(rank);
    } else if (/^\d+$/.test(trimmed)) {
      ranks.add(Number(trimmed));
    } else {
      throw new Error(`Invalid selection: ${trimmed}`);
    }
  }

  const selected = [...ranks].sort((a, b) => a - b).map((rank) => {
    const item = items[rank - 1];
    if (!item) throw new Error(`Selection index out of range: ${rank}`);
    return item;
  });
  return selected;
}

function extractEpisodeLabel(value) {
  const text = String(value || "");
  const seasonEpisode = text.match(/S(\d{1,2})E(\d{1,3})/i);
  if (seasonEpisode) {
    return `S${seasonEpisode[1].padStart(2, "0")}E${seasonEpisode[2].padStart(2, "0")}`;
  }
  const cnEpisode = text.match(/第([一二三四五六七八九十百\d]+)集/);
  if (cnEpisode) return `第${cnEpisode[1]}集`;
  const ep = text.match(/\bEP?\.?(\d{1,3})\b/i);
  if (ep) return `E${ep[1].padStart(2, "0")}`;
  return "";
}

function getExtension(value) {
  const ext = path.extname(String(value || ""));
  return ext.length <= 12 ? ext : "";
}

function stripExtension(value) {
  const ext = getExtension(value);
  return ext ? String(value).slice(0, -ext.length) : String(value || "");
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestSavedName({ baseName, item, selectedCount, isSeries }) {
  const extension = item.isDir ? "" : getExtension(item.name);
  if (item.isDir) {
    if (selectedCount === 1) return baseName;
    return sanitizeFileName(`${baseName} - ${item.name}`);
  }
  if (isSeries) {
    const episode = extractEpisodeLabel(item.name);
    if (episode) return sanitizeFileName(`${baseName} ${episode}${extension}`);
  }
  if (selectedCount === 1) return sanitizeFileName(`${baseName}${extension}`);
  return sanitizeFileName(`${baseName} - ${stripExtension(item.name)}${extension}`);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value || "[]");
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function resolveCookie(args) {
  return (args.env?.[args.cookieEnv] || process.env[args.cookieEnv] || "").trim();
}

function formatBytes(bytes) {
  if (!bytes) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function escapeMarkdownCell(value) {
  return escapeMarkdownText(value).replace(/\|/g, "\\|");
}

function escapeMarkdownText(value) {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .trim();
}

function askUserSelection(items, defaultSelection) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`请选择要转存的序号（默认 ${defaultSelection}，支持 all、1,3、2-5）：`);
    return parseSelection(answer.trim() || defaultSelection, items);
  } finally {
    rl.close();
  }
}


function formatTimestamp(value, { unixSeconds = false } = {}) {
  if (!value) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const ms = unixSeconds && numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().slice(0, 10);
}

export {
  askUserSelection, classifyResource, escapeMarkdownCell, escapeMarkdownText,
  extractEpisodeLabel, formatBytes, formatTimestamp, getExtension,
  normalizeContextName, normalizeResourceType, parseJson,
  parseSelection, resolveCookie, sanitizeFileName, stripExtension,
  suggestSavedName
};
