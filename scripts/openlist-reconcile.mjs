#!/usr/bin/env node

/**
 * 使用媒体任务记录的精确 OpenList task ID 对账，并把远端可确认结果同步到内部任务状态。
 *
 * 本文件说明：函数注释解释各步骤职责及重要约束；本次修改仅增加注释，不改变业务执行逻辑。
 * 安全约束：状态推进必须依赖可核验的证据；配置和连通性检查保持只读，凭证不得明文输出。
 */

/**
 * 使用媒体任务中记录的 OpenList task ID 精确查询后台任务，并将可确认的结果同步回内部任务状态。
 *
 * 维护说明：本文件以显式参数和返回值组织流程；请勿在注释之外改变既有行为。
 * 安全边界：涉及网盘/NAS 写入的函数必须在调用前确认目标、范围和用户授权；只读函数不得引入隐式写操作。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./check-env.mjs";
import { lookupOpenListTaskById } from "./openlist-tasks.mjs";
import { getTask, transitionTask } from "./media-task-store.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

/** 读取内部媒体任务并按其记录的 OpenList task ID 对账；只有任务处于 TRANSFERRING 才查询远端状态。 */
/** 只对处于 TRANSFERRING 的内部任务按精确远端任务 ID 对账，并按确认结果迁移状态。 */
async function runOpenListReconcile({ env = {}, args = {}, fetchImpl = globalThis.fetch, store = { getTask, transitionTask } }) {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("缺少媒体任务 ID。");
  const task = await store.getTask(id, { storePath: args.storePath || env.MEDIA_TASK_STORE_PATH });
  if (!task) throw new Error("媒体任务不存在：" + id);
  // 仅对正在转存的任务做远端核验，其他状态不重复查询或擅自推进。
  if (task.state !== "TRANSFERRING") {
    return { ok: true, changed: false, mediaTaskId: task.id, mediaTaskState: task.state, reason: "task_not_in_transferring_state" };
  }
  if (!task.openListTaskId) throw new Error("媒体任务没有关联 OpenList task ID，拒绝核验。");
  // 必须使用任务记录中的精确 ID 对账，不能用文件名猜测任务是否完成。
  const status = await lookupOpenListTaskById({
    baseUrl: args.baseUrl || env.OPENLIST_BASE_URL,
    token: args.token || env.OPENLIST_TOKEN,
    fetchImpl,
    timeoutMs: args.timeoutMs,
    group: args.group || "copy",
    id: task.openListTaskId
  });
  let updated = task;
  // 只有远端明确报告成功才进入 VERIFYING；成功不等于已经满足归档条件。
  if (status.status === "SUCCEEDED") {
    updated = await store.transitionTask(task.id, "VERIFYING", { actor: "openlist-reconcile", note: "OpenList task completion confirmed by exact task ID." }, { storePath: args.storePath || env.MEDIA_TASK_STORE_PATH });
  } else if (status.status === "FAILED") {
    updated = await store.transitionTask(task.id, "FAILED", { actor: "openlist-reconcile", note: "OpenList task reported failure: " + String(status.reason || "unknown") }, { storePath: args.storePath || env.MEDIA_TASK_STORE_PATH });
  } else if (status.status === "UNKNOWN") {
    updated = await store.transitionTask(task.id, "UNKNOWN", { actor: "openlist-reconcile", note: "OpenList task status could not be proven: " + String(status.reason || "unknown") }, { storePath: args.storePath || env.MEDIA_TASK_STORE_PATH });
  }
  return { ok: true, changed: updated.state !== task.state, mediaTaskId: task.id, mediaTaskState: updated.state, openList: status };
}

/** 解析命令行参数并生成统一参数对象；遇到未知参数时应报错，避免参数拼写错误被静默忽略。 */
/** 解析命令行参数并生成统一参数对象；未知参数会明确报错。 */
function parseArgs(argv) {
  const args = { id: "", envFile: ".env", group: "copy", timeoutMs: 20000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--id") args.id = argv[++i] || "";
    else if (arg === "--env-file") args.envFile = argv[++i] || ".env";
    else if (arg === "--group") args.group = argv[++i] || "copy";
    else if (arg === "--base-url") args.baseUrl = argv[++i] || "";
    else if (arg === "--token") args.token = argv[++i] || "";
    else if (arg === "--store") args.storePath = argv[++i] || "";
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i] || 20000);
    else if (arg.startsWith("--")) throw new Error("未知参数：" + arg);
    else if (!args.id) args.id = arg;
    else throw new Error("多余的位置参数：" + arg);
  }
  return args;
}

/** 读取指定 .env 文件并与当前进程环境变量合并；调用方环境变量优先，避免覆盖部署环境注入值。 */
/** 读取 .env 并与进程环境变量合并；进程环境变量优先。 */
function loadEnv(file) {
  const fileEnv = file && fs.existsSync(file) ? parseDotEnv(fs.readFileSync(file, "utf8")) : {};
  return { ...fileEnv, ...process.env };
}

/** 命令行主入口：解析参数、准备配置、调用本模块核心流程并输出结果。 */
/** 命令行主入口：解析参数、读取配置、调用检查或状态管理流程并输出结果。 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOpenListReconcile({ env: loadEnv(args.envFile), args });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

export { parseArgs, runOpenListReconcile };
