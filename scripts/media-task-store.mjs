#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const DEFAULT_STORE = ".state/media-tasks.json";
const DEFAULT_LOCK_DIR = ".state/locks";
const TERMINAL_STATES = new Set(["ARCHIVED"]);
const ALLOWED = {
  DISCOVERED: ["CLOUD_SAVE_PENDING", "FAILED", "PAUSED", "UNKNOWN"],
  CLOUD_SAVE_PENDING: ["CLOUD_SAVED", "FAILED", "PAUSED", "UNKNOWN"],
  CLOUD_SAVED: ["TRANSFER_PENDING", "FAILED", "UNKNOWN"],
  TRANSFER_PENDING: ["TRANSFERRING", "PAUSED", "FAILED", "UNKNOWN"],
  TRANSFERRING: ["VERIFYING", "PAUSED", "FAILED", "UNKNOWN"],
  PAUSED: ["TRANSFER_PENDING", "TRANSFERRING", "VERIFYING", "FAILED", "UNKNOWN"],
  UNKNOWN: ["DISCOVERED", "CLOUD_SAVE_PENDING", "CLOUD_SAVED", "TRANSFER_PENDING", "TRANSFERRING", "VERIFYING", "PAUSED", "FAILED", "CONFLICT"],
  VERIFYING: ["STAGED", "FAILED", "UNKNOWN", "CONFLICT"],
  STAGED: ["ARCHIVE_PENDING", "CONFLICT"],
  ARCHIVE_PENDING: ["ARCHIVED", "STAGED", "CONFLICT"],
  CONFLICT: ["STAGED", "ARCHIVE_PENDING"],
  FAILED: ["DISCOVERED", "CLOUD_SAVE_PENDING", "TRANSFER_PENDING", "UNKNOWN"],
  ARCHIVED: []
};

export function canArchive(task) {
  return Boolean(task && task.state === "STAGED" && task.verification && task.verification.passed === true);
}

export function isTransferSafeToArchive(task) {
  return canArchive(task);
}

export async function createTask(input, options = {}) {
  validateCreateInput(input);
  const storePath = resolveStorePath(options.storePath);
  return withStoreLock(storePath, async () => {
    const db = await readStore(storePath);
    const existing = Object.values(db.tasks).find((task) => task.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.source !== input.source || existing.provider !== input.provider) {
        throw new Error("Idempotency key 已被其他资源使用，拒绝复用。");
      }
      return { task: existing, created: false };
    }
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      provider: input.provider,
      source: input.source,
      resourceName: String(input.resourceName || ""),
      resourceType: String(input.resourceType || "unknown"),
      state: "DISCOVERED",
      openListTaskId: null,
      verification: null,
      approval: null,
      archiveResult: null,
      createdAt: now,
      updatedAt: now,
      history: [{ state: "DISCOVERED", at: now, actor: String(input.actor || "system"), note: "task created" }]
    };
    db.tasks[task.id] = task;
    await writeStore(storePath, db);
    return { task, created: true };
  });
}

export async function getTask(taskId, options = {}) {
  const db = await readStore(resolveStorePath(options.storePath));
  return db.tasks[String(taskId)] || null;
}

