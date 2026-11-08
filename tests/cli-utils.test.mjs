import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseEnvCliArgs, restoreMsysPath, wantsJsonOutput } from "../scripts/cli-utils.mjs";

test("shared env CLI parser supports aliases and format", () => {
  assert.deepEqual(parseEnvCliArgs(["--config","custom.env","--json"], {defaultEnvFile:".env",defaultFormat:"text"}), {envFile:"custom.env",format:"json"});
});

test("shared env CLI parser only accepts timeout when enabled", () => {
  assert.deepEqual(parseEnvCliArgs(["--timeout-ms","5000"], {defaultEnvFile:".env",defaultFormat:"json",defaultTimeoutMs:20000,allowTimeout:true}), {envFile:".env",format:"json",timeoutMs:5000});
  assert.throws(() => parseEnvCliArgs(["--timeout-ms","5000"], {defaultEnvFile:".env",defaultFormat:"text"}), /Unknown option/);
});

test("wantsJsonOutput recognises both JSON flags", () => {
  assert.equal(wantsJsonOutput(["片名", "--format", "json", "--compact"]), true);
  assert.equal(wantsJsonOutput(["片名", "--json"]), true);
  assert.equal(wantsJsonOutput(["片名", "--format", "text"]), false);
  assert.equal(wantsJsonOutput([]), false);
});

test("restoreMsysPath repairs Git Bash converted cloud paths", () => {
  assert.equal(restoreMsysPath("C:/Users/me/AppData/Local/Programs/WorkBuddy/resources/vendor/PortableGit/影视库"), "/影视库");
  assert.equal(restoreMsysPath("C:/Program Files/Git/本地存储/Downloads"), "/本地存储/Downloads");
  assert.equal(restoreMsysPath("https://www.alipan.com/s/abc"), "https://www.alipan.com/s/abc");
  assert.equal(restoreMsysPath("/影视库"), "/影视库");
  assert.equal(restoreMsysPath("C:/Users/me/notes.txt"), "C:/Users/me/notes.txt");
});

test("failCli writes a parseable error to stdout in JSON mode", () => {
  // Windows 下动态 import 必须使用 file:// URL，不能用盘符绝对路径。
  const helper = JSON.stringify(new URL("../scripts/cli-utils.mjs", import.meta.url).href);
  const script = `
    const { failCli } = await import(${helper});
    process.argv = [process.argv[0], "cli.mjs", "--format", "json"];
    failCli(new Error("boom"));
  `;
  let exitCode = 0;
  let stdout = "";
  let stderr = "";

  try {
    stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    exitCode = error.status;
    stdout = error.stdout || "";
    stderr = error.stderr || "";
  }

  assert.equal(exitCode, 1);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { ok: false, error: "boom" });
});
