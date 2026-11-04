import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMediaPlan,
  classifyMedia,
  detectSeason,
  parseArgs,
  parseChineseNumber,
  scanTree
} from "../scripts/media-plan.mjs";

test("parseArgs reads OpenList source and media target paths", () => {
  const args = parseArgs(["--source-dir", "/Downloads", "--movies-dir", "/media/Movies", "--tvshows-dir", "/media/TVShows", "--format", "text"]);
  assert.equal(args.sourcePath, "/Downloads");
  assert.equal(args.moviesPath, "/media/Movies");
  assert.equal(args.tvShowsPath, "/media/TVShows");
  assert.equal(args.format, "text");
});

test("classifies explicit episode naming as a series", () => {
  const result = classifyMedia({
    resourceName: "狐妖小红娘",
    files: [{ name: "S03E04_4K.mkv" }]
  });
  assert.equal(result.type, "series");
  assert.equal(result.confidence, "high");
});

test("does not guess a season from an ordinary number", () => {
  assert.equal(detectSeason("狐妖小红娘3_01_4K.mp4"), null);
  assert.equal(detectSeason("S03E01.mkv"), 3);
  assert.equal(detectSeason("Season 02/01_4K.mkv"), 2);
  assert.equal(detectSeason("狐妖小红娘 第三季.mkv"), 3);
  assert.equal(parseChineseNumber("十二"), 12);
});

test("plans movie and series destinations without executing mutations", () => {
  const items = [
    { name: "绿皮书", path: "/Downloads/绿皮书", parentPath: "/Downloads", isDir: true },
    { name: "绿皮书.mkv", path: "/Downloads/绿皮书/绿皮书.mkv", parentPath: "/Downloads/绿皮书", isDir: false },
    { name: "某剧 S02E03.mkv", path: "/Downloads/某剧 S02E03.mkv", parentPath: "/Downloads", isDir: false },
    { name: "未分类资料.zip", path: "/Downloads/未分类资料.zip", parentPath: "/Downloads", isDir: false }
  ];
  const plan = buildMediaPlan({
    sourcePath: "/Downloads",
    items,
    moviesPath: "/media/Movies",
    tvShowsPath: "/media/TVShows"
  });
  assert.equal(plan[0].target, "/media/Movies/绿皮书/绿皮书.mkv");
  assert.equal(plan[1].target, "/media/TVShows/某剧/Season 02/某剧 S02E03.mkv");
  assert.equal(plan[2].status, "review_required");
  assert.equal(plan[2].target, null);
});

test("scanTree only reads OpenList fs/list and traverses nested directories", async () => {
  const calls = [];
  const result = await scanTree({
    baseUrl: "http://openlist.test",
    token: "token",
    timeoutMs: 100,
    rootPath: "/Downloads",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      const dir = JSON.parse(options.body).path;
      const content = dir === "/Downloads"
        ? [{ name: "Movie", is_dir: true }]
        : [{ name: "Movie.mkv", is_dir: false, size: 10 }];
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ code: 200, message: "success", data: { content } }); }
      };
    }
  });
  assert.equal(result.items.length, 2);
  assert.deepEqual(calls.map((call) => call.body.path), ["/Downloads", "/Downloads/Movie"]);
  assert.ok(calls.every((call) => call.url.endsWith("/api/fs/list")));
});

