#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./check-env.mjs";

const DEFAULT_ENV_FILE = ".env";
const FIXTURE_DIR_NAME = "__MEDIA_PLAN_TEST_FIXTURES__";
const TIMEOUT_MS = 20_000;

// These are tiny text placeholders with media extensions. They are NOT playable media.
const FIXTURES = [
  {
    directory: "01_Movie_The_Shawshank_Redemption_1994",
    files: [
      "The Shawshank Redemption (1994).mkv",
      "The Shawshank Redemption (1994).srt"
    ]
  },
  {
    directory: "02_Series_The_Last_of_Us",
    subdirectories: ["Season 01"],
    files: [
      "Season 01/S01E01 - When You're Lost in the Darkness.mkv",
      "Season 01/S01E02 - Infected.mkv"
    ]
  },
  {
    directory: "03_Series_Langya_Bang_Season_Three",
    files: [
      "琅琊榜 第三季 第03集.mp4"
    ]
  },
  {
    directory: "04_Ambiguous_Clip",
    files: ["clip.mkv"]
  },
  {
    directory: "05_Non_Video_Document",
    files: ["README.txt"]
  }
];

if (isCliEntryPoint()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv(args.envFile);
  const baseUrl = args.baseUrl || env.OPENLIST_BASE_URL;
  const token = args.token || env.OPENLIST_TOKEN;
  const stagingPath = normalizePath(args.stagingDir || env.OPENLIST_STAGING_PATH);

  if (!baseUrl || !token) throw new Error("请在 .env 中配置 OPENLIST_BASE_URL 和 OPENLIST_TOKEN。");
  if (!stagingPath || stagingPath === "/") throw new Error("暂存目录无效；拒绝在 OpenList 根目录创建测试数据。");

  const fixtureRoot = joinPath(stagingPath, FIXTURE_DIR_NAME);
  const preview = buildFixturePreview(fixtureRoot);

  // Read-only preflight: confirm staging path is reachable and fixture root does not exist.
  const stagingListing = await listDirectory({ baseUrl, token, dirPath: stagingPath });
  if (stagingListing.some((item) => item.name === FIXTURE_DIR_NAME)) {
    throw new Error(`测试目录已存在，拒绝覆盖：${fixtureRoot}。请先在 OpenList 界面人工检查。`);
  }

  if (!args.yes) {
    console.log(JSON.stringify({
      ok: true,
      tool: "openlist-test-fixtures",
      mode: "preview-only",
      mutated: false,
      fixtureRoot,
      plannedDirectories: preview.directories,
      plannedFiles: preview.files,
      note: "确认创建后，请重新运行并添加 --yes。不会覆盖已有目录，不提供自动删除操作。"
    }, null, 2));
    return;
  }

  await postJson({ baseUrl, token, apiPath: "/api/fs/mkdir", body: { path: fixtureRoot } });

  const createdDirectories = [fixtureRoot];
  const createdFiles = [];

  for (const fixture of FIXTURES) {
    const parent = joinPath(fixtureRoot, fixture.directory);
    await postJson({ baseUrl, token, apiPath: "/api/fs/mkdir", body: { path: parent } });
    createdDirectories.push(parent);

    for (const subdirectory of fixture.subdirectories || []) {
      const subPath = joinPath(parent, subdirectory);
      await postJson({ baseUrl, token, apiPath: "/api/fs/mkdir", body: { path: subPath } });
      createdDirectories.push(subPath);
    }

    for (const relativeFile of fixture.files) {
      const targetPath = joinPath(parent, relativeFile);
      const content = [
        "NAS Resource Manager media-plan test fixture.",
        "This is a tiny text placeholder, NOT a playable video or subtitle.",
        `Fixture: ${relativeFile}`,
        "Safe to ignore after testing; no automatic cleanup is provided."
      ].join("\n") + "\n";
      await putTextFile({ baseUrl, token, targetPath, content });
      createdFiles.push(targetPath);
    }
  }

  // Read-after-write check: list the fixture root and verify all top-level sample folders exist.
  const verify = await listDirectory({ baseUrl, token, dirPath: fixtureRoot });
  const visibleNames = new Set(verify.map((item) => item.name));
  const missing = FIXTURES.map((fixture) => fixture.directory).filter((name) => !visibleNames.has(name));
  if (missing.length) {
    throw new Error(`上传请求已执行，但回读缺少目录：${missing.join(", ")}。请在 OpenList 中检查；脚本不会自动清理。`);
  }

  console.log(JSON.stringify({
    ok: true,
    tool: "openlist-test-fixtures",
    mode: "create-test-data",
    mutated: true,
    fixtureRoot,
    createdDirectoryCount: createdDirectories.length,
    createdFileCount: createdFiles.length,
    createdDirectories,
    createdFiles,
    safety: {
      existingDataOverwritten: false,
      filesMoved: false,
      filesRenamed: false,
      filesDeleted: false,
      playableMediaUploaded: false,
      note: "仅在专用测试目录新建空目录和小型文本占位文件；未操作测试目录以外的文件。"
    },
    nextAction: "npm run media-plan"
  }, null, 2));
}

