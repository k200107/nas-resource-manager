import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMediaArchive, parseArgs, validatePlanItem } from "../scripts/media-archive.mjs";

const roots = { moviesPath: "/media/Movies", tvShowsPath: "/media/TVShows" };
const plan = [{
  source: "/Downloads/Example.2160p.mkv",
  target: "/media/Movies/Example (2024)/Example (2024) - 2160p.mkv",
  resourceType: "movie", status: "auto_archive_candidate"
}];

test("archive defaults to read-only and preflights source and target", async () => {
  const calls = [];
  const result = await runMediaArchive({
    plan, ...roots, baseUrl: "http://openlist.test", token: "token",
    fetchImpl: fakeOpenList(calls, { "/": [{ name: "Downloads", is_dir: true }, { name: "media", is_dir: true }], "/Downloads": [{ name: "Example.2160p.mkv", is_dir: false }], "/media": [{ name: "Movies", is_dir: true }], "/media/Movies": [] })
  });
  assert.equal(result.mode, "read-only-dry-run");
  assert.equal(result.mutated, false);
  assert.deepEqual(calls.map((x) => x.endpoint), ["/api/fs/list", "/api/fs/list", "/api/fs/list", "/api/fs/list"]);
  assert.equal(calls.some((x) => !x.endpoint.endsWith("/list")), false);
});

test("archive refuses existing target and never calls a mutation endpoint", async () => {
  const calls = [];
  const result = await runMediaArchive({
    plan, ...roots, baseUrl: "http://openlist.test", token: "token",
    fetchImpl: fakeOpenList(calls, {
      "/": [{ name: "Downloads", is_dir: true }, { name: "media", is_dir: true }],
      "/Downloads": [{ name: "Example.2160p.mkv", is_dir: false }],
      "/media": [{ name: "Movies", is_dir: true }],
      "/media/Movies": [{ name: "Example (2024)", is_dir: true }],
      "/media/Movies/Example (2024)": [{ name: "Example (2024) - 2160p.mkv", is_dir: false }]
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.mutated, false);
  assert.equal(result.preflight[0].conflict, true);
  assert.equal(calls.some((x) => ["/api/fs/mkdir", "/api/fs/move", "/api/fs/rename"].includes(x.endpoint)), false);
});

test("confirmed archive creates directory, moves and renames, then verifies", async () => {
  const calls = [];
  const result = await runMediaArchive({
    plan, ...roots, yes: true, baseUrl: "http://openlist.test", token: "token",
    fetchImpl: fakeOpenList(calls, {
      "/": [{ name: "Downloads", is_dir: true }, { name: "media", is_dir: true }],
      "/Downloads": [{ name: "Example.2160p.mkv", is_dir: false }],
      "/media": [{ name: "Movies", is_dir: true }],
      "/media/Movies": []
    }, { verifyTarget: true })
  });
  assert.equal(result.ok, true);
  assert.equal(result.mutated, true);
  assert.deepEqual(calls.filter((x) => x.endpoint !== "/api/fs/list").map((x) => [x.endpoint, x.body]), [
    ["/api/fs/mkdir", { path: "/media/Movies/Example (2024)" }],
    ["/api/fs/move", { src_dir: "/Downloads", dst_dir: "/media/Movies/Example (2024)", names: ["Example.2160p.mkv"] }],
    ["/api/fs/rename", { path: "/media/Movies/Example (2024)/Example.2160p.mkv", name: "Example (2024) - 2160p.mkv" }]
  ]);
  assert.equal(result.executed[0].verified, true);
});

test("explicitly confirmed review item is executable without falsifying its original confidence", async () => {
  const calls = [];
  const reviewed = {
    ...plan[0],
    status: "review_required",
    confidence: "low",
    year: 2024,
    userConfirmed: true,
    confirmation: {
      scope: "move-and-rename",
      source: plan[0].source,
      resourceType: "movie",
      resourceName: plan[0].resourceName,
      year: 2024,
      target: plan[0].target
    }
  };
  const result = await runMediaArchive({
    plan: [reviewed], ...roots, yes: true,
    baseUrl: "http://openlist.test", token: "token",
    fetchImpl: fakeOpenList(calls, {
      "/": [{ name: "Downloads", is_dir: true }, { name: "media", is_dir: true }],
      "/Downloads": [{ name: "Example.2160p.mkv", is_dir: false }],
      "/media": [{ name: "Movies", is_dir: true }],
      "/media/Movies": []
    }, { verifyTarget: true })
  });
  assert.equal(result.ok, true);
  assert.equal(result.confirmedReviewCount, 1);
  assert.equal(reviewed.confidence, "low");
  assert.equal(reviewed.status, "review_required");
  assert.equal(result.executed[0].verified, true);
});

test("review item is preflighted before confirmation but cannot execute", async () => {
  const calls = [];
  const proposed = {
    ...plan[0],
    status: "review_required",
    confidence: "low",
    year: 2024
  };
  const result = await runMediaArchive({
    plan: [proposed], ...roots,
    baseUrl: "http://openlist.test", token: "token",
    fetchImpl: fakeOpenList(calls, {
      "/": [{ name: "Downloads", is_dir: true }, { name: "media", is_dir: true }],
      "/Downloads": [{ name: "Example.2160p.mkv", is_dir: false }],
      "/media": [{ name: "Movies", is_dir: true }],
      "/media/Movies": []
    })
  });
  assert.equal(result.eligible, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.awaitingUserConfirmation, 1);
  assert.equal(result.preflight[0].ok, true);
  assert.equal(result.mutated, false);
  assert.equal(calls.some((call) => ["/api/fs/mkdir", "/api/fs/move", "/api/fs/rename"].includes(call.endpoint)), false);
});

test("mismatched review confirmation remains ineligible after preflight", async () => {
  const calls = [];
  const invalid = {
    ...plan[0],
    status: "review_required",
    confidence: "low",
    year: 2024,
    userConfirmed: true,
    confirmation: {
      scope: "move-and-rename",
      source: plan[0].source,
      resourceType: "movie",
      resourceName: "Different title",
      year: 2024,
      target: plan[0].target
    }
  };
  const result = await runMediaArchive({
    plan: [invalid], ...roots,
    baseUrl: "http://openlist.test", token: "token",
    fetchImpl: fakeOpenList(calls, {
      "/": [{ name: "Downloads", is_dir: true }, { name: "media", is_dir: true }],
      "/Downloads": [{ name: "Example.2160p.mkv", is_dir: false }],
      "/media": [{ name: "Movies", is_dir: true }],
      "/media/Movies": []
    })
  });
  assert.equal(result.eligible, 0);
  assert.equal(result.awaitingUserConfirmation, 1);
  assert.equal(result.preflight[0].ok, true);
  assert.equal(result.mutated, false);
});

test("archive skips review-required entries", async () => {
  const result = await runMediaArchive({
    plan: [{ ...plan[0], status: "review_required" }], ...roots,
    baseUrl: "http://openlist.test", token: "token",
    fetchImpl: async () => { throw new Error("should not request"); }
  });
  assert.equal(result.eligible, 0);
  assert.equal(result.skipped, 1);
});

test("archive rejects targets outside configured library root", () => {
  assert.throws(() => validatePlanItem({ ...plan[0], target: "/other/file.mkv" }, roots), /不在对应媒体库根目录内/);
});

test("parseArgs requires explicit confirmation flag to enable mutations", () => {
  assert.equal(parseArgs(["--plan-file", "plan.json"]).yes, false);
  assert.equal(parseArgs(["--plan-file", "plan.json", "--yes"]).yes, true);
});

function fakeOpenList(calls, listings, { verifyTarget = false } = {}) {
  const moved = new Set();
  return async (url, options) => {
    const endpoint = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ endpoint, body });
    let data = null;
    if (endpoint === "/api/fs/list") {
      const dir = body.path;
      let rows = listings[dir] || [];
      if (verifyTarget && dir === "/media/Movies/Example (2024)" && calls.some((x) => x.endpoint === "/api/fs/rename")) {
        rows = [{ name: "Example (2024) - 2160p.mkv", is_dir: false }];
      }
      data = { content: rows };
    } else if (endpoint === "/api/fs/mkdir") {
      listings[body.path] = [];
    } else if (endpoint === "/api/fs/move") {
      moved.add(body.names[0]);
    } else if (endpoint === "/api/fs/rename") {
      // Mutation behavior is represented by the verification listing above.
    } else {
      throw new Error("Unexpected endpoint " + endpoint);
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 200, message: "success", data }); } };
  };
}


