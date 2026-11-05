# Shared media task state

## Purpose

OpenClaw and Hermes must use one shared task store and one resource-lock directory. The store is application metadata, not a media directory and not an OpenList path. Configure both agents to the same persistent host/container-mounted paths.

- MEDIA_TASK_STORE_PATH: JSON task database, default .state/media-tasks.json.
- MEDIA_TASK_LOCK_DIR: resource lock directory, default .state/locks.

Do not place either path inside /vol1/1000/media, Downloads, Movies, or TVShows. Back up the state store with the application configuration. Never commit the state file or lock contents.

## State progression

DISCOVERED -> CLOUD_SAVE_PENDING -> CLOUD_SAVED -> TRANSFER_PENDING -> TRANSFERRING -> VERIFYING -> STAGED -> ARCHIVE_PENDING -> ARCHIVED

Exceptional states: FAILED, PAUSED, UNKNOWN, CONFLICT.

The module rejects unsupported transitions. An OpenList task ID is required before entering TRANSFERRING or VERIFYING. STAGED requires verification.passed=true, transferCompleted=true from the OpenList reconciliation adapter, the same OpenList task ID already attached to the task, and at least two stable checks. This prevents a merely stable partial download from being marked ready. A hash may be recorded when the source exposes a reliable hash; absence of a hash does not turn size stability into cryptographic proof.

ARCHIVE_PENDING requires an explicit approval record with confirmed=true, approvedBy, and approvedAt. ARCHIVED requires an explicit successful archive result. The state module itself does not call OpenList and does not move files.

## Idempotency and locking

Every task must have a stable idempotency key derived from provider and resource identity. Repeating the same key for the same provider/source returns the existing task. Reusing it for a different source is rejected.

Before processing a resource, agents should acquire acquireResourceLock(resourceKey) and release it in a finally block. The lock uses atomic directory creation; a second process receives a conflict. Locks are not silently broken based on age because an apparently old lock may still protect an active operation. If a process crashes, an operator must inspect the lock owner and running processes before manual cleanup.

The JSON store uses a separate short-lived write lock and atomic temp-file replacement. If a write lock remains after a crash, the operation times out and asks for manual inspection rather than deleting it automatically.

## CLI examples

Create a record:

npm run media-task -- create --key "quark:share-id:file-id" --provider quark --source "/Downloads/Example" --name "Example" --type series

List and inspect:

npm run media-task -- list

npm run media-task -- get TASK_ID

The CLI currently exposes create/list/get/transition for task metadata. It is not a transfer or archive executor.

## Safety boundary

- A task missing from the state store is not evidence that an OpenList transfer completed.
- PAUSED, FAILED, UNKNOWN, CONFLICT, and active transfer states are not archivable.
- OpenList task completion must be reconciled by a future OpenList adapter before entering verification.
- Verification must inspect files through OpenList, not local filesystem shortcuts.
- All NAS file operations remain OpenList-only.
- No operation in this stage changes existing NAS media files.


## OpenList task reconciliation

Run `npm run openlist-reconcile -- MEDIA_TASK_ID` to reconcile one `TRANSFERRING` task with OpenList. The adapter looks up the exact recorded OpenList task ID in both `copy/undone` and `copy/done` lists. Only a task in the done bucket with explicit success evidence (progress at least 100 or a recognized success/completed status) advances to `VERIFYING`. A task in undone remains `TRANSFERRING`; a reported error becomes `FAILED`; missing, ambiguous, or incomplete evidence becomes `UNKNOWN`. No files are read, copied, moved, renamed, or deleted by this command.
