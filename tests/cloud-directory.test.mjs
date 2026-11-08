import test from "node:test";
import assert from "node:assert/strict";

import {
  directoryPlanFields,
  resolveCloudDirectory,
  resolveDirectoryMode
} from "../scripts/cloud-directory.mjs";
import { parseArgs as parseAliyunArgs, resolveAliyunFolder } from "../scripts/aliyun-save.mjs";

const joinPath = (parentPath, segment) => `${String(parentPath).replace(/\/+$/, "")}/${segment}`;
const placeholder = (parent, segment, pendingPath) => ({
  id: null, name: segment, path: pendingPath, pendingCreate: true
});

function makeAdapters({ existing = new Set(), createId = (segment) => `id-${segment}` } = {}) {
  const calls = { list: 0, create: 0 };
  return {
    calls,
    adapters: {
      listSegment: async (parent, segment) => {
        calls.list += 1;
        return existing.has(segment) ? { id: createId(segment), name: segment, path: joinPath(parent.path, segment) } : null;
      },
      createSegment: async (parent, segment, pendingPath) => {
        calls.create += 1;
        return { id: createId(segment), name: segment, path: pendingPath };
      },
      placeholder,
      joinPath
    }
  };
}

test("directory mode: preview is read-only and always wins over --yes", () => {
  assert.equal(resolveDirectoryMode({}), "strict");
  assert.equal(resolveDirectoryMode({ yes: true }), "create");
  assert.equal(resolveDirectoryMode({ dryRun: true }), "preview");
  assert.equal(resolveDirectoryMode({ yes: true, dryRun: true }), "preview");
  assert.equal(resolveDirectoryMode({ yes: true, dryRun: true, noCreateDir: true }), "strict");
  assert.equal(directoryPlanFields().willCreateDirectories.length, 0);
});

test("strict mode reports missing directory without creating anything", async () => {
  const { calls, adapters } = makeAdapters();
  await assert.rejects(
    () => resolveCloudDirectory({ segments: ["本地存储", "Downloads"], ...adapters, mode: "strict", providerLabel: "测试网盘" }),
    /保存目录不存在.*\/本地存储/
  );
  assert.equal(calls.create, 0);
});

test("preview mode lists pending directories but never calls createSegment", async () => {
  const { calls, adapters } = makeAdapters({ existing: new Set(["本地存储"]) });
  const plan = await resolveCloudDirectory({
    segments: ["本地存储", "Downloads"], ...adapters, mode: "preview"
  });

  assert.equal(calls.create, 0);
  assert.deepEqual(plan.missingDirectories, ["/本地存储/Downloads"]);
  assert.deepEqual(plan.createdDirectories, []);
  assert.equal(plan.folder.id, null);
  assert.equal(plan.folder.pendingCreate, true);
  assert.deepEqual(directoryPlanFields(plan).willCreateDirectories, ["/本地存储/Downloads"]);
});

test("create mode only creates missing levels and reuses existing folders", async () => {
  const { calls, adapters } = makeAdapters({ existing: new Set(["本地存储"]) });
  const plan = await resolveCloudDirectory({
    segments: ["本地存储", "Downloads"], ...adapters, mode: "create"
  });

  assert.equal(calls.create, 1);
  assert.deepEqual(plan.missingDirectories, ["/本地存储/Downloads"]);
  assert.deepEqual(plan.createdDirectories, ["/本地存储/Downloads"]);
  assert.equal(plan.folder.id, "id-Downloads");
  assert.equal(plan.resolved, false);
});

test("create mode fails loudly when provider returns no folder id", async () => {
  const { adapters } = makeAdapters();
  const broken = { ...adapters, createSegment: async () => ({ name: "Downloads" }) };
  await assert.rejects(
    () => resolveCloudDirectory({ segments: ["Downloads"], ...broken, mode: "create" }),
    /创建目录失败/
  );
});

test("aliyun adapter keeps dry-run read-only and sends refuse on real creation", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes("createWithFolders")) {
      return { ok: true, text: async () => JSON.stringify({ file_id: "fid-created" }) };
    }
    return { ok: true, text: async () => JSON.stringify({ items: [] }) };
  };
  const base = { driveId: "drive-1", targetPath: "/影视库", accessToken: "token", fetchImpl, timeoutMs: 1000 };

  const preview = await resolveAliyunFolder({ ...base, mode: "preview" });
  assert.deepEqual(preview.missingDirectories, ["/影视库"]);
  assert.equal(preview.folder.file_id, null);
  assert.equal(calls.some((call) => call.url.includes("createWithFolders")), false);

  calls.length = 0;
  const created = await resolveAliyunFolder({ ...base, mode: "create" });
  assert.equal(created.folder.file_id, "fid-created");
  assert.deepEqual(created.createdDirectories, ["/影视库"]);
  const createCall = calls.find((call) => call.url.includes("createWithFolders"));
  assert.equal(createCall.body.check_name_mode, "refuse");
  assert.equal(createCall.body.name, "影视库");
});

test("aliyun adapter reuses an existing folder instead of creating it", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      text: async () => JSON.stringify({ items: [{ type: "folder", name: "影视库", file_id: "fid-existing" }] })
    };
  };
  const plan = await resolveAliyunFolder({
    driveId: "drive-1", targetPath: "/影视库", accessToken: "token",
    fetchImpl, timeoutMs: 1000, mode: "create"
  });

  assert.equal(plan.folder.file_id, "fid-existing");
  assert.deepEqual(plan.createdDirectories, []);
  assert.equal(calls.some((url) => url.includes("createWithFolders")), false);
});

test("provider CLI accepts --no-create-dir to restore the old behaviour", () => {
  const args = parseAliyunArgs(["https://www.alipan.com/s/abc", "/影视库", "--no-create-dir"]);
  assert.equal(args.noCreateDir, true);
  assert.equal(resolveDirectoryMode(args), "strict");
});
