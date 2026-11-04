import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  acquireResourceLock,
  canArchive,
  createTask,
  getTask,
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
    resourceType: "series"
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

test("enforces transfer and verification gates before STAGED", async () => {
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
    verification: { passed: true, stableChecks: 1 }
  }, options), /至少两次/);
  const staged = await transitionTask(task.id, "STAGED", {
    verification: { passed: true, stableChecks: 2, size: 1024, hash: null }
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
    verification: { passed: true, stableChecks: 2 }
  }, options);
  await assert.rejects(() => transitionTask(task.id, "ARCHIVE_PENDING", {}, options), /明确确认/);
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
