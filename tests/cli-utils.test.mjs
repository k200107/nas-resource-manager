import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvCliArgs } from "../scripts/cli-utils.mjs";

test("shared env CLI parser supports aliases and format", () => {
  assert.deepEqual(parseEnvCliArgs(["--config","custom.env","--json"], {defaultEnvFile:".env",defaultFormat:"text"}), {envFile:"custom.env",format:"json"});
});

test("shared env CLI parser only accepts timeout when enabled", () => {
  assert.deepEqual(parseEnvCliArgs(["--timeout-ms","5000"], {defaultEnvFile:".env",defaultFormat:"json",defaultTimeoutMs:20000,allowTimeout:true}), {envFile:".env",format:"json",timeoutMs:5000});
  assert.throws(() => parseEnvCliArgs(["--timeout-ms","5000"], {defaultEnvFile:".env",defaultFormat:"text"}), /Unknown option/);
});
