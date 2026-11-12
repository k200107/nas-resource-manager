import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  acquireResourceLock,
  canArchive,
  canAutoArchive,
  createTask,
  getTask,
  getArchivedOpenListTaskIds,
  recordArchiveOperation,
  listTasks,
  transitionTask
} from "../scripts/media-task-store.mjs";

async function tempOptions() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nas-media-state-"));
  return { storePath: path.join(root, "state", "tasks.json"), lockDir: path.join(root, "locks"), root };
}

async function createSample(options) {
  return createTask({
    idempotencyKey: "quark:share-123:item-456",
    provider: "quark",
    source: "/Downloads/Example",
    resourceName: "Example",
    resourceType: "series",
    classification: { confidence: "high" }
  }, options);
}

test("creates a task and returns the same task for an idempotent retry", async () => {
  const options = await tempOptions();
  const first = await createSample(options);
  const second = await createSample(options);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.task.id, second.task.id);
  assert.equal((await listTasks(options)).length, 1);
});

test("rejects reusing an idempotency key for another source", async () => {
  const options = await tempOptions();
  await createSample(options);
  await assert.rejects(() => createTask({
    idempotencyKey: "quark:share-123:item-456",
    provider: "quark",
    source: "/Downloads/Other"
  }, options), /Idempotency key/);
});

test("enforces OpenList task completion before STAGED without file stability checks", async () => {
  const options = await tempOptions();
  const { task } = await createSample(options);
  await transitionTask(task.id, "CLOUD_SAVE_PENDING", {}, options);
  await transitionTask(task.id, "CLOUD_SAVED", {}, options);
  await transitionTask(task.id, "TRANSFER_PENDING", {}, options);
  await assert.rejects(() => transitionTask(task.id, "TRANSFERRING", {}, options), /task ID/);
  await transitionTask(task.id, "TRANSFERRING", { openListTaskId: "openlist-77" }, options);
  const verifying = await transitionTask(task.id, "VERIFYING", {}, options);
  assert.equal(verifying.state, "VERIFYING");
  await assert.rejects(() => transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: false, openListTaskId: "openlist-77", stableChecks: 2 }
  }, options), /OpenList 复制任务已明确成功/);
  const staged = await transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: true, openListTaskId: "openlist-77" }
  }, options);
  assert.equal(canArchive(staged), true);
});

test("requires explicit approval and successful archive result", async () => {
  const options = await tempOptions();
  const { task } = await createSample(options);
  await transitionTask(task.id, "CLOUD_SAVE_PENDING", {}, options);
  await transitionTask(task.id, "CLOUD_SAVED", {}, options);
  await transitionTask(task.id, "TRANSFER_PENDING", {}, options);
  await transitionTask(task.id, "TRANSFERRING", { openListTaskId: "task-1" }, options);
  await transitionTask(task.id, "VERIFYING", {}, options);
  await transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: true, openListTaskId: "task-1", stableChecks: 2 }
  }, options);
  await assert.rejects(() => transitionTask(task.id, "ARCHIVE_PENDING", {}, options), /高置信度且无冲突证据/);
  await transitionTask(task.id, "ARCHIVE_PENDING", {
    approval: { confirmed: true, approvedBy: "user", approvedAt: "2026-11-04T00:00:00Z" }
  }, options);
  await assert.rejects(() => transitionTask(task.id, "ARCHIVED", { archiveResult: { success: false } }, options), /明确成功/);
  const archived = await transitionTask(task.id, "ARCHIVED", { archiveResult: { success: true } }, options);
  assert.equal(archived.state, "ARCHIVED");
  await assert.rejects(() => transitionTask(task.id, "STAGED", {}, options), /已归档/);
});

test("refuses concurrent resource processing and releases only its own lock", async () => {
  const options = await tempOptions();
  const lock = await acquireResourceLock("same-resource", options);
  await assert.rejects(() => acquireResourceLock("same-resource", options), /锁冲突/);
  assert.equal(await lock.release(), true);
  const second = await acquireResourceLock("same-resource", options);
  assert.equal(await second.release(), true);
});

test("does not treat active, paused, unknown, failed, or unverified tasks as archivable", async () => {
  for (const state of ["TRANSFERRING", "PAUSED", "UNKNOWN", "FAILED", "VERIFYING", "STAGED"]) {
    assert.equal(canArchive({ state, verification: { passed: false } }), false);
  }
  assert.equal(await getTask("missing", await tempOptions()), null);
});


