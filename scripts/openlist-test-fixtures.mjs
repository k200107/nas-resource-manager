#!/usr/bin/env node

/**
 * 在专用 OpenList 测试目录创建媒体规划器样例目录和文本占位文件；默认预览，显式确认后才写入，并拒绝覆盖已有目录。
 *
 * 本文件说明：函数注释解释职责和关键边界；本次修改只增加注释，不改变原有执行逻辑。
 * 安全约束：只读预览与真实写入必须严格区分；测试写入必须限制在专用目录并要求显式确认。
 */

/**
 * 在明确指定的 OpenList 测试目录创建媒体规划器样例目录和文本占位文件；仅在显式确认后写入，拒绝覆盖已有测试目录。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */

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
    directory: "The Shawshank Redemption (1994)",
    files: [
      "The Shawshank Redemption (1994).mkv",
      "The Shawshank Redemption (1994).srt"
    ]
  },
  {
    directory: "The Last of Us",
    subdirectories: ["Season 01"],
    files: [
      "Season 01/S01E01 - When You're Lost in the Darkness.mkv",
      "Season 01/S01E02 - Infected.mkv"
    ]
  },
  {
    directory: "琅琊榜",
    subdirectories: ["第三季"],
    files: [
      "第三季/第03集.mp4"
    ]
  },
  {
    directory: "Ambiguous Clip",
    files: ["clip.mkv"]
  },
  {
    directory: "Non Video Document",
    files: ["README.txt"]
  }
];

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

  // 没有 --yes 时保持预览模式，避免误把测试数据写入真实目录。
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

/** 构建测试样例的目录/文件清单和执行预览；预览阶段不向 OpenList 写入。 */
/** 生成测试目录、子目录和占位文件的预览清单；预览阶段不写入 OpenList。 */
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

/** 调用 OpenList fs/list 读取一个目录；只返回名称、类型、大小和修改时间等规划所需信息。 */
/** 读取 OpenList 指定目录，检查测试目录是否已经存在。 */
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

/** 向 OpenList API 发送 JSON 请求并返回解析后的响应。 */
/** 向 OpenList API 发送 JSON 请求并检查 HTTP/业务响应。 */
async function postJson({ baseUrl, token, apiPath, body }) {
  const response = await requestJson({
    baseUrl, token, apiPath, method: "POST", body
  });
  if (!isSuccess(response.json)) {
    throw new Error(`OpenList API 调用失败（${apiPath}）：${response.json?.message || response.status}`);
  }
  return response.json;
}

/** 通过 OpenList 文件上传接口创建文本占位文件；仅用于测试数据，不上传真实媒体内容。 */
/** 通过 OpenList 上传接口创建小型文本占位文件，不上传真实媒体文件。 */
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

/** 统一执行带超时的 HTTP 请求、解析 JSON 并检查接口返回。 */
/** 统一执行带超时的 HTTP 请求并解析 JSON 响应。 */
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

/** 执行带超时控制的网络请求；超时后通过 AbortController 中止。 */
/** 执行带超时控制的网络请求，超时后中止底层 fetch。 */
async function fetchWithTimeout(url, options) {
  // 为本次请求设置可中止控制器，避免网络无响应时脚本无限等待。
  const controller = new AbortController();
  // 请求超时后主动中止底层 fetch；finally 中会清理定时器。
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；遇到未知参数时明确报错。 */
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

/** 读取指定 .env 文件并与当前进程环境变量合并；调用方环境变量优先，避免覆盖部署环境注入值。 */
/** 读取 .env 并合并进程环境变量；进程环境变量优先，不覆盖运行环境注入的配置。 */
function loadEnv(envFile) {
  const fileEnv = envFile && fs.existsSync(envFile) ? parseDotEnv(fs.readFileSync(envFile, "utf8")) : {};
  return { ...fileEnv, ...process.env };
}

/** 验证并规范化测试目录路径。 */
/** 规范化 OpenList 测试路径，拒绝空路径和路径穿越片段。 */
function normalizePath(value) {
  const text = String(value || "").trim();
  if (!text || !text.startsWith("/") || text.includes("..")) return "";
  return text.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

/** 拼接 OpenList 测试目录路径。 */
/** 拼接测试目录路径，避免重复斜杠。 */
function joinPath(parent, child) {
  const base = String(parent || "").replace(/\/+$/g, "");
  const name = String(child || "").replace(/^\/+|\/+$/g, "");
  if (!name || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("拒绝创建不安全的 OpenList 路径。");
  }
  return `${base}/${name}`;
}

/** 规范化服务 URL，移除尾部斜杠。 */
/** 规范化 OpenList 服务地址。 */
function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/g, "");
}

/** 根据接口响应判断创建/上传操作是否成功。 */
/** 依据 OpenList 响应字段判断目录创建或文件上传是否成功。 */
function isSuccess(json) {
  return json?.code === 200 || json?.code === 0 || json?.message === "success";
}

/** 确认模块是直接运行而非被导入，避免导入时触发命令行副作用。 */
/** 判断当前模块是否作为命令行入口直接运行。 */
function isCliEntryPoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export { buildFixturePreview, FIXTURES, parseArgs };
