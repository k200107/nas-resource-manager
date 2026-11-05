#!/usr/bin/env node
import { loadEnvFile, parseDotEnv } from "./env-config.mjs";
import { isCliEntryPoint as isCli, parseEnvCliArgs } from "./cli-utils.mjs";

/**
 * 读取并检查 .env 配置格式；密钥只显示掩码，不发起网盘或 NAS 写操作。
 *
 * 本文件说明：函数注释解释各步骤职责及重要约束；本次修改仅增加注释，不改变业务执行逻辑。
 * 安全约束：状态推进必须依赖可核验的证据；配置和连通性检查保持只读，凭证不得明文输出。
 */


const DEFAULT_ENV_FILE = ".env";

const PROVIDER_CONFIG = [
  {
    provider: "quark",
    label: "夸克网盘",
    keys: [
      {
        key: "QUARK_COOKIE",
        label: "夸克网盘 Cookie",
        secret: true,
        hint: "从已登录夸克网页请求中复制 Cookie，用于保存分享资源到自己的夸克网盘。"
      },
      {
        key: "QUARK_DEFAULT_SAVE_URL",
        label: "默认夸克保存目录",
        secret: false,
        hint: "夸克网盘目标文件夹路径或 URL，例如 /备份资源，或 https://pan.quark.cn/list#/list/all/<fid>-<name>。",
        validate: (value) => isQuarkSaveTarget(value)
      }
    ]
  },
  {
    provider: "baidu",
    label: "百度网盘",
    keys: [
      {
        key: "BAIDU_COOKIE",
        label: "百度网盘 Cookie",
        secret: true,
        hint: "从已登录百度网盘网页请求中复制 Cookie，通常需要包含 BDUSS、STOKEN 等字段，用于保存分享资源到自己的百度网盘。"
      },
      {
        key: "BAIDU_DEFAULT_SAVE_PATH",
        label: "默认百度保存目录",
        secret: false,
        hint: "百度网盘目标目录路径或目录 URL，例如 /NAS资源下载，或 https://pan.baidu.com/disk/main#/index?...&path=%2FNAS资源下载。",
        validate: (value) => isBaiduSaveTarget(value)
      }
    ]
  }
];

const CORE_CONFIG = [
  {
    key: "OPENLIST_TOKEN",
    label: "OpenList 固定 API Token",
    secret: true,
    hint: "OpenList 后台的固定 Token，用于调用 fs/list、fs/copy 等 API。"
  },
  {
    key: "OPENLIST_BASE_URL",
    label: "OpenList 地址",
    secret: false,
    hint: "OpenList 服务地址，例如 http://127.0.0.1:5244。",
    validate: (value) => isHttpUrl(value)
  },
  {
    key: "OPENLIST_DEFAULT_COPY_DST_PATH",
    label: "默认 SMB/NAS 复制目录",
    secret: false,
    hint: "OpenList 中 SMB/NAS 存储的目标路径，例如 /影视资源备份/影视。",
    validate: (value) => isOpenListPath(value)
  }
];

const REQUIRED_CONFIG = [
  ...CORE_CONFIG,
  ...PROVIDER_CONFIG.flatMap((provider) => provider.keys)
];