test("automatically advances a high-confidence verified task without per-file approval", async () => {
  const options = await tempOptions();
  const { task } = await createSample(options);
  await transitionTask(task.id, "CLOUD_SAVE_PENDING", {}, options);
  await transitionTask(task.id, "CLOUD_SAVED", {}, options);
  await transitionTask(task.id, "TRANSFER_PENDING", {}, options);
  await transitionTask(task.id, "TRANSFERRING", { openListTaskId: "auto-task" }, options);
  await transitionTask(task.id, "VERIFYING", {}, options);
  const staged = await transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: true, openListTaskId: "auto-task", stableChecks: 2 }
  }, options);
  assert.equal(canAutoArchive(staged), true);
  const pending = await transitionTask(task.id, "ARCHIVE_PENDING", {
    archiveDecision: { mode: "automatic", conflict: false }
  }, options);
  assert.equal(pending.state, "ARCHIVE_PENDING");
  const archiving = await transitionTask(task.id, "ARCHIVING", {}, options);
  assert.equal(archiving.state, "ARCHIVING");
  const archived = await transitionTask(task.id, "ARCHIVED", { archiveResult: { success: true } }, options);
  assert.equal(archived.state, "ARCHIVED");
});

test("ambiguous media requires one identity confirmation, not repeated archive approval", async () => {
  const options = await tempOptions();
  const { task } = await createTask({
    idempotencyKey: "quark:ambiguous:1", provider: "quark", source: "/Downloads/Alias",
    resourceName: "肖生客的救赎", resourceType: "unknown", classification: { confidence: "medium" }
  }, options);
  await transitionTask(task.id, "CLOUD_SAVE_PENDING", {}, options);
  await transitionTask(task.id, "CLOUD_SAVED", {}, options);
  await transitionTask(task.id, "TRANSFER_PENDING", {}, options);
  await transitionTask(task.id, "TRANSFERRING", { openListTaskId: "review-task" }, options);
  await transitionTask(task.id, "VERIFYING", {}, options);
  await transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: true, openListTaskId: "review-task", stableChecks: 2 }
  }, options);
  await transitionTask(task.id, "REVIEW_REQUIRED", { review: { reason: "片名疑似谐音" } }, options);
  const resolved = await transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: true, openListTaskId: "review-task", stableChecks: 2 },
    reviewResolution: { confirmed: true, resourceName: "肖申克的救赎", resourceType: "movie" }
  }, options);
  assert.equal(resolved.reviewResolution.confirmed, true);
  assert.equal(canAutoArchive(resolved), true);
  const pending = await transitionTask(task.id, "ARCHIVE_PENDING", {
    archiveDecision: { mode: "user-confirmed", conflict: false }
  }, options);
  assert.equal(pending.state, "ARCHIVE_PENDING");
});

test("a destination conflict cannot be automatically archived until explicitly resolved", async () => {
  const options = await tempOptions();
  const { task } = await createSample(options);
  await transitionTask(task.id, "CLOUD_SAVE_PENDING", {}, options);
  await transitionTask(task.id, "CLOUD_SAVED", {}, options);
  await transitionTask(task.id, "TRANSFER_PENDING", {}, options);
  await transitionTask(task.id, "TRANSFERRING", { openListTaskId: "conflict-task" }, options);
  await transitionTask(task.id, "VERIFYING", {}, options);
  await transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: true, openListTaskId: "conflict-task", stableChecks: 2 }
  }, options);
  const conflicted = await transitionTask(task.id, "CONFLICT", { conflict: true }, options);
  assert.equal(canAutoArchive(conflicted), false);
  await assert.rejects(() => transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: true, openListTaskId: "conflict-task", stableChecks: 2 },
    reviewResolution: { confirmed: true, resourceName: "Example", resourceType: "movie" }
  }, options), /人工复核后必须确认/);
  const resolved = await transitionTask(task.id, "STAGED", {
    verification: { passed: true, transferCompleted: true, openListTaskId: "conflict-task", stableChecks: 2 },
    reviewResolution: { confirmed: true, resourceName: "Example", resourceType: "movie", conflictResolved: true }
  }, options);
  assert.equal(resolved.conflict, false);
});


test("archive ledger links OpenList task IDs and merges later associations", async () => {
  const options = await tempOptions();
  await recordArchiveOperation({
    source: "/Downloads/Film.mkv", target: "/Movies/Film/Film.mkv",
    resourceGroupId: "/Downloads/Film", verified: true
  }, options);
  assert.deepEqual([...await getArchivedOpenListTaskIds(options)], []);
  await recordArchiveOperation({
    source: "/Downloads/Film.mkv", target: "/Movies/Film/Film.mkv",
    openListTaskId: "copy-task-1", verified: true
  }, options);
  await recordArchiveOperation({
    source: "/Downloads/Film.mkv", target: "/Movies/Film/Film.mkv",
    openListTaskId: "copy-task-2", verified: true
  }, options);
  assert.deepEqual([...(await getArchivedOpenListTaskIds(options))].sort(), ["copy-task-1", "copy-task-2"]);
});