export async function listTasks(options = {}) {
  const db = await readStore(resolveStorePath(options.storePath));
  const tasks = Object.values(db.tasks);
  return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function transitionTask(taskId, nextState, details = {}, options = {}) {
  const target = String(nextState || "").toUpperCase();
  if (!Object.hasOwn(ALLOWED, target)) throw new Error("未知任务状态：" + target);
  const storePath = resolveStorePath(options.storePath);
  return withStoreLock(storePath, async () => {
    const db = await readStore(storePath);
    const task = db.tasks[String(taskId)];
    if (!task) throw new Error("任务不存在：" + taskId);
    if (TERMINAL_STATES.has(task.state)) throw new Error("已归档任务不可再次变更。");
    if (!ALLOWED[task.state].includes(target)) {
      throw new Error("不允许的状态转换：" + task.state + " -> " + target);
    }
    validateTransition(task, target, details);
    const now = new Date().toISOString();
    task.state = target;
    task.updatedAt = now;
    if (details.openListTaskId) task.openListTaskId = String(details.openListTaskId);
    if (target === "STAGED") task.verification = structuredClone(details.verification);
    if (target === "ARCHIVE_PENDING") task.approval = structuredClone(details.approval);
    if (target === "ARCHIVED") task.archiveResult = structuredClone(details.archiveResult);
    task.history.push({
      state: target,
      at: now,
      actor: String(details.actor || "system"),
      note: String(details.note || ""),
      evidence: safeEvidence(details)
    });
    await writeStore(storePath, db);
    return task;
  });
}

export async function acquireResourceLock(resourceKey, options = {}) {
  if (!String(resourceKey || "").trim()) throw new Error("resourceKey 不能为空。");
  const lockDir = path.resolve(options.lockDir || process.env.MEDIA_TASK_LOCK_DIR || DEFAULT_LOCK_DIR);
  await fs.mkdir(lockDir, { recursive: true });
  const key = createHash("sha256").update(String(resourceKey)).digest("hex");
  const lockPath = path.join(lockDir, "resource-" + key + ".lock");
  const token = randomUUID();
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("资源正在由另一个 Agent 处理，锁冲突：" + key.slice(0, 12));
    throw error;
  }
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
    token,
    resourceKeyHash: key,
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  }, null, 2), { flag: "wx" });
  let released = false;
  return {
    key,
    async release() {
      if (released) return false;
      const ownerPath = path.join(lockPath, "owner.json");
      let owner;
      try { owner = JSON.parse(await fs.readFile(ownerPath, "utf8")); }
      catch { throw new Error("锁所有者信息缺失或损坏；为避免误释放，不自动清理。"); }
      if (owner.token !== token) throw new Error("锁所有权不匹配，拒绝释放。");
      await fs.rm(lockPath, { recursive: true, force: false });
      released = true;
      return true;
    }
  };
}

function validateCreateInput(input) {
  if (!input || typeof input !== "object") throw new Error("创建任务需要对象参数。");
  for (const key of ["idempotencyKey", "provider", "source"]) {
    if (!String(input[key] || "").trim()) throw new Error(key + " 不能为空。");
  }
}

function validateTransition(task, target, details) {
  if (target === "TRANSFERRING" && !String(details.openListTaskId || task.openListTaskId || "").trim()) {
    throw new Error("进入 TRANSFERRING 前必须记录 OpenList task ID。");
  }
  if (target === "VERIFYING" && !String(details.openListTaskId || task.openListTaskId || "").trim()) {
    throw new Error("进入 VERIFYING 前必须关联 OpenList task ID。");
  }
  if (target === "STAGED") {
    const evidence = details.verification;
    if (!evidence || evidence.passed !== true || Number(evidence.stableChecks) < 2) {
      throw new Error("只有验证通过且至少两次稳定性检查一致，才能进入 STAGED。");
    }
    if (task.state !== "VERIFYING") throw new Error("只能从 VERIFYING 进入 STAGED。");
  }
  if (target === "ARCHIVE_PENDING") {
    if (!canArchive(task)) throw new Error("任务未通过验证，不允许进入归档待确认状态。");
    const approval = details.approval;
    if (!approval || approval.confirmed !== true || !String(approval.approvedBy || "").trim() || !String(approval.approvedAt || "").trim()) {
      throw new Error("归档前必须记录用户明确确认、确认人和确认时间。");
    }
  }
  if (target === "ARCHIVED" && (!details.archiveResult || details.archiveResult.success !== true)) {
    throw new Error("只有归档执行结果明确成功，才能标记 ARCHIVED。");
  }
}

function safeEvidence(details) {
  const result = {};
  for (const key of ["openListTaskId", "verification", "approval", "archiveResult"]) {
    if (details[key] !== undefined) result[key] = details[key];
  }
  return result;
}

function resolveStorePath(value) {
  return path.resolve(value || process.env.MEDIA_TASK_STORE_PATH || DEFAULT_STORE);
}

async function withStoreLock(storePath, operation) {
  const lockPath = storePath + ".lock";
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  let acquired = false;
  const deadline = Date.now() + 10_000;
  while (!acquired) {
    try {
      await fs.mkdir(lockPath);
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("任务状态库锁等待超时；未自动清理锁，请先确认没有其他进程正在写入。");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function readStore(storePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
    if (parsed.version !== SCHEMA_VERSION || !parsed.tasks || typeof parsed.tasks !== "object") {
      throw new Error("任务状态库版本或结构不兼容，拒绝覆盖。");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return { version: SCHEMA_VERSION, tasks: {} };
    throw error;
  }
}

async function writeStore(storePath, db) {
  const tempPath = storePath + "." + randomUUID() + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(tempPath, storePath);
}
