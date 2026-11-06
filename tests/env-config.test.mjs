import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PATHS, loadEnvFile, mergeEnvValues, parseDotEnv, parseDotEnvValue } from "../scripts/env-config.mjs";

test("dotenv parser handles export, quotes and inline comments", () => {
  assert.deepEqual(parseDotEnv('A=one\nexport B="two\\nlines"\nC=value # comment'), {A:"one",B:"two\nlines",C:"value"});
  assert.equal(parseDotEnvValue("'literal # value'"), "literal # value");
});

test("environment precedence keeps process values above file values and injected values", () => {
  const result = mergeEnvValues({A:"file",B:"file"}, {A:"process"}, {B:"injected",C:"injected"});
  assert.equal(result.A, "process");
  assert.equal(result.B, "injected");
  assert.equal(result.C, "injected");
  assert.equal(result.OPENLIST_BASE_URL, "http://127.0.0.1:5244");
  assert.equal(result.OPENLIST_DEFAULT_COPY_DST_PATH, "/本地存储/Downloads");
  assert.equal(result.OPENLIST_STAGING_PATH, "/本地存储/Downloads");
  assert.equal(result.MEDIA_MOVIES_PATH, "/本地存储/Movies");
  assert.equal(result.MEDIA_TVSHOWS_PATH, "/本地存储/TVShows");
  assert.equal(result.ALIYUN_DEFAULT_SAVE_PATH, "/影视库");
  assert.equal(result.QUARK_DEFAULT_SAVE_URL, "/影视库");
  assert.equal(result.BAIDU_DEFAULT_SAVE_PATH, "/影视库");
});

test("missing env files are reported without creating files", () => {
  assert.deepEqual(loadEnvFile(".missing-resource-manager-test.env"), {exists:false,values:{}});
});

test("centralized NAS and cloud-drive defaults are applied and remain overridable", () => {
  const defaults = mergeEnvValues({}, {});
  assert.deepEqual(defaults, DEFAULT_PATHS);
  assert.equal(defaults.OPENLIST_DEFAULT_COPY_DST_PATH, "/本地存储/Downloads");
  assert.equal(defaults.OPENLIST_STAGING_PATH, "/本地存储/Downloads");
  assert.equal(defaults.MEDIA_MOVIES_PATH, "/本地存储/Movies");
  assert.equal(defaults.MEDIA_TVSHOWS_PATH, "/本地存储/TVShows");
  assert.equal(defaults.ALIYUN_DEFAULT_SAVE_PATH, "/影视库");
  assert.equal(
    mergeEnvValues({ OPENLIST_STAGING_PATH: "/custom/Downloads" }, {}).OPENLIST_STAGING_PATH,
    "/custom/Downloads"
  );
});
