#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  classifyResource,
  parseJson,
  parseSelection,
  sanitizeFileName,
  suggestSavedName
} from "./cloud-save-common.mjs";
import { loadEnvFile, mergeEnvValues } from "./env-config.mjs";
import { isCliEntryPoint } from "./cli-utils.mjs";

const API_BASE = "https://api.aliyundrive.com";
const DEFAULT_ENV_FILE = ".env";
const DEFAULT_STATE_FILE = ".state/aliyun-auth.json";
const DEFAULT_TIMEOUT_MS = 60_000;
const USER_AGENT = "AliApp(AYSD/5.8.0) com.alicloud.databox/37029260 Channel/36176927979800@rimet_android_5.8.0 language/zh-CN /Android Mobile";
const COMMON_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Referer: "https://www.aliyundrive.com/",
  "User-Agent": USER_AGENT,
  "x-canary": "client=Android,app=adrive,version=v5.8.0"
};

if (isCliEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadEnvFile(args.envFile);
  const env = mergeEnvValues(loaded.values, process.env);
  const refreshToken = String(env.ALIYUN_REFRESH_TOKEN || "").trim();
  const targetPath = args.targetPath || env.ALIYUN_DEFAULT_SAVE_PATH || "";
  if (!args.shareUrl || !targetPath) {
    throw new Error("用法：npm run aliyun-save -- <阿里云盘分享链接> [保存目录] --dry-run --format json");
  }
  if (!refreshToken) throw new Error("缺少 ALIYUN_REFRESH_TOKEN。请从已登录阿里云盘网页的 Local Storage token 中获取 refresh_token。");

  const result = await prepareAliyunSave({
    ...args,
    targetPath,
    refreshToken
  });

  if (args.dryRun) {
    const preview = buildAliyunSubagentPreview({ args, result });
    console.log(args.format === "json" ? JSON.stringify(preview, null, 2) : renderPreview(preview));
    return;
  }
  if (args.format === "json" && !args.yes) {
    throw new Error("JSON 保存模式必须在用户确认预览后搭配 --yes；预览请使用 --dry-run。");
  }
  if (!args.yes) throw new Error("阿里云盘保存属于远端写操作，请先使用 --dry-run 预览，再经用户确认后使用 --yes。");

  const saved = await saveAliyunSelectedItems({
    result,
    selectedItems: result.selectedItems,
    renamePlan: result.renamePlan
  });
  console.log(JSON.stringify({
    ok: saved.ok,
    transferOk: saved.transferOk,
    renameOk: saved.renameOk,
    provider: "aliyun",
    mode: "saved",
    source: result.shareUrl,
    target: result.targetPath,
    savedCount: saved.savedCount,
    results: saved.results,
    renameResults: saved.renameResults
  }, null, 2));
}

