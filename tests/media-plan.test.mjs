import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMediaPlan,
  compactPlanResult,
  classifyMedia,
  detectSeason,
  parseArgs,
  parseChineseNumber,
  scanTree,
  scanSingleFile,
  scanTargetConflicts,
  resolveMediaTitle
} from "../scripts/media-plan.mjs";
import { extractEpisode, extractResolution, buildMovieFileName, buildSeriesFileName } from "../scripts/media-identity.mjs";

test("parseArgs accepts a resource filter and plan output path", () => {
  const args = parseArgs(["--source-dir", "/Downloads", "--resource", "奥本海默", "--output-file", "C:/Temp/plan.json"]);
  assert.equal(args.resourceFilter, "奥本海默");
  assert.equal(args.outputFile, "C:/Temp/plan.json");
});

test("filterPlanByResource keeps all assets belonging to the selected resource", () => {
  const items = [
    { resourceName: "奥本海默", originalResourceName: "奥本海默 (2023)", source: "/Downloads/奥本海默/movie.mkv" },
    { resourceName: "奥本海默", originalResourceName: "奥本海默 (2023)", source: "/Downloads/奥本海默/poster.jpg" },
    { resourceName: "奥德赛", originalResourceName: "奥德赛 (2026)", source: "/Downloads/奥德赛/movie.mkv" }
  ];
  assert.deepEqual(filterPlanByResource(items, "奥本海默"), items.slice(0, 2));
  assert.deepEqual(filterPlanByResource(items, ""), items);
});

test("parseArgs reads OpenList source and media target paths", () => {
  const args = parseArgs(["--source-dir", "/Downloads", "--movies-dir", "/media/Movies", "--tvshows-dir", "/media/TVShows", "--format", "text"]);
  assert.equal(args.sourcePath, "/Downloads");
  assert.equal(args.moviesPath, "/media/Movies");
  assert.equal(args.tvShowsPath, "/media/TVShows");
  assert.equal(args.format, "text");
});

test("parseArgs supports a single source file and compact JSON", () => {
  const args = parseArgs(["--file", "/Downloads/Movie.mkv", "--compact"]);
  assert.equal(args.sourceFile, "/Downloads/Movie.mkv");
  assert.equal(args.compact, true);
  assert.throws(() => parseArgs(["--file", "/Downloads/Movie.mkv", "--source-dir", "/Downloads"]), /不能同时使用/);
});

test("scanSingleFile reads only the containing directory and returns only the requested file", async () => {
  const calls = [];
  const result = await scanSingleFile({
    baseUrl: "http://openlist.test",
    token: "token",
    timeoutMs: 100,
    filePath: "/Downloads/Selected.mkv",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ endpoint: new URL(url).pathname, body });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            code: 200,
            message: "success",
            data: { content: [
              { name: "Selected.mkv", is_dir: false, size: 10 },
              { name: "Unrelated movie", is_dir: true },
              { name: "Other.mkv", is_dir: false, size: 20 }
            ] }
          });
        }
      };
    }
  });
  assert.deepEqual(calls.map((call) => call.body.path), ["/Downloads"]);
  assert.deepEqual(result.items.map((item) => item.path), ["/Downloads/Selected.mkv"]);
  assert.equal(result.truncated, false);
});

