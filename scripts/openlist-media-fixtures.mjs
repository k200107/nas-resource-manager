#!/usr/bin/env node

/**
 * Create an isolated OpenList media-archive test workspace.
 * All files are tiny text placeholders with media extensions, never playable media.
 * Preview is the default; --yes creates only under the dedicated test root.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./check-env.mjs";

const ROOT_NAME = "__MEDIA_ARCHIVE_TESTS__";
const FIXTURES = [
  { path: "source/Example (2024)/Example.1080p.mkv", content: "movie fixture 1080p" },
  { path: "source/Example (2024)/Example.2160p.mkv", content: "movie fixture 2160p" },
  { path: "source/Example (2024)/Example.srt", content: "shared subtitle sidecar fixture" },
  { path: "source/Example (2024)/Example.1080p.zh-CN.srt", content: "1080p Chinese subtitle fixture" },
  { path: "source/Example (2024)/Example.2160p.en.srt", content: "2160p English subtitle fixture" },
  { path: "source/Example (2024)/poster.jpg", content: "movie poster placeholder" },
  { path: "source/Example (2024)/fanart.jpg", content: "movie fanart placeholder" },
  { path: "source/Example (2024)/movie.nfo", content: "movie metadata placeholder" },
  { path: "source/Collision Film (2024)/Collision Film (2024).mkv", content: "collision source fixture" },
  { path: "source/TV Multi Season/Season 01/S01E01.mkv", content: "season one episode fixture" },
  { path: "source/TV Multi Season/Season 01/S01E01.zh-CN.srt", content: "episode subtitle fixture" },
  { path: "source/TV Multi Season/poster.jpg", content: "series poster placeholder" },
  { path: "source/TV Multi Season/tvshow.nfo", content: "series metadata placeholder" },
  { path: "source/TV Multi Season/Season 02/S02E01.mkv", content: "season two episode fixture" },
  { path: "source/琅琊榜/第三季/第03集.mp4", content: "Chinese season episode fixture" },
  { path: "source/2023/Year Parent Film/Year Parent Film.mkv", content: "year parent folder fixture" },
  { path: "source/Ambiguous Clip/clip.mkv", content: "ambiguous video fixture" },
  { path: "source/Non Video Document/README.txt", content: "not a video fixture" },
  { path: "target/Movies/Collision Film (2024)/Collision Film (2024).mkv", content: "existing target collision fixture" }
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = args.envFile || ".env";
  const fileEnv = envFile && fs.existsSync(envFile) ? parseDotEnv(fs.readFileSync(envFile, "utf8")) : {};
  const env = { ...fileEnv, ...process.env };
  const baseUrl = args.baseUrl || env.OPENLIST_BASE_URL;
  const token = args.token || env.OPENLIST_TOKEN;
  const staging = normalizePath(args.stagingDir || env.OPENLIST_STAGING_PATH);
  if (!baseUrl || !token) throw new Error("请配置 OPENLIST_BASE_URL 和 OPENLIST_TOKEN。");
  if (!staging || staging === "/") throw new Error("测试工作区必须位于明确的暂存目录下，拒绝使用 OpenList 根目录。");
  const root = joinPath(staging, ROOT_NAME);
  const directories = new Set([root]);
  for (const fixture of FIXTURES) {
    const parts = fixture.path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = joinPath(current, part);
      directories.add(current);
    }
  }
  const preview = {
    root,
    source: joinPath(root, "source"),
    movies: joinPath(root, "target/Movies"),
    tvShows: joinPath(root, "target/TVShows"),
    directories: [...directories],
    files: FIXTURES.map((item) => joinPath(root, item.path))
  };
  const existing = await listDirectory({ baseUrl, token, dirPath: staging });
  if (existing.some((item) => item.name === ROOT_NAME)) {
    throw new Error(`测试工作区已存在，拒绝覆盖：${root}。请先人工检查或在 OpenList 中另选暂存目录。`);
  }
  if (!args.yes) {
    console.log(JSON.stringify({
      ok: true, tool: "openlist-media-fixtures", mode: "preview-only", mutated: false,
      ...preview,
      note: "默认只预览。确认后添加 --yes 创建隔离测试工作区；脚本不提供自动清理或覆盖操作。"
    }, null, 2));
    return;
  }

  for (const dir of preview.directories) await postJson({ baseUrl, token, endpoint: "/api/fs/mkdir", body: { path: dir } });
  for (const fixture of FIXTURES) {
    const targetPath = joinPath(root, fixture.path);
    await putTextFile({ baseUrl, token, targetPath, content: [
      "NAS Resource Manager isolated test fixture.",
      "This is a tiny text placeholder, NOT a playable media file.",
      `Scenario: ${fixture.path}`,
      `Content: ${fixture.content}`
    ].join("\n") + "\n" });
  }
  console.log(JSON.stringify({
    ok: true, tool: "openlist-media-fixtures", mode: "create-isolated-test-workspace", mutated: true,
    ...preview, createdFileCount: FIXTURES.length,
    safety: { outsideTestRootModified: false, existingFilesOverwritten: false, filesMoved: false, filesRenamed: false, filesDeleted: false, playableMediaUploaded: false },
    nextCommands: [
      `npm run media-plan -- --source-dir "${preview.source}" --movies-dir "${preview.movies}" --tvshows-dir "${preview.tvShows}"`,
      "Review the plan JSON, save it to a file, then run media-archive without --yes for preflight."
    ]
  }, null, 2));
}

function parseArgs(argv) {
  const args = { envFile: ".env", stagingDir: "", baseUrl: "", token: "", yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--yes" || value === "-y") args.yes = true;
    else if (value === "--env-file") args.envFile = argv[++i] || ".env";
    else if (value === "--staging-dir") args.stagingDir = argv[++i] || "";
    else if (value === "--base-url") args.baseUrl = argv[++i] || "";
    else if (value === "--token") args.token = argv[++i] || "";
    else if (value.startsWith("--")) throw new Error(`未知参数：${value}`);
  }
  return args;
}
async function listDirectory({ baseUrl, token, dirPath }) {
  const json = await request({ baseUrl, token, endpoint: "/api/fs/list", body: { path: dirPath, password: "", page: 1, per_page: 200, refresh: true } });
  const rows = Array.isArray(json?.data?.content) ? json.data.content : Array.isArray(json?.data) ? json.data : [];
  return rows.map((row) => ({ name: String(row.name || ""), isDir: Boolean(row.is_dir ?? row.isDir ?? row.type === 1) }));
}
async function postJson(args) { return request(args); }
async function request({ baseUrl, token, endpoint, body, method = "POST", headers = {} }) {
  const response = await fetch(`${String(baseUrl).replace(/\/+$/g, "")}${endpoint}`, {
    method, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: token, ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000)
  });
  const raw = await response.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`OpenList ${endpoint} 返回非 JSON。`); }
  if (!response.ok || !(json.code === 200 || json.code === 0 || json.message === "success")) throw new Error(`OpenList ${endpoint} 失败：${json.message || response.status}`);
  return json;
}
async function putTextFile({ baseUrl, token, targetPath, content }) {
  const bytes = new TextEncoder().encode(content);
  const response = await fetch(`${String(baseUrl).replace(/\/+$/g, "")}/api/fs/put`, {
    method: "PUT",
    headers: { Accept: "application/json", Authorization: token, "File-Path": encodeURI(targetPath), "As-Task": "false", "Content-Type": "application/octet-stream", "Content-Length": String(bytes.byteLength) },
    body: bytes, signal: AbortSignal.timeout(20_000)
  });
  const raw = await response.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`OpenList 上传接口返回非 JSON：${raw.slice(0, 120)}`); }
  if (!response.ok || !(json.code === 200 || json.code === 0 || json.message === "success")) throw new Error(`创建测试文件失败：${json.message || response.status}`);
}
function normalizePath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (!text.startsWith("/") || text.split("/").includes("..")) return "";
  return text.replace(/\/+$/g, "") || "/";
}
function joinPath(parent, child) {
  const name = String(child || "").replace(/^\/+|\/+$/g, "");
  if (!name || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("不安全的测试路径。");
  return parent === "/" ? "/" + name : parent.replace(/\/+$/g, "") + "/" + name;
}
export { FIXTURES, parseArgs };
