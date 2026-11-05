#!/usr/bin/env node

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

async function runOpenListReconcile({ env = {}, args = {}, fetchImpl = globalThis.fetch, store = { getTask, transitionTask } }) {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("缺少媒体任务 ID。");
  const task = await store.getTask(id, { storePath: args.storePath || env.MEDIA_TASK_STORE_PATH });
  if (!task) throw new Error("媒体任务不存在：" + id);
  if (task.state !== "TRANSFERRING") {
    return { ok: true, changed: false, mediaTaskId: task.id, mediaTaskState: task.state, reason: "task_not_in_transferring_state" };
  }
  if (!task.openListTaskId) throw new Error("媒体任务没有关联 OpenList task ID，拒绝核验。");
  const status = await lookupOpenListTaskById({
    baseUrl: args.baseUrl || env.OPENLIST_BASE_URL,
    token: args.token || env.OPENLIST_TOKEN,
    fetchImpl,
    timeoutMs: args.timeoutMs,
    group: args.group || "copy",
    id: task.openListTaskId
  });
  let updated = task;
  if (status.status === "SUCCEEDED") {
    updated = await store.transitionTask(task.id, "VERIFYING", { actor: "openlist-reconcile", note: "OpenList task completion confirmed by exact task ID." }, { storePath: args.storePath || env.MEDIA_TASK_STORE_PATH });
  } else if (status.status === "FAILED") {
    updated = await store.transitionTask(task.id, "FAILED", { actor: "openlist-reconcile", note: "OpenList task reported failure: " + String(status.reason || "unknown") }, { storePath: args.storePath || env.MEDIA_TASK_STORE_PATH });
  } else if (status.status === "UNKNOWN") {
    updated = await store.transitionTask(task.id, "UNKNOWN", { actor: "openlist-reconcile", note: "OpenList task status could not be proven: " + String(status.reason || "unknown") }, { storePath: args.storePath || env.MEDIA_TASK_STORE_PATH });
  }
  return { ok: true, changed: updated.state !== task.state, mediaTaskId: task.id, mediaTaskState: updated.state, openList: status };
}

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

function loadEnv(file) {
  const fileEnv = file && fs.existsSync(file) ? parseDotEnv(fs.readFileSync(file, "utf8")) : {};
  return { ...fileEnv, ...process.env };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOpenListReconcile({ env: loadEnv(args.envFile), args });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

export { parseArgs, runOpenListReconcile };
