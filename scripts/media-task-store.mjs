#!/usr/bin/env node

/**
 * 媒体任务 JSON 状态库，负责状态迁移约束、幂等、资源互斥锁和安全持久化；不直接操作 NAS 媒体文件。
 *
 * 本模块维护媒体任务状态、异常复核、自动归档决策、幂等和资源互斥锁。
 * 安全约束：状态推进必须依赖可核验的证据；冲突不能自动覆盖，凭证不得明文输出。
 */


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
  STAGED: ["ARCHIVE_PENDING", "REVIEW_REQUIRED", "CONFLICT"],
  REVIEW_REQUIRED: ["STAGED", "CONFLICT"],
  ARCHIVE_PENDING: ["ARCHIVING", "ARCHIVED", "STAGED", "CONFLICT"],
  ARCHIVING: ["ARCHIVED", "CONFLICT", "UNKNOWN"],
  CONFLICT: ["STAGED", "REVIEW_REQUIRED", "ARCHIVE_PENDING"],
  FAILED: ["DISCOVERED", "CLOUD_SAVE_PENDING", "TRANSFER_PENDING", "UNKNOWN"],
  ARCHIVED: []
};

/** 判断任务是否满足归档前置条件；必须处于 STAGED 且验证结果明确通过。 */
export function canArchive(task) {
  return Boolean(task && task.state === "STAGED" && task.conflict !== true && task.verification && task.verification.passed === true);
}

/** 对外提供归档安全性判断入口，复用 canArchive 的统一规则。 */
export function isTransferSafeToArchive(task) {
  return canArchive(task);
}

/** 判断验证通过的任务是否满足免人工逐项批准的自动归档条件。 */
export function canAutoArchive(task) {
  if (!canArchive(task) || task.conflict === true) return false;
  return task.reviewResolution?.confirmed === true ||
    (["movie", "series"].includes(task.resourceType) && task.classification?.confidence === "high");
}

/** 创建媒体任务；通过幂等键防止同一资源被重复创建，并在状态库锁内写入。 */
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
      classification: input.classification ? structuredClone(input.classification) : null,
      conflict: false,
      reviewResolution: null,
      archiveDecision: null,
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

/** 按任务 ID 读取单个任务，不改变任务状态。 */
export async function getTask(taskId, options = {}) {
  const db = await readStore(resolveStorePath(options.storePath));
  return db.tasks[String(taskId)] || null;
}

