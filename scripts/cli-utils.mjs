import path from "node:path";
import { fileURLToPath } from "node:url";

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

export { isCliEntryPoint, parseEnvCliArgs };
