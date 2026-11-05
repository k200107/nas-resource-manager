import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMediaPlan,
  classifyMedia,
  detectSeason,
  parseArgs,
  parseChineseNumber,
  scanTree,
  resolveMediaTitle
} from "../scripts/media-plan.mjs";
import { extractResolution, buildMovieFileName, buildSeriesFileName } from "../scripts/media-identity.mjs";

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
  assert.equal(plan[1].target, "/media/TVShows/某剧/Season 02/某剧 - S02E03.mkv");
  assert.equal(plan[0].status, "auto_archive_candidate");
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



test("recognizes a known homophone alias as a candidate requiring user confirmation", () => {
  const result = resolveMediaTitle("肖生客的救赎");
  assert.equal(result.matched, true);
  assert.equal(result.canonicalTitle, "肖申克的救赎");
  assert.equal(result.matchType, "alias");
  assert.equal(result.requiresReview, true);
});

test("extracts resolution and creates Emby-style distinct version filenames", () => {
  assert.equal(extractResolution("Movie.2048p.mkv").value, "2048p");
  assert.equal(extractResolution("Movie_2048.mkv").value, "2048p");
  assert.equal(extractResolution("Movie.1440p.mkv").value, "1440p");
  assert.equal(extractResolution("Movie.1080p.mkv").value, "1080p");
  assert.equal(extractResolution("anything.mkv", { width: 3840, height: 2160 }).value, "2160p");
  assert.equal(extractResolution("anything.mkv", { width: 2048, height: 1080 }).value, "2048p");
  assert.equal(extractResolution("anything.mkv", { width: 2560, height: 1440 }).value, "1440p");
  assert.equal(buildMovieFileName("Example", 2024, "1080p", ".mkv"), "Example (2024) - 1080p.mkv");
  assert.equal(buildMovieFileName("Example", 2024, "2048p", ".mkv"), "Example (2024) - 2048p.mkv");
  assert.equal(buildSeriesFileName("Example", 1, 2, "1080p", ".mkv"), "Example - S01E02 - 1080p.mkv");
});

test("plans multiple movie resolutions as separate Emby versions", () => {
  const items = [
    { name: "Example (2024)", path: "/Downloads/Example (2024)", parentPath: "/Downloads", isDir: true },
    { name: "Example.1080p.mkv", path: "/Downloads/Example (2024)/Example.1080p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "Example.2048p.mkv", path: "/Downloads/Example (2024)/Example.2048p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const plan = buildMediaPlan({ sourcePath: "/Downloads", items, moviesPath: "/media/Movies", tvShowsPath: "/media/TVShows" });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].target, "/media/Movies/Example (2024)/Example (2024) - 1080p.mkv");
  assert.equal(plan[1].target, "/media/Movies/Example (2024)/Example (2024) - 2048p.mkv");
  assert.ok(plan.every((item) => item.status === "auto_archive_candidate"));
});

test("pauses exact destination collisions and incomplete destination scans", () => {
  const items = [
    { name: "Example (2024)", path: "/Downloads/Example (2024)", parentPath: "/Downloads", isDir: true },
    { name: "Example.mkv", path: "/Downloads/Example (2024)/Example.mkv", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const collision = buildMediaPlan({
    sourcePath: "/Downloads", items, moviesPath: "/media/Movies", tvShowsPath: "/media/TVShows",
    existingPaths: ["/media/Movies/Example (2024)/Example (2024).mkv"]
  });
  assert.equal(collision[0].status, "conflict");
  assert.equal(collision[0].conflict, true);
  const incomplete = buildMediaPlan({
    sourcePath: "/Downloads", items, moviesPath: "/media/Movies", tvShowsPath: "/media/TVShows",
    destinationScanComplete: false
  });
  assert.equal(incomplete[0].status, "review_required");
});


test("holds homophone title candidates for confirmation instead of silently renaming", () => {
  const items = [
    { name: "肖生客的救赎 (1994)", path: "/Downloads/肖生客的救赎 (1994)", parentPath: "/Downloads", isDir: true },
    { name: "肖生客的救赎.mkv", path: "/Downloads/肖生客的救赎 (1994)/肖生客的救赎.mkv", parentPath: "/Downloads/肖生客的救赎 (1994)", isDir: false }
  ];
  const plan = buildMediaPlan({ sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows" });
  assert.equal(plan[0].resourceName, "肖申克的救赎");
  assert.equal(plan[0].status, "review_required");
  assert.equal(plan[0].titleMatch.matchType, "alias");
});

test("different resolution versions do not collide with each other", () => {
  const items = [
    { name: "Example (2024)", path: "/Downloads/Example (2024)", parentPath: "/Downloads", isDir: true },
    { name: "Example.2048p.mkv", path: "/Downloads/Example (2024)/Example.2048p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const plan = buildMediaPlan({
    sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows",
    existingPaths: ["/Movies/Example (2024)/Example (2024) - 1080p.mkv"]
  });
  assert.equal(plan[0].status, "auto_archive_candidate");
  assert.equal(plan[0].conflict, false);
});