test("compact plan output keeps execution fields and omits verbose metadata", () => {
  const output = JSON.parse(compactPlanResult({
    ok: true,
    tool: "media-plan",
    mode: "read-only-dry-run",
    mutated: false,
    source: { path: "/Downloads/Movie.mkv", scope: "single-file", scannedItems: 1, truncated: false },
    targets: { movies: "/Movies", tvShows: "/TVShows" },
    summary: { total: 1, movies: 1 },
    plan: [{
      source: "/Downloads/Movie.mkv",
      target: "/Movies/Movie (2024)/Movie (2024).mkv",
      resourceType: "movie",
      confidence: "high",
      status: "auto_archive_candidate",
      reason: "year detected",
      verboseDebugPayload: "omit"
    }],
    nextAction: "review_plan"
  }));
  assert.equal(output.plan[0].target, "/Movies/Movie (2024)/Movie (2024).mkv");
  assert.equal(output.plan[0].status, "auto_archive_candidate");
  assert.equal("verboseDebugPayload" in output.plan[0], false);
  assert.equal(output.source.scannedItems, 1);
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



test("does not mark unmatched ordinary titles as requiring title review", () => {
  const result = resolveMediaTitle("The Last of Us");
  assert.equal(result.matched, false);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.requiresReview, false);
});

test("recognizes a known homophone alias as a candidate requiring user confirmation", () => {
  const result = resolveMediaTitle("肖生客的救赎");
  assert.equal(result.matched, true);
  assert.equal(result.canonicalTitle, "肖申克的救赎");
  assert.equal(result.matchType, "alias");
  assert.equal(result.requiresReview, true);
});

test("recognizes a noisy Chinese Shawshank filename as a reviewable movie candidate", () => {
  const plan = buildMediaPlan({
    sourcePath: "/本地存储/Downloads",
    items: [{
      name: "申克的救赎BD1280高清中英双字.mp4",
      path: "/本地存储/Downloads/申克的救赎BD1280高清中英双字.mp4",
      parentPath: "/本地存储/Downloads",
      isDir: false
    }],
    moviesPath: "/本地存储/Movies",
    tvShowsPath: "/本地存储/TVShows"
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].resourceType, "movie");
  assert.equal(plan[0].resourceName, "肖申克的救赎");
  assert.equal(plan[0].year, 1994);
  assert.equal(plan[0].confidence, "medium");
  assert.equal(plan[0].status, "review_required");
  assert.equal(plan[0].target, "/本地存储/Movies/肖申克的救赎 (1994)/肖申克的救赎 (1994).mp4");
  assert.equal(plan[0].titleMatch.matchType, "alias");
});

test("does not mistake resolution suffixes or title letters for episode numbers", () => {
  assert.equal(extractResolution("Example.1080p.mkv").value, "1080p");
  assert.equal(extractEpisode("Example.1080p.mkv").episode, null);
  assert.equal(extractEpisode("Show.E03.mkv").episode, 3);
  assert.equal(extractEpisode("Show.EP03.mkv").episode, 3);
});

test("extracts resolution and creates Emby-style distinct version filenames", () => {
  assert.equal(extractResolution("Movie.2160p.mkv").value, "2160p");
  assert.equal(extractResolution("Movie_2160p.mkv").value, "2160p");
  assert.equal(extractResolution("Movie.1440p.mkv").value, "1440p");
  assert.equal(extractResolution("Movie.1080p.mkv").value, "1080p");
  assert.equal(extractResolution("anything.mkv", { width: 3840, height: 2160 }).value, "2160p");
  assert.equal(extractResolution("anything.mkv", { width: 1920, height: 1080 }).value, "1080p");
  assert.equal(extractResolution("anything.mkv", { width: 2560, height: 1440 }).value, "1440p");
  assert.equal(buildMovieFileName("Example", 2024, "1080p", ".mkv"), "Example (2024) - 1080p.mkv");
  assert.equal(buildMovieFileName("Example", 2024, "2160p", ".mkv"), "Example (2024) - 2160p.mkv");
  assert.equal(buildSeriesFileName("Example", 1, 2, "1080p", ".mkv"), "Example - S01E02 - 1080p.mkv");
});

test("plans multiple movie resolutions as separate Emby versions", () => {
  const items = [
    { name: "Example (2024)", path: "/Downloads/Example (2024)", parentPath: "/Downloads", isDir: true },
    { name: "Example.1080p.mkv", path: "/Downloads/Example (2024)/Example.1080p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "Example.2160p.mkv", path: "/Downloads/Example (2024)/Example.2160p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const plan = buildMediaPlan({ sourcePath: "/Downloads", items, moviesPath: "/media/Movies", tvShowsPath: "/media/TVShows" });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].target, "/media/Movies/Example (2024)/Example (2024) - 1080p.mkv");
  assert.equal(plan[1].target, "/media/Movies/Example (2024)/Example (2024) - 2160p.mkv");
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
    { name: "Example.2160p.mkv", path: "/Downloads/Example (2024)/Example.2160p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const plan = buildMediaPlan({
    sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows",
    existingPaths: ["/Movies/Example (2024)/Example (2024) - 1080p.mkv"]
  });
  assert.equal(plan[0].status, "auto_archive_candidate");
  assert.equal(plan[0].conflict, false);
});


