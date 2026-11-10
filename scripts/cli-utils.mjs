import path from "node:path";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 判断命令行参数是否要求 JSON 输出，用于决定失败信息的输出通道。 */
function wantsJsonOutput(argv = []) {
  return argv.some((arg, index) => arg === "--json" || (arg === "--format" && argv[index + 1] === "json"));
}

/**
 * 还原 Git Bash / MSYS2 对绝对网盘路径的自动转换。
 *
 * 在 Windows 的 Git Bash 里，形如 /影视库 的参数会被改写成
 * C:/.../PortableGit/影视库，导致所有以 / 开头的 OpenList / 网盘路径校验失败。
 * 这里识别转换产物并还原为原始绝对路径，同时在 stderr 留下可见提示。
 */
function restoreMsysPath(value) {
  const text = String(value ?? "");
  if (/^https?:\/\//i.test(text)) return text;
  const match = /^[A-Za-z]:[\\/].*?[\\/](?:PortableGit|Git|mingw64|msys64)[\\/](.+)$/i.exec(text);
  if (!match) return text;
  const restored = `/${match[1].replace(/\\/g, "/")}`;
  process.stderr.write(`[路径修正] Git Bash 转换了绝对网盘路径，已还原为 ${restored}\n`);
  return restored;
}

/** 所有 CLI 统一从这里读取参数，保证路径修正对每个命令生效。 */
function cliArgs() {
  return process.argv.slice(2).map(restoreMsysPath);
}

/**
 * 统一输出 CLI 失败信息并以非零状态结束进程。
 *
 * JSON 模式必须写 stdout：调用方（Agent / 工具）通常只采集 stdout，
 * 仅写 stderr 会表现为“退出码 1 且零输出”的静默失败。用同步写入保证
 * process.exit 之前内容已刷新，避免管道场景下被截断。
 */
function failCli(error, { argv = process.argv.slice(2), exitCode = 1 } = {}) {
  const message = error && error.message ? error.message : String(error);
  const text = `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`;
  if (wantsJsonOutput(argv)) {
    try {
      writeSync(1, text);
    } catch {
      process.stdout.write(text);
    }
  } else {
    process.stderr.write(text);
  }
  process.exit(exitCode);
}

function isCliEntryPoint(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

function parseEnvCliArgs(argv, { defaultEnvFile = ".env", defaultFormat = "text", defaultTimeoutMs, allowTimeout = false } = {}) {
  const parsed = { envFile: defaultEnvFile, format: defaultFormat };
  if (allowTimeout) parsed.timeoutMs = defaultTimeoutMs;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file" || arg === "--dotenv" || arg === "--config") parsed.envFile = argv[++index] || defaultEnvFile;
    else if (arg === "--json") parsed.format = "json";
    else if (arg === "--format") parsed.format = argv[++index] || defaultFormat;
    else if (allowTimeout && arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index] || defaultTimeoutMs);
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else parsed.envFile = arg;
  }
  return parsed;
}

export { cliArgs, failCli, isCliEntryPoint, parseEnvCliArgs, restoreMsysPath, wantsJsonOutput };