function buildFixturePreview(root) {
  const directories = [root];
  const files = [];
  for (const fixture of FIXTURES) {
    const parent = joinPath(root, fixture.directory);
    directories.push(parent);
    for (const sub of fixture.subdirectories || []) directories.push(joinPath(parent, sub));
    for (const file of fixture.files) files.push(joinPath(parent, file));
  }
  return { directories, files };
}

async function listDirectory({ baseUrl, token, dirPath }) {
  const response = await requestJson({
    baseUrl, token, apiPath: "/api/fs/list", method: "POST",
    body: { path: dirPath, password: "", page: 1, per_page: 200, refresh: true }
  });
  if (!isSuccess(response.json)) {
    throw new Error(`OpenList 目录读取失败（${dirPath}）：${response.json?.message || response.status}`);
  }
  const rows = Array.isArray(response.json?.data?.content)
    ? response.json.data.content
    : Array.isArray(response.json?.data) ? response.json.data : [];
  return rows.map((row) => ({ name: String(row.name || ""), isDir: Boolean(row.is_dir ?? row.isDir ?? row.type === 1) }));
}

async function postJson({ baseUrl, token, apiPath, body }) {
  const response = await requestJson({
    baseUrl, token, apiPath, method: "POST", body
  });
  if (!isSuccess(response.json)) {
    throw new Error(`OpenList API 调用失败（${apiPath}）：${response.json?.message || response.status}`);
  }
  return response.json;
}

async function putTextFile({ baseUrl, token, targetPath, content }) {
  const bytes = new TextEncoder().encode(content);
  const response = await fetchWithTimeout(`${normalizeBaseUrl(baseUrl)}/api/fs/put`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      Authorization: token,
      "File-Path": encodeURI(targetPath),
      "As-Task": "false",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength)
    },
    body: bytes
  });
  const raw = await response.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`OpenList 上传接口返回非 JSON：${raw.slice(0, 160)}`); }
  if (!response.ok || !isSuccess(json)) {
    throw new Error(`文件上传失败（${targetPath}）：${json.message || response.status}`);
  }
}

async function requestJson({ baseUrl, token, apiPath, method, body }) {
  const response = await fetchWithTimeout(`${normalizeBaseUrl(baseUrl)}${apiPath}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`OpenList 接口返回非 JSON：${raw.slice(0, 160)}`); }
  return { ok: response.ok, status: response.status, json };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv) {
  const args = { envFile: DEFAULT_ENV_FILE, stagingDir: "", baseUrl: "", token: "", yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") args.envFile = argv[++index] || DEFAULT_ENV_FILE;
    else if (arg === "--staging-dir") args.stagingDir = argv[++index] || "";
    else if (arg === "--base-url") args.baseUrl = argv[++index] || "";
    else if (arg === "--token") args.token = argv[++index] || "";
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function loadEnv(envFile) {
  const fileEnv = envFile && fs.existsSync(envFile) ? parseDotEnv(fs.readFileSync(envFile, "utf8")) : {};
  return { ...fileEnv, ...process.env };
}

function normalizePath(value) {
  const text = String(value || "").trim();
  if (!text || !text.startsWith("/") || text.includes("..")) return "";
  return text.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

function joinPath(parent, child) {
  const base = String(parent || "").replace(/\/+$/g, "");
  const name = String(child || "").replace(/^\/+|\/+$/g, "");
  if (!name || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("拒绝创建不安全的 OpenList 路径。");
  }
  return `${base}/${name}`;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function isSuccess(json) {
  return json?.code === 200 || json?.code === 0 || json?.message === "success";
}

function isCliEntryPoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export { buildFixturePreview, FIXTURES, parseArgs };
