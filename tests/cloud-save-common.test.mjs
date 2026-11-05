import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyResource,
  escapeMarkdownCell,
  extractEpisodeLabel,
  formatBytes,
  formatTimestamp,
  normalizeContextName,
  parseJson,
  parseSelection,
  sanitizeFileName,
  suggestSavedName
} from "../scripts/cloud-save-common.mjs";

test("shared resource classification and selection preserve provider-neutral behavior", () => {
  assert.equal(classifyResource({ resourceType: "series" }).type, "series");
  assert.deepEqual(parseSelection("1,3-4", [{rank:1},{rank:2},{rank:3},{rank:4}]).map(x=>x.rank), [1,3,4]);
  assert.throws(() => parseSelection("4-2", []), /Invalid selection range/);
});

test("shared naming helpers normalize episode labels and unsafe filenames", () => {
  assert.equal(extractEpisodeLabel("剧名 S1E2 1080p.mkv"), "S01E02");
  assert.equal(sanitizeFileName("A/B:C"), "A B C");
  assert.equal(suggestSavedName({baseName:"剧名",item:{name:"剧名 S1E2.mkv",isDir:false},selectedCount:1,isSeries:true}), "剧名 S01E02.mkv");
});

test("shared output helpers retain Markdown and byte formatting", () => {
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(escapeMarkdownCell("a|b"), "a\\|b");
  assert.deepEqual(parseJson('[1]', "--items"), [1]);
  assert.throws(() => parseJson("{", "--items"), /--items must be valid JSON/);
});

test("timestamp formatter supports both millisecond and Unix-second provider values", () => {
  assert.equal(formatTimestamp(1760000000000), new Date(1760000000000).toISOString().slice(0,10));
  assert.equal(formatTimestamp(1760000000, {unixSeconds:true}), new Date(1760000000000).toISOString().slice(0,10));
});

test("context names are normalized consistently", () => {
  assert.equal(normalizeContextName("A 蜘蛛侠丨 "), "蜘蛛侠");
});