if (isCli(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

/** 命令行主入口：解析参数、读取配置、调用检查或状态管理流程并输出结果。 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadEnvFile(args.envFile);
  const env = { ...loaded.values, ...process.env };
  const result = validateSkillEnv(env, {
    envFile: args.envFile,
    envFileExists: loaded.exists
  });

  if (args.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatEnvCheckResult(result));
  }

  if (!result.ok) process.exit(1);
}

/** 解析命令行参数并生成统一参数对象；未知参数会明确报错。 */
function parseArgs(argv) { return parseEnvCliArgs(argv, { defaultEnvFile: DEFAULT_ENV_FILE, defaultFormat: "text" }); }
/** 读取并解析 .env 文件；文件不存在时返回空配置，不创建或修改文件。 */
/** 解析 dotenv 文本，支持注释、export 前缀、引号和常见转义。 */
/** 解析单个 dotenv 值，处理引号、转义字符和行尾注释。 */
/** 检查核心配置和至少一个完整网盘配置，返回缺失项、格式错误项和下一步建议。 */
function validateSkillEnv(env, options = {}) {
  const missing = [];
  const invalid = [];
  const values = {};

  for (const item of REQUIRED_CONFIG) {
    const rawValue = String(env[item.key] || "").trim();
    if (rawValue) {
      values[item.key] = {
        key: item.key,
        label: item.label,
        secret: item.secret,
        displayValue: item.secret ? maskSecret(rawValue) : rawValue
      };
    }
  }

  for (const item of CORE_CONFIG) {
    const rawValue = String(env[item.key] || "").trim();
    if (!rawValue) {
      missing.push(publicConfigItem(item));
      continue;
    }
    if (item.validate && !item.validate(rawValue)) {
      invalid.push(publicConfigItem(item));
    }
  }

  const coreMissing = [...missing];
  const coreInvalid = [...invalid];
  const providerResults = PROVIDER_CONFIG.map((provider) => validateProviderConfig(provider, env));
  const providerOk = providerResults.some((provider) => provider.ok);
  const providerInvalid = providerResults.flatMap((provider) => provider.invalid);
  if (!providerOk) {
    invalid.push(...providerInvalid);
  }
  const nextAction = decideEnvNextAction({
    envFileExists: options.envFileExists !== false,
    missing: coreMissing,
    invalid: coreInvalid,
    providerOk
  });

  return {
    ok: missing.length === 0 && invalid.length === 0 && providerOk && options.envFileExists !== false,
    nextAction,
    providerOk,
    envFile: options.envFile || DEFAULT_ENV_FILE,
    envFileExists: options.envFileExists !== false,
    missing,
    invalid,
    providerResults,
    values,
    requiredKeys: REQUIRED_CONFIG.map((item) => publicConfigItem(item)),
    coreKeys: CORE_CONFIG.map((item) => publicConfigItem(item)),
    providerKeys: PROVIDER_CONFIG.map((provider) => ({
      provider: provider.provider,
      label: provider.label,
      keys: provider.keys.map((item) => publicConfigItem(item))
    }))
  };
}

/** 检查指定网盘所需环境变量是否齐全且格式有效。 */
function validateProviderConfig(provider, env) {
  const missing = [];
  const invalid = [];
  for (const item of provider.keys) {
    const rawValue = String(env[item.key] || "").trim();
    if (!rawValue) {
      missing.push(publicConfigItem(item));
      continue;
    }
    if (item.validate && !item.validate(rawValue)) {
      invalid.push(publicConfigItem(item));
    }
  }
  return {
    provider: provider.provider,
    label: provider.label,
    ok: missing.length === 0 && invalid.length === 0,
    missing,
    invalid
  };
}

/** 根据配置文件、核心配置和网盘配置的完整性决定下一步动作。 */
function decideEnvNextAction({ envFileExists, missing, invalid, providerOk }) {
  if (!envFileExists) return "create_env_file";
  const coreOk = missing.length === 0 && invalid.length === 0;
  if (!coreOk && !providerOk) return "configure_core_and_provider";
  if (!coreOk) return "configure_core";
  if (!providerOk) return "configure_provider";
  return "ready";
}

/** 只提取可公开展示的配置说明字段，不返回校验函数或秘密值。 */
function publicConfigItem(item) {
  return {
    key: item.key,
    label: item.label,
    secret: item.secret,
    hint: item.hint
  };
}

/** 格式化环境变量检查结果；秘密值只展示掩码。 */
function formatEnvCheckResult(result) {
  const lines = ["### Resource 2 NAS ENV 检查", ""];
  if (!result.envFileExists) {
    lines.push(`- 未找到配置文件：${result.envFile}`, "- 先复制 `.env.example` 为 `.env`，再填入真实配置。", "");
  }

  for (const item of result.coreKeys) {
    const value = result.values[item.key];
    const missing = result.missing.some((entry) => entry.key === item.key);
    const invalid = result.invalid.some((entry) => entry.key === item.key);
    const state = missing ? "缺失" : invalid ? "格式不正确" : "已配置";
    const display = value ? value.displayValue : "-";
    lines.push(`- ${item.key}: ${state} (${display})`);
  }

  lines.push("", "网盘转存配置（百度和夸克任选一个完整即可）：");
  for (const provider of result.providerResults) {
    lines.push(`- ${provider.label}: ${provider.ok ? "已配置" : "未完整配置"}`);
    for (const item of result.providerKeys.find((entry) => entry.provider === provider.provider)?.keys || []) {
      const value = result.values[item.key];
      const missing = provider.missing.some((entry) => entry.key === item.key);
      const invalid = provider.invalid.some((entry) => entry.key === item.key);
      const state = missing ? "缺失" : invalid ? "格式不正确" : value ? "已配置" : "未配置";
      const display = value ? value.displayValue : "-";
      lines.push(`  - ${item.key}: ${state} (${display})`);
    }
  }

  if (result.missing.length > 0 || result.invalid.length > 0 || !result.providerOk) {
    lines.push("", "需要处理：");
    for (const item of [...result.missing, ...result.invalid]) {
      lines.push(`- ${item.key}: ${item.hint}`);
    }
    if (!result.providerOk) {
      lines.push("- 至少配置一个完整网盘：夸克需要 QUARK_COOKIE + QUARK_DEFAULT_SAVE_URL，百度需要 BAIDU_COOKIE + BAIDU_DEFAULT_SAVE_PATH。");
    }
  } else {
    lines.push("", "ENV 配置可用于夸克/百度保存、OpenList 刷新和 SMB/NAS 复制。");
  }

  return lines.join("\n");
}

/** 遮蔽密钥中间部分，避免检查输出泄露完整凭证。 */
function maskSecret(value) {
  const text = String(value || "");
  if (text.length < 12) return "***";
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

/** 验证地址是否为 HTTP 或 HTTPS URL。 */
function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** 检查夸克保存目标是否为允许的绝对路径或夸克文件夹 URL。 */
function isQuarkSaveTarget(value) {
  const text = String(value || "").trim();
  if (isCloudDrivePath(text)) return true;
  try {
    const parsed = new URL(text);
    return parsed.hostname.endsWith("quark.cn") && parsed.pathname === "/list" && parsed.hash.includes("/list/all/");
  } catch {
    return false;
  }
}

/** 检查配置项是否符合 OpenList 可见路径格式。 */
function isOpenListPath(value) {
  return isCloudDrivePath(value);
}

/** 检查云盘路径是否为绝对路径且不含路径穿越片段。 */
function isCloudDrivePath(value) {
  return String(value || "").startsWith("/") && !String(value).includes("..");
}

/** 检查百度保存目标是否为允许的绝对路径或百度网盘目录 URL。 */
function isBaiduSaveTarget(value) {
  const text = String(value || "").trim();
  if (isCloudDrivePath(text)) return true;
  try {
    const parsed = new URL(text);
    if (!parsed.hostname.endsWith("pan.baidu.com")) return false;
    const hashQuery = parsed.hash.includes("?") ? parsed.hash.slice(parsed.hash.indexOf("?") + 1) : "";
    const pathValue = new URLSearchParams(hashQuery).get("path") || parsed.searchParams.get("path") || "";
    return isCloudDrivePath(pathValue);
  } catch {
    return false;
  }
}

/** 判断模块是否由 Node.js 直接执行，避免被其他模块导入时触发 CLI 副作用。 */
export {
  REQUIRED_CONFIG,
  formatEnvCheckResult,
  maskSecret,
  parseDotEnv,
  validateSkillEnv
};
