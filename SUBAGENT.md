# Sub-Agent Runbook

Use this file when OpenClaw, Hermes, or another sub Agent is delegated a media search, direct share-link save, OpenList visibility check, OpenList task progress/cancel, or NAS/OpenList copy task.

## Hard Rules

- Never print or commit `ALIYUN_REFRESH_TOKEN`, `QUARK_COOKIE`, `BAIDU_COOKIE`, `OPENLIST_TOKEN`, raw cookies, or raw auth headers. Aliyun token rotation may be persisted only in the ignored `.state/aliyun-auth.json` state file.
- Do not use `--yes` until the user or supervising Agent has confirmed the preview payload, unless the task explicitly includes `confirmed: true`.
- Prefer `--format json` or `--json` for every script call that supports it. Do not parse Markdown when JSON is available.
- Search defaults to Aliyun Drive, Quark Netdisk, then Baidu Netdisk with a 50-result candidate cap. This is candidate ordering, not provider substitution. When saving from search results, choose the first candidate whose provider is in `check-ready.validProviders`. Aliyun saving uses its dedicated web-session adapter and must pass the same readiness and preview-confirm-save checks as the other providers.
- If the user specifies a provider, such as "只要夸克" or "取消百度", act only on that provider. Do not start, retry, copy, or report another provider as an acceptable substitute. Never reroute an explicitly supplied share URL to another provider.
- Do not create background retry loops, cron jobs, or recurring automations unless the user explicitly asks for them.
- Readiness validation is an Agent JSON tool. Run `npm run check-ready` before real saves/copies on fresh installs or after auth/path errors, and continue only when `nextAction` is `ready`.
- Aliyun, Quark, and Baidu are supported save providers with separate adapters and authorization mechanisms. A complete configuration needs at least one reachable provider, not all three.
- Quark save targets may be full folder URLs or cloud-drive paths like `/备份资源`.
- In JSON mode, use `--dry-run` for preview or `--yes` for confirmed save. Do not invoke interactive save prompts in JSON mode.
- For cloud saves, always run a preview first, classify the resource, and produce a confirmation payload before mutation.
- A Baidu path like `/NAS资源下载` is still a Baidu cloud-drive path. It is not a NAS copy unless OpenList `fs/copy` is executed after the cloud save.

## Canonical Default Paths

Use the following directory layout unless the user explicitly overrides a path:

| Setting | Default | Purpose |
| --- | --- | --- |
| `ALIYUN_DEFAULT_SAVE_PATH` | `/影视库` | Aliyun Drive cloud-side save folder |
| `QUARK_DEFAULT_SAVE_URL` | `/影视库` | Quark cloud-side save folder |
| `BAIDU_DEFAULT_SAVE_PATH` | `/影视库` | Baidu cloud-side save folder |
| `OPENLIST_DEFAULT_COPY_DST_PATH` | `/本地存储/Downloads` | Default target for generic OpenList copy operations |
| `OPENLIST_STAGING_PATH` | `/本地存储/Downloads` | Temporary NAS staging folder scanned by `media-plan` |
| `MEDIA_MOVIES_PATH` | `/本地存储/Movies` | Final movie library root |
| `MEDIA_TVSHOWS_PATH` | `/本地存储/TVShows` | Final TV library root |

`OPENLIST_DEFAULT_COPY_DST_PATH` and `OPENLIST_STAGING_PATH` intentionally share the same default directory, but they are not duplicate settings: the former is the fallback target for `openlist-copy`; the latter is the source scanned by `media-plan`. Keep them equal for the standard ingest flow.

Cloud-drive `/影视库` and OpenList `/本地存储/...` are different storage systems. Never pass a cloud-drive path as an OpenList path or vice versa.

Standard flow: save to the selected cloud provider's `/影视库` → copy through OpenList to `/本地存储/Downloads` → inspect with `media-plan` → only after every transfer task is confirmed successful and the user separately authorizes archiving, move/rename into Movies or TVShows. Never start archive work while transfer status is active, failed, or unknown.

Path defaults are centralized in `scripts/env-config.mjs`; `.env` values and process environment variables override them. Never put real credentials in the defaults or documentation.
## Decision Table