test("checks only target parent paths through read-only OpenList fs/list", async () => {
  const calls = [];
  const result = await scanTargetConflicts({
    baseUrl: "http://openlist.test",
    token: "token",
    timeoutMs: 100,
    moviesPath: "/Movies",
    tvShowsPath: "/TVShows",
    plan: [{
      target: "/Movies/Example (2024)/Example (2024) - 1080p.mkv",
      resourceType: "movie"
    }],
    fetchImpl: async (url, options) => {
      const dir = JSON.parse(options.body).path;
      calls.push(dir);
      const content = dir === "/Movies"
        ? [{ name: "Example (2024)", is_dir: true }]
        : [{ name: "Example (2024) - 1080p.mkv", is_dir: false }];
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ code: 200, message: "success", data: { content } }); }
      };
    }
  });
  assert.deepEqual(calls, ["/Movies", "/Movies/Example (2024)"]);
  assert.deepEqual(result.existingPaths, ["/Movies/Example (2024)/Example (2024) - 1080p.mkv"]);
  assert.equal(result.complete, true);
});

test("treats a missing title folder as a clear target without recursively scanning the library", async () => {
  const calls = [];
  const result = await scanTargetConflicts({
    baseUrl: "http://openlist.test", token: "token", timeoutMs: 100,
    moviesPath: "/Movies", tvShowsPath: "/TVShows",
    plan: [{ target: "/Movies/New Film (2025)/New Film (2025).mkv", resourceType: "movie" }],
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body).path);
      return {
        ok: true, status: 200,
        async text() { return JSON.stringify({ code: 200, message: "success", data: { content: [] } }); }
      };
    }
  });
  assert.deepEqual(calls, ["/Movies"]);
  assert.deepEqual(result.existingPaths, []);
  assert.equal(result.complete, true);
});


test("paginates OpenList directory listings before declaring a destination clear", async () => {
  const calls = [];
  const result = await scanTargetConflicts({
    baseUrl: "http://openlist.test", token: "token", timeoutMs: 100,
    moviesPath: "/Movies", tvShowsPath: "/TVShows",
    plan: [{ target: "/Movies/Example (2024)/Example (2024) - 1080p.mkv", resourceType: "movie" }],
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ path: body.path, page: body.page });
      let content = [];
      if (body.path === "/Movies" && body.page === 1) {
        content = Array.from({ length: 200 }, (_, index) => ({ name: "Folder " + index, is_dir: true }));
      } else if (body.path === "/Movies" && body.page === 2) {
        content = [{ name: "Example (2024)", is_dir: true }];
      } else if (body.path === "/Movies/Example (2024)") {
        content = [{ name: "Example (2024) - 1080p.mkv", is_dir: false }];
      }
      return {
        ok: true, status: 200,
        async text() { return JSON.stringify({ code: 200, message: "success", data: { content } }); }
      };
    }
  });
  assert.deepEqual(calls, [
    { path: "/Movies", page: 1 },
    { path: "/Movies", page: 2 },
    { path: "/Movies/Example (2024)", page: 1 }
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.existingPaths.length, 1);
});