function parseArgs(argv) {
  const parsed = {
    shareUrl: "",
    targetPath: "",
    passcode: "",
    contextName: "",
    resourceType: "auto",
    selection: "all",
    agentRenamePlan: null,
    noRename: false,
    envFile: DEFAULT_ENV_FILE,
    stateFile: DEFAULT_STATE_FILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: false,
    yes: false,
    format: "json"
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg === "--no-rename") parsed.noRename = true;
    else if (arg === "--json") parsed.format = "json";
    else if (arg === "--format") parsed.format = argv[++index] || "text";
    else if (arg === "--env-file" || arg === "--dotenv") parsed.envFile = argv[++index] || DEFAULT_ENV_FILE;
    else if (arg === "--state-file") parsed.stateFile = argv[++index] || DEFAULT_STATE_FILE;
    else if (arg === "--passcode") parsed.passcode = argv[++index] || "";
    else if (arg === "--context-name") parsed.contextName = argv[++index] || "";
    else if (arg === "--resource-type") parsed.resourceType = argv[++index] || "auto";
    else if (arg === "--select") parsed.selection = argv[++index] || "all";
    else if (arg === "--rename-plan-json") parsed.agentRenamePlan = parseJson(argv[++index], "--rename-plan-json");
    else if (arg.startsWith("--")) throw new Error(\`Unknown option: \${arg}\`);
    else positionals.push(arg);
  }
  parsed.shareUrl = positionals[0] || "";
  parsed.targetPath = positionals[1] || "";
  return parsed;
}

function parseAliyunShareUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("阿里云盘分享链接格式无效。");
  }
  const host = parsed.hostname.toLowerCase();
  const allowedHost = host === "aliyundrive.com" || host.endsWith(".aliyundrive.com") || host === "alipan.com" || host.endsWith(".alipan.com");
  if (!allowedHost) {
    throw new Error("分享链接不是阿里云盘或 alipan.com 地址。");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const shareIndex = segments.findIndex((item) => ["s", "share"].includes(item.toLowerCase()));
  const shareId = shareIndex >= 0 ? segments[shareIndex + 1] : parsed.searchParams.get("share_id");
  const hashQuery = parsed.hash.includes("?") ? parsed.hash.slice(parsed.hash.indexOf("?") + 1) : "";
  const hashParams = new URLSearchParams(hashQuery);
  const passcode = parsed.searchParams.get("pwd") || parsed.searchParams.get("password") ||
    hashParams.get("pwd") || hashParams.get("password") || "";
  if (!shareId) throw new Error("无法从阿里云盘分享链接中提取分享 ID。");
  return { shareId, passcode };
}

async function prepareAliyunSave(args = {}) {
  const fetchImpl = args.fetchImpl || globalThis.fetch;
  const refreshToken = String(args.refreshToken || "").trim();
  if (!refreshToken) throw new Error("缺少阿里云盘 refresh_token。");
  const share = parseAliyunShareUrl(args.shareUrl);
  const passcode = args.passcode || share.passcode;
  const { token } = await authenticateAliyun({
    refreshToken,
    stateFile: args.stateFile || DEFAULT_STATE_FILE,
    fetchImpl,
    timeoutMs: args.timeoutMs
  });

  const shareInfo = await requestAliyun("/adrive/v2/share_link/get_share_by_anonymous", {
    body: { share_id: share.shareId },
    fetchImpl,
    timeoutMs: args.timeoutMs
  });
  const shareTokenResult = await requestAliyun("/v2/share_link/get_share_token", {
    body: { share_id: share.shareId, share_pwd: passcode },
    fetchImpl,
    timeoutMs: args.timeoutMs
  });
  const shareToken = shareTokenResult.share_token;
  if (!shareToken) throw new Error("阿里云盘没有返回 share_token，无法读取分享内容。");

  const items = await listAliyunShareItems({
    shareId: share.shareId,
    shareToken,
    fetchImpl,
    timeoutMs: args.timeoutMs
  });
  const targetPath = normalizeCloudPath(args.targetPath);
  const targetFolder = await resolveAliyunFolder({
    driveId: token.default_drive_id,
    targetPath,
    accessToken: token.access_token,
    fetchImpl,
    timeoutMs: args.timeoutMs
  });
  const contextName = String(args.contextName || shareInfo.share_name || shareInfo.share_title || "").trim();
  const resource = classifyResource({
    resourceType: args.resourceType || "auto",
    contextName,
    shareTitle: shareInfo.share_name || shareInfo.share_title || "",
    items
  });
  const selectedItems = parseSelection(args.selection || "all", items);
  const renamePlan = buildAliyunRenamePlan({
    resourceType: args.resourceType,
    contextName,
    shareTitle: shareInfo.share_name || shareInfo.share_title || "",
    savePath: targetPath,
    selectedItems,
    agentRenamePlan: args.agentRenamePlan,
    noRename: args.noRename
  });
  return {
    provider: "aliyun",
    shareUrl: args.shareUrl,
    shareId: share.shareId,
    shareInfo,
    shareToken,
    accessToken: token.access_token,
    driveId: token.default_drive_id,
    targetPath,
    targetFolderId: targetFolder.file_id,
    targetFolderName: targetFolder.name || path.posix.basename(targetPath),
    contextName,
    resource,
    items,
    selectedItems,
    renamePlan,
    fetchImpl,
    timeoutMs: args.timeoutMs
  };
}

async function authenticateAliyun({ refreshToken, stateFile = DEFAULT_STATE_FILE, fetchImpl = globalThis.fetch, timeoutMs }) {
  const configuredToken = String(refreshToken || "").trim();
  if (!configuredToken) throw new Error("缺少阿里云盘 refresh_token。");
  const resolvedStateFile = path.resolve(stateFile);
  const stored = await readAuthState(resolvedStateFile);
  const sourceFingerprint = createHash("sha256").update(configuredToken).digest("hex");
  const effectiveRefreshToken = stored.source_fingerprint === sourceFingerprint ? (stored.refresh_token || configuredToken) : configuredToken;
  const token = await refreshAliyunToken(effectiveRefreshToken, { fetchImpl, timeoutMs });
  await persistAuthState(resolvedStateFile, {
    refresh_token: token.refresh_token || effectiveRefreshToken,
    source_fingerprint: sourceFingerprint,
    updated_at: new Date().toISOString()
  });
  return { token, refreshTokenRotated: Boolean(token.refresh_token && token.refresh_token !== effectiveRefreshToken) };
}

async function validateAliyunRefreshToken(options = {}) {
  const { token, refreshTokenRotated } = await authenticateAliyun(options);
  return {
    ok: true,
    account: token.nick_name || token.user_name || token.user_id || "",
    driveIdConfigured: Boolean(token.default_drive_id),
    refreshTokenRotated
  };
}

async function checkAliyunSaveTarget({ refreshToken, targetPath, stateFile = DEFAULT_STATE_FILE, fetchImpl = globalThis.fetch, timeoutMs }) {
  const { token } = await authenticateAliyun({ refreshToken, stateFile, fetchImpl, timeoutMs });
  const normalizedPath = normalizeCloudPath(targetPath);
  const folder = await resolveAliyunFolder({
    driveId: token.default_drive_id,
    targetPath: normalizedPath,
    accessToken: token.access_token,
    fetchImpl,
    timeoutMs
  });
  return {
    provider: "aliyun",
    label: "阿里云盘",
    ok: true,
    state: "reachable",
    targetPath: normalizedPath,
    folderId: folder.file_id,
    message: "阿里云盘默认保存目录可访问。"
  };
}

async function refreshAliyunToken(refreshToken, options = {}) {
  const response = await requestAliyun("/v2/account/token", {
    body: { refresh_token: refreshToken, grant_type: "refresh_token" },
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: options.timeoutMs
  });
  if (!response.access_token || !response.default_drive_id) {
    throw new Error(\`阿里云盘登录态验证失败：\${response.code || response.message || "响应缺少 access_token/default_drive_id"}。请重新获取 refresh_token。\`);
  }
  return response;
}

async function listAliyunShareItems({ shareId, shareToken, fetchImpl, timeoutMs }) {
  const items = [];
  let marker = "";
  do {
    const response = await requestAliyun("/adrive/v2/file/list_by_share", {
      body: {
        share_id: shareId,
        parent_file_id: "root",
        limit: 100,
        marker,
        order_by: "name",
        order_direction: "ASC"
      },
      shareToken,
      fetchImpl,
      timeoutMs
    });
    for (const item of response.items || []) {
      items.push({
        fid: item.file_id,
        name: item.name || "",
        isDir: item.type === "folder",
        size: Number(item.size || 0),
        updatedAt: item.updated_at || ""
      });
    }
    marker = response.next_marker || "";
  } while (marker);
  return items.map((item, index) => ({ ...item, rank: index + 1 }));
}

async function resolveAliyunFolder({ driveId, targetPath, accessToken, fetchImpl, timeoutMs }) {
  const segments = targetPath.split("/").filter(Boolean);
  let parentId = "root";
  let current = { file_id: "root", name: "/" };
  for (const segment of segments) {
    const response = await requestAliyun("/adrive/v3/file/list", {
      body: {
        drive_id: driveId,
        parent_file_id: parentId,
        limit: 100,
        order_by: "name",
        order_direction: "ASC"
      },
      accessToken,
      fetchImpl,
      timeoutMs
    });
    const match = (response.items || []).find((item) => item.type === "folder" && item.name === segment);
    if (!match) throw new Error(\`阿里云盘保存目录不存在：\${targetPath}（缺少目录：\${segment}）。请先在阿里云盘中创建目录。\`);
    current = match;
    parentId = match.file_id;
  }
  return current;
}

function buildAliyunRenamePlan({
  resourceType = "auto",
  contextName = "",
  shareTitle = "",
  savePath = "/",
  selectedItems = [],
  agentRenamePlan = null,
  noRename = false
} = {}) {
  if (noRename) return [];
  if (agentRenamePlan !== null) {
    if (!Array.isArray(agentRenamePlan)) throw new Error("Agent rename plan must be a JSON array");
    const plan = [];
    for (const decision of agentRenamePlan) {
      const rank = Number(decision.rank ?? decision.index);
      if (!Number.isFinite(rank) || rank < 1) throw new Error("Agent rename plan item is missing a valid rank/index");
      const selectedIndex = selectedItems.findIndex((item) => item.rank === rank);
      const fallbackIndex = selectedItems[rank - 1] ? rank - 1 : -1;
      const itemIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;
      if (itemIndex < 0) throw new Error(\`Agent rename plan rank is not selected: \${rank}\`);
      const item = selectedItems[itemIndex];
      const suggestedName = sanitizeFileName(decision.name || decision.suggestedName || "");
      if (!suggestedName) throw new Error("Agent rename plan item is missing name/suggestedName");
      if (suggestedName === item.name) continue;
      plan.push({
        sourceFid: item.fid,
        originalName: item.name,
        suggestedName,
        reason: decision.reason || "Agent 指定重命名"
      });
    }
    return plan;
  }

  const baseName = sanitizeFileName(contextName || shareTitle || "");
  if (!baseName) return [];
  const classification = classifyResource({ resourceType, contextName: baseName, shareTitle, items: selectedItems });
  const plan = [];
  selectedItems.forEach((item) => {
    const suggestedName = suggestSavedName({
      baseName,
      item,
      selectedCount: selectedItems.length,
      isSeries: classification.isSeries
    });
    if (!suggestedName || suggestedName === item.name) return;
    plan.push({
      sourceFid: item.fid,
      originalName: item.name,
      suggestedName,
      reason: classification.isSeries ? "按上下文资源名修正剧集文件名" : "按上下文资源名修正保存名称"
    });
  });
  return plan;
}

async function saveAliyunSelectedItems({ result, selectedItems, renamePlan = result.renamePlan || [] }) {
  if (!selectedItems?.length) {
    return { ok: true, transferOk: true, renameOk: true, savedCount: 0, results: [], renameResults: [] };
  }
  const requests = selectedItems.map((item) => ({
    body: {
      file_id: item.fid,
      share_id: result.shareId,
      to_parent_file_id: result.targetFolderId,
      to_drive_id: result.driveId,
      auto_rename: true
    },
    headers: { "Content-Type": "application/json" },
    id: item.fid,
    method: "POST",
    url: "/file/copy"
  }));
  const response = await requestAliyun("/adrive/v2/batch", {
    body: { requests, resource: "file" },
    accessToken: result.accessToken,
    shareToken: result.shareToken,
    fetchImpl: result.fetchImpl || globalThis.fetch,
    timeoutMs: result.timeoutMs
  });
  const results = (response.responses || []).map((item) => ({
    id: item.id || "",
    status: Number(item.status || 0),
    ok: [200, 201, 202].includes(Number(item.status || 0)),
    fileId: item.body?.file_id || "",
    code: item.body?.code || "",
    message: item.body?.message || ""
  }));
  const okCount = results.filter((item) => item.ok).length;
  const transferOk = results.length === selectedItems.length && okCount === selectedItems.length;

  const renameResults = [];
  for (const plan of renamePlan) {
    const copied = results.find((item) => item.id === plan.sourceFid && item.ok);
    if (!copied) {
      renameResults.push({ ...plan, ok: false, error: "转存未成功，跳过重命名。" });
      continue;
    }
    if (!copied.fileId) {
      renameResults.push({ ...plan, ok: false, error: "转存响应未提供目标文件 ID，无法安全定位副本，已跳过重命名。" });
      continue;
    }
    try {
      const renameResponse = await renameAliyunFile({
        driveId: result.driveId,
        fileId: copied.fileId,
        newName: plan.suggestedName,
        accessToken: result.accessToken,
        fetchImpl: result.fetchImpl || globalThis.fetch,
        timeoutMs: result.timeoutMs
      });
      renameResults.push({ ...plan, fileId: copied.fileId, ok: true, response: renameResponse });
    } catch (error) {
      renameResults.push({ ...plan, fileId: copied.fileId, ok: false, error: error.message || String(error) });
    }
  }

  const renameOk = renameResults.every((item) => item.ok);
  return {
    ok: transferOk && renameOk,
    transferOk,
    renameOk,
    savedCount: okCount,
    results,
    renameResults
  };
}

async function renameAliyunFile({ driveId, fileId, newName, accessToken, fetchImpl, timeoutMs }) {
  const safeName = sanitizeFileName(newName);
  if (!safeName) throw new Error("新文件名不能为空。");
  return requestAliyun("/adrive/v3/file/update", {
    body: {
      drive_id: driveId,
      file_id: fileId,
      name: safeName,
      check_name_mode: "refuse"
    },
    accessToken,
    fetchImpl,
    timeoutMs
  });
}

async function requestAliyun(endpoint, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境没有 fetch，请升级到 Node.js 20 或更新版本。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const headers = { ...COMMON_HEADERS };
    if (options.accessToken) headers.Authorization = \`Bearer \${options.accessToken}\`;
    if (options.shareToken) headers["x-share-token"] = options.shareToken;
    const response = await fetchImpl(\`\${API_BASE}\${endpoint}\`, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body || {}),
      signal: controller.signal
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(\`阿里云盘接口返回非 JSON：\${text.slice(0, 160)}\`);
    }
    if (!response.ok) throw new Error(\`阿里云盘接口 HTTP \${response.status}：\${json.message || json.code || "request failed"}\`);
    if (json.code && !["200", "0"].includes(String(json.code))) {
      throw new Error(\`阿里云盘接口错误 \${json.code}：\${json.message || json.error || "unknown error"}\`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function readAuthState(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    return { refresh_token: String(value.refresh_token || ""), source_fingerprint: String(value.source_fingerprint || "") };
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(\`读取阿里云盘本地授权状态失败：\${error.message}\`);
  }
}

async function persistAuthState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = \`\${filePath}.\${process.pid}.tmp\`;
  await fs.writeFile(tempPath, \`\${JSON.stringify(state, null, 2)}\n\`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  try { await fs.chmod(filePath, 0o600); } catch {}
}

function buildAliyunSubagentPreview({ args, result }) {
  const selectedItems = result.selectedItems.map((item) => ({
    rank: item.rank,
    fid: item.fid,
    name: item.name,
    isDir: item.isDir,
    size: item.size
  }));
  const renamePlan = result.renamePlan || [];
  return {
    ok: true,
    provider: "aliyun",
    mode: "preview",
    nextAction: "confirm_before_save",
    source: { shareUrl: result.shareUrl, shareId: result.shareId },
    target: { provider: "aliyun", pathOrUrl: result.targetPath, folderId: result.targetFolderId },
    resource: {
      shareTitle: result.shareInfo.share_name || result.shareInfo.share_title || "",
      canonicalName: result.contextName,
      type: result.resource.type,
      label: result.resource.label,
      isSeries: result.resource.isSeries,
      reason: result.resource.reason
    },
    selection: {
      defaultSelection: args.selection || "all",
      selectedRanks: selectedItems.map((item) => item.rank),
      selectedItems
    },
    renamePlan,
    confirmation: {
      source: result.shareUrl,
      selectedItems,
      target: { provider: "aliyun", pathOrUrl: result.targetPath },
      finalNaming: renamePlan.map((item) => ({
        originalName: item.originalName,
        suggestedName: item.suggestedName,
        reason: item.reason
      })),
      commandHint: "After the user confirms this preview, rerun the same command with --yes --format json."
    }
  };
}

function renderPreview(preview) {
  const lines = [
    "### 阿里云盘转存预览",
    "",
    \`- 分享：\${preview.source.shareUrl}\`,
    \`- 保存目录：\${preview.target.pathOrUrl}\`,
    \`- 资源类型：\${preview.resource.label}（\${preview.resource.reason}）\`,
    \`- 已选项目：\${preview.selection.selectedItems.length}\`,
    "",
    "| 序号 | 名称 | 类型 | 大小 |",
    "|---:|---|---|---:|"
  ];
  for (const item of preview.selection.selectedItems) {
    lines.push(\`| \${item.rank} | \${String(item.name).replaceAll("|", " ")} | \${item.isDir ? "文件夹" : "文件"} | \${item.size || "-"} |\`);
  }
  if (preview.renamePlan.length) {
    lines.push("", "建议转存后重命名：", "", "| 原名称 | 建议名称 | 原因 |", "|---|---|---|");
    for (const item of preview.renamePlan) {
      lines.push(\`| \${item.originalName.replaceAll("|", " ")} | \${item.suggestedName.replaceAll("|", " ")} | \${item.reason} |\`);
    }
  }
  lines.push("", "预览模式不会执行转存或重命名。确认后再使用 --yes。");
  return lines.join("\n");
}

function normalizeCloudPath(value) {
  let normalized = String(value || "").trim().split(String.fromCharCode(92)).join("/");
  if (!normalized.startsWith("/") || normalized.includes("..")) throw new Error("ALIYUN_DEFAULT_SAVE_PATH 必须是阿里云盘内的绝对目录路径，例如 /影视库。");
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

export {
  authenticateAliyun,
  buildAliyunRenamePlan,
  buildAliyunSubagentPreview,
  checkAliyunSaveTarget,
  listAliyunShareItems,
  parseAliyunShareUrl,
  parseArgs,
  prepareAliyunSave,
  refreshAliyunToken,
  renameAliyunFile,
  requestAliyun,
  resolveAliyunFolder,
  saveAliyunSelectedItems,
  validateAliyunRefreshToken
};
