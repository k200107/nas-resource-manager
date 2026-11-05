# Shared media task state

## Purpose

OpenClaw and Hermes share one task store and resource-lock directory. The store is application metadata, not a media directory or OpenList path.

- `MEDIA_TASK_STORE_PATH`: JSON task database, default `.state/media-tasks.json`.
- `MEDIA_TASK_LOCK_DIR`: resource lock directory, default `.state/locks`.

Do not place either path inside Downloads, Movies, TVShows, or the NAS media root.

## State progression

`DISCOVERED -> CLOUD_SAVE_PENDING -> CLOUD_SAVED -> TRANSFER_PENDING -> TRANSFERRING -> VERIFYING -> STAGED`

After verification:

- High-confidence identity + complete transfer verification + no destination conflict: the task may enter `ARCHIVE_PENDING` with `archiveDecision.mode="automatic"`. No per-file user approval is required.
- Alias, typo/homophone candidate, uncertain media type, incomplete season/episode data, or incomplete destination index: enter `REVIEW_REQUIRED`. The user confirms the standard title and whether it is a movie or series once for that item.
- Exact target collision: enter `CONFLICT`. Never overwrite. A conflict must be explicitly resolved (for example by selecting a different target/version or confirming the existing file is the intended duplicate) before returning to `STAGED`.
- Existing explicit approval records remain supported for compatibility, but are not required for every clear item.

Exceptional states: `FAILED`, `PAUSED`, `UNKNOWN`, `CONFLICT`, and `REVIEW_REQUIRED`.

## Verification gates

Entering `STAGED` requires:

- OpenList reports the exact recorded transfer task as completed successfully.
- Verification reports `passed=true` and `transferCompleted=true`.
- The OpenList task ID matches the ID already attached to the internal task.
- At least two stable-size checks have completed.

The current task store validates the evidence fields; a future verifier must actually inspect file size/stability and compare a reliable hash when the source provides one. A status flag supplied by a caller is not itself cryptographic proof.

## Automatic archive gate

`canAutoArchive(task)` requires a verified `STAGED` task, no unresolved conflict, and either high-confidence classification or an explicit identity review resolution. The `ARCHIVE_PENDING` transition accepts an automatic decision only when the task classification is high confidence and the destination check says `conflict=false`. A manually resolved identity can use `archiveDecision.mode="user-confirmed"`; this confirms identity, not each subsequent file move.

The state module does not call OpenList and does not move files. The actual archive executor is a separate future step and must re-list the exact source and destination, acquire the shared resource lock, and revalidate transfer state and conflicts immediately before moving.

## Idempotency and locking

Every task uses a stable idempotency key derived from provider/resource identity. Repeating the same key for the same provider/source returns the existing task. Reusing it for another source is rejected.

Agents should acquire `acquireResourceLock(resourceKey)` and release it in a `finally` block. Locks use atomic directory creation. Stale locks are never automatically removed; an operator must inspect the owner and active processes before manual cleanup.

## CLI

```bash
npm run media-task -- create --key "quark:share-id:file-id" --provider quark --source "/Downloads/Example" --name "Example" --type movie --confidence high
npm run media-task -- list
npm run media-task -- get TASK_ID
```

The CLI manages local task metadata only. It is not a transfer or archive executor.

## Safety boundary

- Existing NAS files remain read-only unless a separate authorized operation is implemented.
- Never move, rename, delete, or overwrite while a transfer, copy, or verification task is active, paused, failed, or unknown.
- Conflicts are never auto-overwritten.
- A plan marked `auto_archive_candidate` is only a proposal; it does not itself execute an archive.
