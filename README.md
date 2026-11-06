# Resource 2 NAS Skill

A Node.js toolkit and Agent skill for the resource-to-NAS workflow. It supports PanSou resource search, Aliyun/Quark/Baidu share preview and saving, OpenList task inspection, and read-only media-library planning.

The repository is being extended with a cautious media-ingest workflow. Existing NAS media files are treated as read-only unless a separate, explicit operation is implemented and approved.

## Features

- Search PanSou and return ranked Aliyun/Quark/Baidu resource links as Markdown or JSON.
- Preserve download links, extraction codes, provider names, source notes, and timestamps.
- Preview Aliyun, Quark, and Baidu share contents before saving.
- Validate Aliyun web-session refresh tokens and Quark/Baidu Cookies before real saves.
- Save Aliyun shares to a configured Aliyun Drive folder using the web-session refresh token.
- Save Baidu shares to a configured Baidu path or folder URL.
- Inspect and cancel OpenList copy/offline-download tasks.
- Reconcile an internal media task against its exact OpenList task ID.
- Create shared media-ingest task records with guarded state transitions, idempotency keys, and resource locks.
- Analyze movie/series identity, title aliases, years, season/episode markers, and resolution tags.
- Generate Emby-style movie/season folders and multi-resolution filenames.
- Detect exact destination collisions and route ambiguous identities to one-time user review.
- Generate a read-only media plan, then use a separate OpenList archive executor for explicitly confirmed move/rename operations; destination collisions are blocked and review-required items are skipped.

## Requirements

- Node.js 22 or newer is recommended. The automated test workflow currently checks Node.js 22 and 24.
- Git, for cloning the repository.
- OpenList and provider credentials are only needed for operations that connect to those services.

You can install the project and run its automated tests without a `.env` file, OpenList, Quark, or Baidu credentials.

## Windows: clone and run local tests

Open PowerShell and run:

```powershell
# Create and enter a directory for the project (skip mkdir if it already exists)
New-Item -ItemType Directory -Force D:\Projects | Out-Null
cd D:\Projects

# Clone the development branch
git clone -b feat/nas-resource-manager-foundation https://github.com/k200107/nas-resource-manager.git

# Enter the project
cd nas-resource-manager

# Install dependencies
npm install

# Run the automated test suite
npm test
```

Check your local tools first if needed:

```powershell
node -v
npm -v
git --version
```

Node.js 22 or 24 is recommended. The test suite uses Node's built-in test runner. It does not require a live NAS connection and should not modify NAS files.

To update an existing clone to the latest version of this development branch:

```powershell
git switch feat/nas-resource-manager-foundation
git pull
npm install
npm test
```

## Setup for service-connected operations

Only create a local `.env` file when you are ready to test operations that need provider or OpenList access.

PowerShell:

```powershell
Copy-Item .env.example .env
```

Linux/macOS:

```bash
cp .env.example .env
```

Edit `.env` locally and enter your own credentials. Do not paste Cookies, tokens, passwords, or private share links into GitHub issues or commits.

Do not run `npm run check-ready` until you have configured the provider and OpenList settings required for the services you intend to check. A local unit-test run does not need `.env`.

Configuration guide:

https://guantou.site/archives/N2CmhISt

## Configuration

The paths below belong to different systems and must not be treated as interchangeable.

| Variable | Meaning |
| --- | --- |
| `ALIYUN_REFRESH_TOKEN` | Aliyun web-session refresh token from the logged-in web app Local Storage; not the raw HTTP Cookie header. Rotated values are stored in ignored `.state/aliyun-auth.json`. |
| `ALIYUN_DEFAULT_SAVE_PATH` | Existing folder path inside the Aliyun Drive account, e.g. `/资源下载`. |
| `QUARK_COOKIE` | Quark web Cookie used to save Quark share links. |
| `BAIDU_COOKIE` | Baidu Netdisk web Cookie used to save Baidu share links. |
| `QUARK_DEFAULT_SAVE_URL` | Destination folder in the Quark cloud drive; may be a provider folder path or folder URL. |
| `BAIDU_DEFAULT_SAVE_PATH` | Destination folder in Baidu Netdisk; may be a provider folder path or folder URL. |
| `OPENLIST_TOKEN` | OpenList API token for the configured OpenList operations. Treat it as a password. |
| `OPENLIST_BASE_URL` | OpenList service URL reachable from the computer running this project. For example, `http://127.0.0.1:5244` only works when OpenList is running on that same computer. |
| `OPENLIST_DEFAULT_COPY_DST_PATH` | Default OpenList destination backed by SMB/NAS storage for the existing copy workflow. Its original purpose is unchanged. |
| `OPENLIST_STAGING_PATH` | OpenList path used as a temporary staging/download area. Configure only after confirming the actual OpenList mount and path. |
| `MEDIA_MOVIES_PATH` | OpenList path for the Movies library. |
| `MEDIA_TVSHOWS_PATH` | OpenList path for the TVShows library. |
| `MEDIA_TASK_STORE_PATH` | Local application metadata file used by the media-task workflow; not a media directory. |
| `MEDIA_TASK_LOCK_DIR` | Local directory for application task locks; not an OpenList or NAS media path. |

