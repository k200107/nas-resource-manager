#!/usr/bin/env node

/**
 * 媒体任务状态管理 CLI，解析命令行参数并调用状态库创建、查询、列出或迁移任务。
 *
 * 本 CLI 负责把媒体任务创建、状态迁移、识别复核和归档决策传递给状态库。
 * 安全约束：CLI 不绕过状态机；自动归档决策必须满足高置信度和无冲突条件。
 */

/**
 * 媒体任务状态管理 CLI，将命令行参数转换为任务创建、查询、列表和状态转换请求。
 *
 * 维护说明：状态证据由 media-task-store 统一校验，CLI 不直接操作 NAS 文件。
 * 安全边界：人工确认针对不确定的媒体身份或冲突，不要求对每个明确文件重复审批。
 */

import { loadEnvFile } from "./env-config.mjs";
import { isCliEntryPoint } from "./cli-utils.mjs";
import { createTask, getTask, listTasks, transitionTask } from "./media-task-store.mjs";

if (isCliEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
/** CLI 入口：组装任务字段并交由状态库验证；不在 CLI 层绕过状态机规则。 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = args.envFile || ".env";
  const env = loadEnvFile(envFile).values;
  const options = {
    storePath: args.storePath || env.MEDIA_TASK_STORE_PATH || process.env.MEDIA_TASK_STORE_PATH,
    lockDir: args.lockDir || env.MEDIA_TASK_LOCK_DIR || process.env.MEDIA_TASK_LOCK_DIR
  };
  let result;
  // CLI 只负责把参数交给状态库；状态合法性和证据校验由 media-task-store 统一执行。
  if (args.action === "create") {
    result = await createTask({
      idempotencyKey: args.key,
      provider: args.provider,
      source: args.source,
      resourceName: args.name,
      resourceType: args.type,
      classification: args.confidence ? { confidence: args.confidence } : null,
      actor: args.actor
    }, options);
  } else if (args.action === "get") {
    result = { task: await getTask(args.id, options) };
  } else if (args.action === "list") {
    result = { tasks: await listTasks(options) };
  } else // 状态迁移所需的验证/审批证据在此组装，最终是否允许迁移仍由状态库判定。
  if (args.action === "transition") {
    const details = { actor: args.actor, note: args.note, openListTaskId: args.openListTaskId, conflict: args.conflict === true };
    if (args.to === "REVIEW_REQUIRED") details.review = { reason: args.note || "需要人工确认媒体身份或目标冲突" };
    if (args.to === "STAGED" && args.reviewConfirmed) details.reviewResolution = {
      confirmed: true, resourceName: args.name, resourceType: args.type,
      conflictResolved: args.conflictResolved === true,
      classification: args.confidence ? { confidence: args.confidence } : undefined
    };
    if (args.to === "ARCHIVE_PENDING" && args.archiveMode) details.archiveDecision = {
      mode: args.archiveMode, conflict: args.conflict === true
    };
    // STAGED 必须携带转存完成、任务 ID 一致和稳定性检查证据。
  if (args.to === "STAGED") details.verification = {
      passed: args.verified, transferCompleted: args.transferCompleted,
      openListTaskId: args.openListTaskId, stableChecks: args.stableChecks, size: args.size, hash: args.hash || null
    };
    // 兼容旧的逐项审批记录；新流程可通过 archive-mode 传递自动决策或已确认的识别结果。
  if (args.to === "ARCHIVE_PENDING" && args.confirmed) details.approval = {
      confirmed: args.confirmed, approvedBy: args.approvedBy, approvedAt: args.approvedAt
    };
    // 只有归档执行结果明确成功，状态库才允许标记为 ARCHIVED。
  if (args.to === "ARCHIVED") details.archiveResult = { success: args.archiveSuccess };
    result = { task: await transitionTask(args.id, args.to, details, options) };
  } else {
    throw new Error("action 只支持 create、get、list、transition。");
  }
  console.log(JSON.stringify({ ok: true, tool: "media-task", action: args.action, ...result }, null, 2));
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；遇到未知参数时明确报错。 */
function parseArgs(argv) {
  const args = { action: "list", storePath: "", lockDir: "", envFile: ".env" };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2);
    if (["verified", "confirmed", "archive-success", "transfer-completed", "review-confirmed", "conflict", "conflict-resolved"].includes(key)) {
      const boolKey = ({ "archive-success": "archiveSuccess", "transfer-completed": "transferCompleted", "review-confirmed": "reviewConfirmed", "conflict-resolved": "conflictResolved" })[key] || key;
      args[boolKey] = true;
      continue;
    }
    const next = argv[++i];
    const map = {
      "store": "storePath", "lock-dir": "lockDir", "env-file": "envFile",
      "key": "key", "provider": "provider", "source": "source", "name": "name",
      "type": "type", "actor": "actor", "id": "id", "to": "to", "note": "note",
      "confidence": "confidence", "archive-mode": "archiveMode",
      "openlist-task-id": "openListTaskId", "stable-checks": "stableChecks",
      "size": "size", "hash": "hash", "approved-by": "approvedBy", "approved-at": "approvedAt"
    };
    if (!map[key]) throw new Error("未知参数：--" + key);
    args[map[key]] = ["stableChecks", "size"].includes(map[key]) ? Number(next) : next || "";
  }
  if (positionals[0]) args.action = positionals[0];
  if (positionals[1]) args.id = positionals[1];
  return args;
}