| User intent | First command | Mutating command |
| --- | --- | --- |
| Search title | `node scripts/search-rrdynb.mjs "$KW" --format json --max-candidates 50` | none |
| Full readiness check | `npm run check-ready` | none |
| Check install config | `npm run check-env -- --json` | none |
| Check Cookie validity | `npm run check-cookies` | none |
| Save Aliyun share | `node scripts/aliyun-save.mjs "$SHARE_URL" "$DEST_PATH" --dry-run --json` | Same command with `--yes --json` after confirmation |
| Save Quark share | `node scripts/quark-save.mjs "$SHARE_URL" "$DEST_URL" --dry-run --json` | Same command with `--yes --json` after confirmation |
| Save Baidu share | `node scripts/baidu-save.mjs "$SHARE_URL" "$DEST_PATH_OR_URL" --dry-run --json` | Same command with `--yes --json` after confirmation |
| View OpenList copy progress | `npm run openlist-tasks -- list copy undone --format json` | none |
| View OpenList offline download progress | `npm run openlist-tasks -- list offline_download undone --format json` | none |
| Cancel OpenList tasks | `npm run openlist-tasks -- cancel copy undone --provider "$PROVIDER" --format json` | Same command with `--yes --format json` after confirmation |
| Copy saved resource to NAS/OpenList | `npm run openlist-copy -- "$SRC_DIR" "$DST_DIR" "$NAME" --format json` | Same command with `--yes --format json` after confirmation |

## JSON Preview Contract

The Aliyun, Quark, and Baidu preview commands return one JSON object with the same confirmation contract:

```json
{
  "ok": true,
  "provider": "baidu",
  "mode": "preview",
  "nextAction": "confirm_before_save",
  "source": {
    "shareUrl": "https://pan.baidu.com/s/...",
    "shareId": "..."
  },
  "target": {
    "provider": "baidu",
    "pathOrUrl": "/NAS资源下载"
  },
  "resource": {
    "shareTitle": "暗影蜘蛛",
    "canonicalName": "暗影蜘蛛",
    "type": "collection",
    "label": "合集",
    "isSeries": false,
    "reason": "Agent 根据上下文判定为合集"
  },
  "selection": {
    "defaultSelection": "all",
    "selectedRanks": [1],
    "selectedItems": []
  },
  "renamePlan": [],
  "confirmation": {
    "source": "https://pan.baidu.com/s/...",
    "selectedItems": [],
    "target": {
      "provider": "baidu",
      "pathOrUrl": "/NAS资源下载"
    },
    "finalNaming": [],
    "commandHint": "Re-run ... with --yes after the user confirms this payload."
  }
}
```

Before any save/copy mutation, report these exact fields to the user or supervising Agent:

- Source: `confirmation.source`
- Selected items: `confirmation.selectedItems[].name`
- Target: `confirmation.target.pathOrUrl`
- Final naming: `confirmation.finalNaming`, or "keep original names" when empty
- Resource type: `resource.label` and `resource.reason`
- Next command: the same command with `--yes --format json`

## Save Commands

Aliyun: `node scripts/aliyun-save.mjs "$SHARE_URL" "$ALIYUN_DEFAULT_SAVE_PATH" --dry-run --format json`. After confirmation, rerun with `--yes`. The rotated refresh token is stored in the ignored `.state/aliyun-auth.json` file.

Quark:

```bash
node scripts/quark-save.mjs "$SHARE_URL" "$QUARK_DEFAULT_SAVE_URL" \
  --dry-run \
  --format json \
  --context-name "$CANONICAL_NAME" \
  --resource-type auto
```

Baidu:

```bash
node scripts/baidu-save.mjs "$SHARE_URL" "$BAIDU_DEFAULT_SAVE_PATH" \
  --dry-run \
  --format json \
  --context-name "$CANONICAL_NAME" \
  --resource-type auto \
  --passcode "$PASSCODE_IF_NEEDED"
```

After confirmation, replace `--dry-run` with `--yes`.

## Classification Rules

- If item names include `S01E01`, `EP01`, `第1集`, `第一季`, `全12集`, `完结`, `剧集`, or similar, use `--resource-type series` and tell the user it is a series.
- If a single top-level folder contains variants like `1080p`, `4K`, `SDR`, `彩色版`, `黑白版`, or multiple quality folders, use `--resource-type collection`.
- If the title is clearly one movie and the selected item is a single video file, use `--resource-type movie`.
- If uncertain, keep `auto`, but explain the uncertainty and do not invent a canonical title.

## Common Failures