Important path distinctions:

- Quark/Baidu save paths are folders inside the corresponding cloud-drive account.
- `OPENLIST_STAGING_PATH` is an OpenList path for temporary files after transfer.
- `OPENLIST_DEFAULT_COPY_DST_PATH` is the default destination for the existing OpenList copy workflow. It is not automatically the staging path.
- `MEDIA_MOVIES_PATH` and `MEDIA_TVSHOWS_PATH` are separate OpenList media-library paths.
- Values such as `/vol1/1000/media` are NAS filesystem paths, not necessarily OpenList paths. Do not enter them as OpenList paths unless the OpenList mount exposes that exact path.
- The task store and lock directory are local application metadata. OpenClaw and Hermes must use the same persistent location when they share task processing.

At least one provider must be configured for provider save operations. Aliyun, Quark, and Baidu are alternatives; at least one is required for cloud-save operations. Search-only and local automated tests do not require provider Cookies.

## Usage

Search resources:

```bash
npm run search -- "蜘蛛侠"
```

Check service configuration and connectivity after configuring the required credentials:

```bash
npm run check-ready
npm run check-ready -- --format text
```

Preview an Aliyun share with `node scripts/aliyun-save.mjs "$ALIYUN_SHARE_URL" "$ALIYUN_DEFAULT_SAVE_PATH" --dry-run --format json`.

Preview a Quark share:

```bash
npm run quark-save -- "$QUARK_SHARE_URL" "$QUARK_DEFAULT_SAVE_URL" --dry-run
```

Preview a Baidu share:

```bash
npm run baidu-save -- "$BAIDU_SHARE_URL" "$BAIDU_DEFAULT_SAVE_PATH" --dry-run
```

Create and inspect media-ingest task records (local metadata only):

```bash
npm run media-task -- create --key "quark:share-id:file-id" --provider quark --source "/Downloads/资源目录" --name "资源名称" --type series
npm run media-task -- list
npm run media-task -- get TASK_ID
```

Both OpenClaw and Hermes must use the same `MEDIA_TASK_STORE_PATH` and `MEDIA_TASK_LOCK_DIR` on a shared persistent volume. Do not put these paths inside the media library. See `docs/media-task-state.md`.

Reconcile a transfer against its exact OpenList task ID (read-only task API):

```bash
npm run openlist-reconcile -- MEDIA_TASK_ID
```

This only reconciles tasks in the appropriate transfer state. It does not inspect or change media files.

Preview the staging directory and proposed media destinations (read-only):

```bash
npm run media-plan -- --format text
```

The planner reads the staging directory and checks only the relevant destination parent directories in Movies/TVShows through OpenList. It proposes Emby-style names, resolution variants, and exact-path collision results. It also associates subtitles, NFO metadata, and conventional artwork with the corresponding movie, series, episode, or resolution version. A year parent folder such as `2024/Example/Example.mkv` is treated as a year hint, not as the movie title. The planner may create missing configured Movies/TVShows roots and their parent directories through OpenList `fs/mkdir`; it does not move, rename, copy, or delete media files. If a sidecar's owner cannot be identified, the title is an alias/possible homophone, season/episode data is incomplete, a destination collision exists, or destination scanning is incomplete, the item is held for review. Configure the staging and library paths only after checking the OpenList mount.

To maintain confirmed title aliases, copy `config/media-title-aliases.example.json` to `config/media-title-aliases.json`, add aliases only after confirming the canonical title, and set `MEDIA_TITLE_ALIASES_FILE` in `.env`. The local alias file is git-ignored. Offline recognition cannot guarantee all Chinese homophones without a comprehensive catalog or external metadata provider.


