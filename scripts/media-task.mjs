#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "./check-env.mjs";
import { createTask, getTask, listTasks, transitionTask } from "./media-task-store.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = args.envFile || ".env";
  const env = envFile && fs.existsSync(envFile) ? parseDotEnv(fs.readFileSync(envFile, "utf8")) : {};
  const options = {
    storePath: args.storePath || env.MEDIA_TASK_STORE_PATH || process.env.MEDIA_TASK_STORE_PATH,
    lockDir: args.lockDir || env.MEDIA_TASK_LOCK_DIR || process.env.MEDIA_TASK_LOCK_DIR
  };
  let result;
  if (args.action === "create") {
    result = await createTask({
      idempotencyKey: args.key,
      provider: args.provider,
      source: args.source,
      resourceName: args.name,
      resourceType: args.type,
      actor: args.actor
    }, options);
  } else if (args.action === "get") {
    result = { task: await getTask(args.id, options) };
  } else if (args.action === "list") {
    result = { tasks: await listTasks(options) };
  } else if (args.action === "transition") {
    const details = { actor: args.actor, note: args.note, openListTaskId: args.openListTaskId };
    if (args.to === "STAGED") details.verification = {
      passed: args.verified, stableChecks: args.stableChecks, size: args.size, hash: args.hash || null
    };
    if (args.to === "ARCHIVE_PENDING") details.approval = {
      confirmed: args.confirmed, approvedBy: args.approvedBy, approvedAt: args.approvedAt
    };
    if (args.to === "ARCHIVED") details.archiveResult = { success: args.archiveSuccess };
    result = { task: await transitionTask(args.id, args.to, details, options) };
  } else {
    throw new Error("action 只支持 create、get、list、transition。");
  }
  console.log(JSON.stringify({ ok: true, tool: "media-task", action: args.action, ...result }, null, 2));
}

function parseArgs(argv) {
  const args = { action: "list", storePath: "", lockDir: "", envFile: ".env" };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2);
    if (["verified", "confirmed", "archive-success"].includes(key)) {
      args[key === "archive-success" ? "archiveSuccess" : key] = true;
      continue;
    }
    const next = argv[++i];
    const map = {
      "store": "storePath", "lock-dir": "lockDir", "env-file": "envFile",
      "key": "key", "provider": "provider", "source": "source", "name": "name",
      "type": "type", "actor": "actor", "id": "id", "to": "to", "note": "note",
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
