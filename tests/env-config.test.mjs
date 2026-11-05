import test from "node:test";
import assert from "node:assert/strict";
import { mergeEnvValues, parseDotEnv, parseDotEnvValue } from "../scripts/env-config.mjs";

test("dotenv parser handles export, quotes and inline comments", () => {
  assert.deepEqual(parseDotEnv('A=one\nexport B="two\\nlines"\nC=value # comment'), {A:"one",B:"two\nlines",C:"value"});
  assert.equal(parseDotEnvValue("'literal # value'"), "literal # value");
});

test("environment precedence keeps process values above file values and injected values", () => {
  assert.deepEqual(mergeEnvValues({A:"file",B:"file"}, {A:"process"}, {B:"injected",C:"injected"}), {A:"process",B:"file",C:"injected"});
});