/** 读取并按创建时间排序返回任务列表，不改变任务状态。 */
export async function listTasks(options = {}) {
  const db = await readStore(resolveStorePath(options.storePath));
  const tasks = Object.values(db.tasks);
  return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 在锁保护下校验状态机并迁移任务；STAGED、ARCHIVE_PENDING、ARCHIVED 等状态必须提供对应证据。 */
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
    if (target === "REVIEW_REQUIRED" || target === "CONFLICT") {
      task.review = structuredClone(details.review || {});
      task.conflict = details.conflict === true || target === "CONFLICT";
    }
    if (target === "STAGED" && details.reviewResolution) {
      task.reviewResolution = structuredClone(details.reviewResolution);
      if (details.reviewResolution.conflictResolved === true) task.conflict = false;
      if (details.reviewResolution.resourceName) task.resourceName = String(details.reviewResolution.resourceName);
      if (details.reviewResolution.resourceType) task.resourceType = String(details.reviewResolution.resourceType);
      if (details.reviewResolution.classification) task.classification = structuredClone(details.reviewResolution.classification);
    }
    if (target === "ARCHIVE_PENDING") {
      if (details.approval) task.approval = structuredClone(details.approval);
      if (details.archiveDecision) task.archiveDecision = structuredClone(details.archiveDecision);
    }
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

/** 为资源申请独立互斥锁；锁所有权必须匹配才允许释放，损坏或不确定的锁不会自动清理。 */
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

/** 校验新任务必需字段和幂等键，拒绝不完整或无法安全追踪的任务。 */
function validateCreateInput(input) {
  if (!input || typeof input !== "object") throw new Error("创建任务需要对象参数。");
  for (const key of ["idempotencyKey", "provider", "source"]) {
    if (!String(input[key] || "").trim()) throw new Error(key + " 不能为空。");
  }
}

/** 校验目标状态是否允许，以及该状态要求的验证、审批或执行结果证据是否齐全。 */
function validateTransition(task, target, details) {
  if (target === "TRANSFERRING" && !String(details.openListTaskId || task.openListTaskId || "").trim()) {
    throw new Error("进入 TRANSFERRING 前必须记录 OpenList task ID。");
  }
  if (target === "VERIFYING" && !String(details.openListTaskId || task.openListTaskId || "").trim()) {
    throw new Error("进入 VERIFYING 前必须关联 OpenList task ID。");
  }
  if (target === "STAGED") {
    const evidence = details.verification;
    if (!evidence || evidence.passed !== true || evidence.transferCompleted !== true ||
        String(evidence.openListTaskId || "") !== String(task.openListTaskId || "") ||
        Number(evidence.stableChecks) < 2) {
      throw new Error("必须确认关联的 OpenList 任务已成功完成，并通过至少两次稳定性检查，才能进入 STAGED。");
    }
    if (task.state !== "VERIFYING" && task.state !== "REVIEW_REQUIRED" && task.state !== "CONFLICT") {
      throw new Error("只能从 VERIFYING 或已解决的复核/冲突状态进入 STAGED。");
    }
    if (task.state !== "VERIFYING") {
      const resolution = details.reviewResolution;
      if (!resolution || resolution.confirmed !== true ||
          !String(resolution.resourceName || "").trim() ||
          !["movie", "series"].includes(String(resolution.resourceType || "")) ||
          ((task.conflict === true || task.state === "CONFLICT") && resolution.conflictResolved !== true)) {
        throw new Error("人工复核后必须确认标准片名和电影/剧集类型，才能重新进入 STAGED。");
      }
    }
  }
  if (target === "REVIEW_REQUIRED") {
    if (!canArchive(task)) throw new Error("只有转存验证通过的任务才能进入媒体识别复核。");
  }
  if (target === "ARCHIVE_PENDING") {
    if (!canArchive(task)) throw new Error("任务未通过验证，不允许进入归档待执行状态。");
    const decision = details.archiveDecision;
    const automatic = decision?.mode === "automatic" &&
      ["movie", "series"].includes(task.resourceType) &&
      task.classification?.confidence === "high" &&
      decision.conflict === false &&
      task.conflict !== true;
    const userConfirmed = decision?.mode === "user-confirmed" &&
      task.reviewResolution?.confirmed === true &&
      task.conflict !== true;
    const legacyApproval = details.approval?.confirmed === true &&
      String(details.approval.approvedBy || "").trim() &&
      String(details.approval.approvedAt || "").trim();
    if (!automatic && !userConfirmed && !legacyApproval) {
      throw new Error("自动归档必须有高置信度且无冲突证据；模糊资源需先确认识别结果。");
    }
  }
  if (target === "ARCHIVED" && (!details.archiveResult || details.archiveResult.success !== true)) {
    throw new Error("只有归档执行结果明确成功，才能标记 ARCHIVED。");
  }
}

/** 从任务输入中筛选可安全持久化的证据字段，避免把不必要的敏感数据写入状态库。 */
function safeEvidence(details) {
  const result = {};
  for (const key of ["openListTaskId", "verification", "approval", "archiveDecision", "reviewResolution", "review", "conflict", "archiveResult"]) {
    if (details[key] !== undefined) result[key] = details[key];
  }
  return result;
}

/** 解析任务状态文件路径，并应用调用参数或环境变量提供的配置。 */
function resolveStorePath(value) {
  return path.resolve(value || process.env.MEDIA_TASK_STORE_PATH || DEFAULT_STORE);
}

/** 在文件锁保护下执行状态库读写，避免并发更新相互覆盖。 */
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

/** 读取并解析 JSON 状态库；文件不存在时按空状态库处理。 */
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

/** 将更新后的状态库持久化；该函数只写本地状态文件，不触碰 NAS 媒体文件。 */
async function writeStore(storePath, db) {
  const tempPath = storePath + "." + randomUUID() + ".tmp";
  await fs.writeFile(tempPath, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(tempPath, storePath);
}
