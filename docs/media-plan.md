# Read-only media archive planner

The first media-library integration is deliberately read-only. It scans a configured OpenList staging path with POST /api/fs/list and emits proposed destinations. It does not call fs/copy, fs/move, fs/rename, or delete APIs.

## OpenList path configuration

- OPENLIST_STAGING_PATH: temporary download/staging directory after cloud-drive save.
- MEDIA_MOVIES_PATH: Movies library root.
- MEDIA_TVSHOWS_PATH: TVShows library root.
- OPENLIST_DEFAULT_COPY_DST_PATH: existing default SMB/NAS copy destination; its meaning is unchanged.

All values are OpenList virtual paths, not host paths such as /vol1/1000/media. Configure only after confirming the actual mount paths in OpenList.

## Run a preview

```bash
npm run media-plan -- --format text
```

Or pass --source-dir, --movies-dir, and --tvshows-dir explicitly. The command uses OPENLIST_BASE_URL and OPENLIST_TOKEN. It traverses at most five directory levels and 1,000 entries.

## Classification safeguards

- Explicit episode notation such as S02E03, EP03, or Chinese episode markers can identify a series.
- A season directory is proposed only when an explicit season marker such as S02E03 or 第三季 is present. A bare number in a title (for example 狐妖小红娘3) is not treated as a season.
- A directory containing a video whose basename matches the directory name is treated as a medium-confidence movie-folder pattern and flagged for human review.
- A loose video file without reliable series/movie evidence is not auto-filed into Movies or TVShows.
- Non-video resources and ambiguous cases remain in staging for manual review.
- Subtitle/NFO/artwork sidecars are not yet included in archive planning.

## Important

This command is a planning tool, not an archive executor. No plan item is permission to move or rename a file. A future executor must re-list source and destination, check conflicts and active transfer tasks, verify stable file state, acquire a shared task lock, and require explicit user confirmation for the exact source-to-target plan.