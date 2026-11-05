# Media ingestion and organization architecture

## User workflow

The project keeps OpenList as the NAS-side file-operation gateway. It does not manipulate the NAS filesystem directly.

Preferred flow:

1. Search for a resource or accept a user-provided share link.
2. Inspect the share contents and classify the resource (movie, TV series, animation, collection, or unknown).
3. Preview a cloud-drive save destination. Prefer organizing into a suitable folder in the cloud drive at save time when the provider supports it.
4. Save the share into the selected cloud-drive folder only after confirmation.
5. Use OpenList to inspect the cloud-drive resource and initiate the transfer/download to the NAS staging directory, normally Downloads.
6. Track the OpenList task until it is explicitly complete.
7. Verify the resulting files through OpenList. Check that file size and metadata are stable across repeated reads; use hashes when the provider exposes reliable hashes.
8. Generate a dry-run archive plan for the media library. Keep related subtitles, NFO files, artwork, and other sidecars together.
9. Only after the user approves the archive plan, execute the move/rename through the OpenList archive executor and record the verified result. OpenList Copy remains a separate backup workflow, not the archive operation.

## Path roles

These are distinct OpenList paths and must not be conflated:

- Cloud-drive save folder: a provider-side path such as a Quark or Baidu folder. It is selected during share-save preview.
- Staging/download folder: the NAS-side OpenList path where OpenList transfers resources for inspection. The initial default can be /Downloads, but the actual path must be confirmed against the user's OpenList mount.
- Default copy destination: OPENLIST_DEFAULT_COPY_DST_PATH, the existing Resource 2 NAS setting for a default NAS/SMB-backed copy destination. It is not automatically the staging folder or media-library root.
- Media library: separate OpenList paths for movies and TV shows. These paths must be configured only after the actual OpenList mount layout is inspected.

Never assume that a local OS path such as /vol1/1000/media is a valid OpenList path.

## Cloud-drive-side organization

Cloud-drive organization is preferred when it reduces later NAS work, but it is provider-dependent:

- Classify before saving when the share preview provides enough evidence.
- Use separate, configurable cloud-drive folders for movies, TV series, animation, and unclassified resources where supported.
- Do not infer a season from a bare number or filename alone.
- Do not claim that a provider-side move/rename is supported until its API behavior, authorization, and failure handling have been tested.
- If provider-side organization is unavailable or uncertain, save to a clearly named inbox folder and defer classification to the read-only NAS scan.

The initial implementation must preserve the existing Quark/Baidu save workflows. Provider-side folder creation/move features should be added behind capability checks, not assumed.

## Transfer safety state machine

A resource must not be archived while a transfer is active, paused, retrying, or unknown.

Suggested states:

DISCOVERED -> CLOUD_SAVE_PENDING -> CLOUD_SAVED -> TRANSFER_PENDING -> TRANSFERRING -> VERIFYING -> STAGED -> ARCHIVE_PENDING -> ARCHIVED

Exceptional states include FAILED, PAUSED, UNKNOWN, and CONFLICT.

Rules:

- PAUSED, FAILED, UNKNOWN, and active transfer states are never eligible for archive operations.
- A task is complete only when OpenList reports a terminal-success state and the staged files pass verification.
- A missing task record is not proof of completion.
- File size stability is a minimum check, not proof of integrity. Use hashes where reliable hashes are available.
- Use a per-resource lock and an idempotency key so OpenClaw and Hermes cannot process the same resource concurrently.
- Record every planned and executed operation, including source, destination, task ID, timestamps, verification evidence, and outcome.
- On interruption, resume by reconciling recorded state with OpenList; never blindly repeat a move.

## Archive layout

The first archive target should be configurable and conservative:

- Movies: one directory per film; keep the video, subtitles, NFO, and artwork associated with that film together.
- TV shows: one directory per series, then season directories only when the season is supported by reliable evidence.
- Unknown or ambiguous resources remain in staging or an Unsorted area pending review.
- Existing library content is not scanned for modification or changed automatically. The first release produces reports and dry-run plans only.

## OpenClaw and Hermes

Both agents call the same CLI/service layer and the same task-state store. They must not implement independent file-moving logic. The shared service owns locks, idempotency, task reconciliation, validation, dry-run plans, and audit logs.

## Initial safety boundary

The current implementation supports read-only planning and explicit, isolated archive execution through OpenList Move/Rename. Existing library files are not modified unless the operator supplies a reviewed plan and explicitly passes --yes. The archive executor has source/destination rechecks, conflict blocking, resource locks, and an idempotency ledger. It does not yet enforce the internal task-state machine's transfer-completion gate; unattended automatic archiving remains out of scope until that integration is complete. Cloud saves, OpenList Copy, and any deletion remain separate operations requiring their own preview/confirmation protocol.