Create an isolated media-archive test workspace. It contains only tiny text placeholders with media extensions, not playable video files. The source and target folders are separate, and one pre-existing target is included to test collision blocking:

```bash
npm run media-archive-fixtures
npm run media-archive-fixtures -- --yes
```

Then generate a plan against the isolated workspace (replace the path with the actual OpenList path returned by the fixture command):

```bash
npm run --silent media-plan -- --source-dir "/Downloads/__MEDIA_ARCHIVE_TESTS__/source" --movies-dir "/Downloads/__MEDIA_ARCHIVE_TESTS__/target/Movies" --tvshows-dir "/Downloads/__MEDIA_ARCHIVE_TESTS__/target/TVShows" > media-archive-plan.json
```

Run the archive preflight. Without `--yes`, it only checks source files and destination paths:

```bash
npm run media-archive -- --plan-file media-archive-plan.json --movies-dir "/Downloads/__MEDIA_ARCHIVE_TESTS__/target/Movies" --tvshows-dir "/Downloads/__MEDIA_ARCHIVE_TESTS__/target/TVShows"
```

Only after reviewing the preflight output should you explicitly enable execution, and only against the isolated test workspace:

```bash
npm run media-archive -- --plan-file media-archive-plan.json --movies-dir "/Downloads/__MEDIA_ARCHIVE_TESTS__/target/Movies" --tvshows-dir "/Downloads/__MEDIA_ARCHIVE_TESTS__/target/TVShows" --yes
```

The executor uses OpenList `POST /api/fs/mkdir`, `POST /api/fs/move`, and `POST /api/fs/rename` for videos and their planned sidecars. It never overwrites a target it detects, never deletes the source intentionally, and never uses local filesystem access for NAS files. Verified operations are recorded in the existing `MEDIA_TASK_STORE_PATH` state store; replaying the same plan skips recorded source/target pairs. Resource-group locks use `MEDIA_TASK_LOCK_DIR` to prevent concurrent agents from archiving the same media folder. The OpenList move API does not expose an atomic no-overwrite precondition in its documented request schema; do not run concurrent writers against the same target directories during archive execution.

List current OpenList copy tasks:

```bash
npm run openlist-tasks -- list copy undone --format json
```

Preview an OpenList copy:

```bash
npm run openlist-copy -- "/pan/quark/备份资源" "$OPENLIST_DEFAULT_COPY_DST_PATH" "资源名" --format json
```

Run automated tests:

```bash
npm test
```

## Safety Notes

- Treat Cookies, OpenList tokens, and private share links as credentials.
- Never commit `.env`; it is excluded by `.gitignore`.
- Never print full secrets in logs or diagnostic output.
- Use OpenList paths for NAS operations; do not substitute local OS paths.
- Do not move, rename, delete, or overwrite files while a cloud save, transfer, copy, or verification task is active, paused, failed, or in an unknown state.
- Automatic archive is not enabled yet. The media archive executor does not currently enforce the internal task-state machine's transfer-completion gate; before running it, an operator must confirm the exact OpenList transfer is complete and staged files are stable. Ambiguous identity requires review; exact destination conflicts are paused and never overwritten.
- Ambiguous media classification should remain in staging for manual review.
- The media planner may create missing configured Movies/TVShows root directories (and missing parent directories) through OpenList `fs/mkdir`; it reports every created path. It does not move, rename, copy, or delete media files. Destination subfolders for individual titles/seasons are created only by the separate archive executor after explicit `--yes`. The executor rechecks source and destination immediately before each item, uses resource locks and an idempotency ledger, stops at the first uncertain error, verifies the resulting destination, and never calls copy or delete APIs. It does not yet consult transfer task state, so do not run it against the real Movies/TVShows libraries until the isolated test workspace has passed and the transfer-completion gate has been integrated.

## Repository Layout

```text
agents/              Agent metadata
scripts/             CLI helpers and media workflow modules
tests/               Node test suite
docs/                Architecture, media planning, and task-state documentation
SKILL.md             Main skill instructions
SUBAGENT.md          Sub-agent runbook for OpenClaw, Hermes, and similar agents
.env.example         Safe configuration template
```

## License and upstream

This repository is based on the Resource 2 NAS project. The upstream repository did not include a license file when this fork was prepared. Public visibility alone does not grant permission to relicense or redistribute upstream code under a new license. Confirm the applicable permission with the upstream author before adding a license or distributing a derivative release.