| Symptom | Action |
| --- | --- |
| Missing `.env` or missing key | Run `npm run check-ready`, then ask user to follow `https://guantou.site/archives/N2CmhISt`. |
| `check-ready.nextAction` is `configure_provider` | Ask the user to configure at least one full provider: Aliyun, Quark, or Baidu. Both are not required. |
| `check-ready.nextAction` is `fix_openlist_target` | Ask the user to fix `OPENLIST_BASE_URL`, `OPENLIST_TOKEN`, or `OPENLIST_DEFAULT_COPY_DST_PATH`. |
| `check-ready.nextAction` is `fix_provider_target` | Ask the user to verify the configured provider save directory exists. |
| `check-cookies.nextAction` is `configure_missing_cookies` | Ask the user to fill the missing Cookie env vars listed in `recommendations`. |
| `check-cookies.nextAction` is `refresh_invalid_cookies` | Ask the user to log in again, copy fresh Cookies, and re-run `npm run check-cookies`. |
| `check-cookies.nextAction` is `retry_network_or_check_access` | Do not claim the Cookie is invalid; ask the user to check network/provider access and retry. |
| Baidu target URL rejected | Ensure it is from `pan.baidu.com` and contains a `path` parameter in the hash or query. |
| Baidu page parse error | Inspect for `window.yunData` and `locals.mset`, then add a regression test before editing parser code. |
| Extraction code failure | Ask for the correct code; pass with `--passcode`. |
| `errno` is not `0` after Baidu save | Report the errno and message; do not claim success. |
| Quark save returns no `task_id` | Report the API response summary; do not retry blindly. |
| OpenList copy task disappears | Do not call it failed yet. Check `copy/done` and refresh the destination directory. |
| OpenList copy task fails | Use `npm run openlist-tasks -- list copy done --format json`, report task error, and verify both source and target with `refresh:true`. |

## OpenList Copy Protocol

Before `fs/copy`, state:

- Source directory: OpenList path containing the saved resource.
- Object: exact `names[]` entry.
- Destination directory: OpenList NAS/SMB path.
- Final path/name: expected resulting path.

Use the bundled copy script:

```bash
npm run openlist-copy -- "$SRC_DIR" "$DST_DIR" "$NAME" --format json
```

After confirmation:

```bash
npm run openlist-copy -- "$SRC_DIR" "$DST_DIR" "$NAME" --yes --format json
```

The script calls `fs/copy`, checks `copy/undone`, checks `copy/done`, and lists the destination with `refresh:true` until the copied item appears. A task missing from `undone` is not failure unless `done` or the destination check also shows failure.

If the preview returns `destination.existingTargetNames`, tell the user the target already contains same-named items and require explicit confirmation before `--yes`.

## OpenList Task Protocol

Use `openlist-tasks` when the user asks to inspect or cancel running OpenList jobs:

```bash
npm run openlist-tasks -- list copy undone --format json
npm run openlist-tasks -- list copy done --format json
npm run openlist-tasks -- cancel copy undone --provider baidu --format json
npm run openlist-tasks -- cancel copy undone --provider baidu --yes --format json
```

Available task groups: `copy`, `offline_download`, `offline_download_transfer`, `upload`, `decompress`, `decompress_upload`.

Cancellation rules:

- First run without `--yes` and show matched task ids/names/progress/errors.
- Only run with `--yes` after user/supervisor confirmation.
- Use `--provider baidu`, `--provider quark`, `--ids`, or `--match` to avoid canceling unrelated work.


## Media identity and archive planning

When asked to organize files already in the OpenList staging directory, run `npm run media-plan -- --format json`. The planner is read-only; it scans the staging directory and checks only the relevant Movies/TVShows destination parent directories.

- Treat high-confidence `auto_archive_candidate` items as candidates for review, not execution permission. The archive CLI is not yet connected to the task-state transfer-completion gate.
- Route title aliases, likely homophones/typos, uncertain movie-vs-series classification, incomplete season/episode markers, or incomplete destination scans to `review_required`.
- A title alias is a suggestion, not a final identification. Ask the user to confirm the canonical title and media type once.
- Exact destination-path matches are `conflict`; never overwrite. Different resolution suffixes (such as 1080p vs 2160p) are distinct versions.
- Use Emby-style movie title/year folders, TV `Season NN` folders, and resolution suffixes in filenames.
- The current planner extracts resolution tags from names. It does not probe the actual remote video stream for dimensions.
- A separate `media-archive` executor exists. It defaults to read-only preflight; actual Move/Rename requires explicit `--yes` and user/supervisor confirmation. It rechecks sources and targets, blocks conflicts, uses resource locks and an idempotency ledger, and verifies destination entries. However, it does not yet consult the task-state machine or verify the exact OpenList transfer task. The operator must independently confirm transfer completion and file stability. Do not run unattended or against the real library until this gate is integrated.