test("verified archive operations are idempotent on a repeated plan", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nas-resource-manager-archive-"));
  const storePath = path.join(temp, "media-tasks.json");
  const lockDir = path.join(temp, "locks");
  const calls = [];
  const groupedPlan = [{ ...plan[0], resourceGroupId: "/Downloads/Example" }];
  try {
    const first = await runMediaArchive({
      plan: groupedPlan, ...roots, yes: true,
      baseUrl: "http://openlist.test", token: "token", storePath, lockDir,
      fetchImpl: fakeOpenList(calls, {
        "/": [{ name: "Downloads", is_dir: true }, { name: "media", is_dir: true }],
        "/Downloads": [{ name: "Example.2160p.mkv", is_dir: false }],
        "/media": [{ name: "Movies", is_dir: true }],
        "/media/Movies": []
      }, { verifyTarget: true })
    });
    assert.equal(first.ok, true);
    assert.equal(first.executed[0].verified, true);

    const second = await runMediaArchive({
      plan: groupedPlan, ...roots, yes: true,
      baseUrl: "http://openlist.test", token: "token", storePath, lockDir,
      fetchImpl: async () => { throw new Error("idempotent replay must not call OpenList"); }
    });
    assert.equal(second.ok, true);
    assert.equal(second.mode, "idempotent-noop");
    assert.equal(second.mutated, false);
    assert.equal(second.alreadyArchived.length, 1);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
