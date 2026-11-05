import fs from "node:fs";

function parseDotEnv(input) {
  const values = {};
  for (const rawLine of String(input || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalIndex = normalized.indexOf("=");
    if (equalIndex === -1) continue;
    const key = normalized.slice(0, equalIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = parseDotEnvValue(normalized.slice(equalIndex + 1).trim());
  }
  return values;
}

function parseDotEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    if (value.startsWith('"')) return inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return inner;
  }
  const commentIndex = value.search(/\s#/);
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}

function loadEnvFile(envFile = ".env") {
  if (!envFile || !fs.existsSync(envFile)) return { exists: false, values: {} };
  return { exists: true, values: parseDotEnv(fs.readFileSync(envFile, "utf8")) };
}

function mergeEnvValues(fileValues = {}, processValues = process.env, injectedValues = null) {
  return { ...(injectedValues || fileValues || {}), ...(processValues || {}) };
}

export { loadEnvFile, mergeEnvValues, parseDotEnv, parseDotEnvValue };