test("does not auto-classify loose videos without movie or series evidence", () => {
  const items = [
    { name: "unknown_clip.mkv", path: "/Downloads/unknown_clip.mkv", parentPath: "/Downloads", isDir: false }
  ];
  const plan = buildMediaPlan({
    sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows"
  });
  assert.equal(plan[0].resourceType, "unknown");
  assert.equal(plan[0].target, null);
  assert.equal(plan[0].status, "review_required");
});

test("holds media items when the staging scan is incomplete", () => {
  const items = [
    { name: "Example (2024)", path: "/Downloads/Example (2024)", parentPath: "/Downloads", isDir: true },
    { name: "Example.mkv", path: "/Downloads/Example (2024)/Example.mkv", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const plan = buildMediaPlan({
    sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows",
    sourceScanComplete: false
  });
  assert.equal(plan[0].status, "review_required");
});

test("plans 1080p and 2160p movie versions independently without treating 2160p as a year", () => {
  const items = [
    { name: "Example (2024)", path: "/Downloads/Example (2024)", parentPath: "/Downloads", isDir: true },
    { name: "Example.1080p.mkv", path: "/Downloads/Example (2024)/Example.1080p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "Example.2160p.mkv", path: "/Downloads/Example (2024)/Example.2160p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const plan = buildMediaPlan({ sourcePath: "/Downloads", items, moviesPath: "/media/Movies", tvShowsPath: "/media/TVShows" });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((item) => item.resolution), ["1080p", "2160p"]);
  assert.deepEqual(plan.map((item) => item.year), [2024, 2024]);
  assert.deepEqual(plan.map((item) => item.target), [
    "/media/Movies/Example (2024)/Example (2024) - 1080p.mkv",
    "/media/Movies/Example (2024)/Example (2024) - 2160p.mkv"
  ]);
  assert.ok(plan.every((item) => item.status === "auto_archive_candidate"));
});

test("plans multiple seasons into separate Season directories", () => {
  const items = [
    { name: "Series", path: "/Downloads/Series", parentPath: "/Downloads", isDir: true },
    { name: "S01E01.mkv", path: "/Downloads/Series/Season 01/S01E01.mkv", parentPath: "/Downloads/Series/Season 01", isDir: false },
    { name: "S02E01.mkv", path: "/Downloads/Series/Season 02/S02E01.mkv", parentPath: "/Downloads/Series/Season 02", isDir: false }
  ];
  const plan = buildMediaPlan({ sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows" });
  assert.deepEqual(plan.map((item) => item.target), [
    "/TVShows/Series/Season 01/Series - S01E01.mkv",
    "/TVShows/Series/Season 02/Series - S02E01.mkv"
  ]);
});

test("associates movie subtitles, artwork and NFO with the movie and matching resolution versions", () => {
  const items = [
    { name: "Example (2024)", path: "/Downloads/Example (2024)", parentPath: "/Downloads", isDir: true },
    { name: "Example.1080p.mkv", path: "/Downloads/Example (2024)/Example.1080p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "Example.2160p.mkv", path: "/Downloads/Example (2024)/Example.2160p.mkv", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "Example.1080p.zh-CN.srt", path: "/Downloads/Example (2024)/Example.1080p.zh-CN.srt", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "Example.2160p.en.srt", path: "/Downloads/Example (2024)/Example.2160p.en.srt", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "Example.zh-CN.srt", path: "/Downloads/Example (2024)/Example.zh-CN.srt", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "poster.jpg", path: "/Downloads/Example (2024)/poster.jpg", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "fanart.jpg", path: "/Downloads/Example (2024)/fanart.jpg", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "movie.nfo", path: "/Downloads/Example (2024)/movie.nfo", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const plan = buildMediaPlan({ sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows" });
  const bySource = new Map(plan.map((item) => [item.source, item]));
  assert.equal(bySource.get("/Downloads/Example (2024)/Example.1080p.zh-CN.srt").target,
    "/Movies/Example (2024)/Example (2024) - 1080p.zh-CN.srt");
  assert.equal(bySource.get("/Downloads/Example (2024)/Example.2160p.en.srt").target,
    "/Movies/Example (2024)/Example (2024) - 2160p.en.srt");
  assert.equal(bySource.get("/Downloads/Example (2024)/Example.zh-CN.srt").target,
    "/Movies/Example (2024)/Example (2024).zh-CN.srt");
  assert.equal(bySource.get("/Downloads/Example (2024)/poster.jpg").target,
    "/Movies/Example (2024)/poster.jpg");
  assert.equal(bySource.get("/Downloads/Example (2024)/fanart.jpg").target,
    "/Movies/Example (2024)/fanart.jpg");
  assert.equal(bySource.get("/Downloads/Example (2024)/movie.nfo").target,
    "/Movies/Example (2024)/movie.nfo");
  assert.ok(plan.filter((item) => item.assetRole !== "video").every((item) => item.status === "auto_archive_candidate"));
});

test("recognizes a year parent directory without treating the year as the movie title", () => {
  const items = [
    { name: "2024", path: "/Downloads/2024", parentPath: "/Downloads", isDir: true },
    { name: "Example", path: "/Downloads/2024/Example", parentPath: "/Downloads/2024", isDir: true },
    { name: "Example.mkv", path: "/Downloads/2024/Example/Example.mkv", parentPath: "/Downloads/2024/Example", isDir: false },
    { name: "poster.jpg", path: "/Downloads/2024/Example/poster.jpg", parentPath: "/Downloads/2024/Example", isDir: false }
  ];
  const plan = buildMediaPlan({ sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows" });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].target, "/Movies/Example (2024)/Example (2024).mkv");
  assert.equal(plan[1].target, "/Movies/Example (2024)/poster.jpg");
  assert.ok(plan.every((item) => item.status === "auto_archive_candidate"));
});

test("associates episode subtitles using season directory and episode number", () => {
  const items = [
    { name: "Show", path: "/Downloads/Show", parentPath: "/Downloads", isDir: true },
    { name: "Season 01", path: "/Downloads/Show/Season 01", parentPath: "/Downloads/Show", isDir: true },
    { name: "E01.mkv", path: "/Downloads/Show/Season 01/E01.mkv", parentPath: "/Downloads/Show/Season 01", isDir: false },
    { name: "E01.zh-CN.srt", path: "/Downloads/Show/Season 01/E01.zh-CN.srt", parentPath: "/Downloads/Show/Season 01", isDir: false }
  ];
  const plan = buildMediaPlan({ sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows" });
  assert.equal(plan[0].target, "/TVShows/Show/Season 01/Show - S01E01.mkv");
  assert.equal(plan[1].target, "/TVShows/Show/Season 01/Show - S01E01.zh-CN.srt");
  assert.equal(plan[1].status, "auto_archive_candidate");
});


test("holds an artwork sidecar when its target already exists", () => {
  const items = [
    { name: "Example (2024)", path: "/Downloads/Example (2024)", parentPath: "/Downloads", isDir: true },
    { name: "Example.mkv", path: "/Downloads/Example (2024)/Example.mkv", parentPath: "/Downloads/Example (2024)", isDir: false },
    { name: "poster.jpg", path: "/Downloads/Example (2024)/poster.jpg", parentPath: "/Downloads/Example (2024)", isDir: false }
  ];
  const plan = buildMediaPlan({
    sourcePath: "/Downloads", items, moviesPath: "/Movies", tvShowsPath: "/TVShows",
    existingPaths: ["/Movies/Example (2024)/poster.jpg"]
  });
  const poster = plan.find((item) => item.assetRole === "artwork");
  assert.equal(poster.status, "conflict");
  assert.equal(poster.conflict, true);
  assert.match(poster.reason, /禁止覆盖|已存在同名文件/);
});
