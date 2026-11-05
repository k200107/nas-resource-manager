# Media identity and archive planning

The planner is read-only. It scans the OpenList staging directory and checks only the relevant Movies/TVShows destination parent-directory chains using `/api/fs/list`; it does not recursively scan the entire media library or call copy, move, rename, delete, or overwrite APIs.

## Path configuration

- `OPENLIST_STAGING_PATH`: temporary staging directory.
- `MEDIA_MOVIES_PATH`: Movies library root.
- `MEDIA_TVSHOWS_PATH`: TVShows library root.
- `OPENLIST_DEFAULT_COPY_DST_PATH`: existing default copy destination; separate from staging and library roots.
- `MEDIA_TITLE_ALIASES_FILE`: optional local JSON catalog of confirmed title aliases.

All paths must be OpenList-visible virtual paths, not host paths such as `/vol1/1000/media`.

## Identity analysis

The planner combines directory/file names, explicit year and season/episode markers, video extensions, and local title aliases.

- Clear movie-folder patterns, explicit movie years, and explicit season/episode identifiers can produce high-confidence archive candidates.
- A title alias or likely typo/homophone is shown as a candidate and requires user confirmation; it is never silently renamed to another film.
- The alias catalog uses the canonical title as the key and an array of alternate spellings as values. Copy `config/media-title-aliases.example.json` to `config/media-title-aliases.json`, then add only aliases confirmed by a user. The local file is git-ignored.
- Offline fuzzy matching is limited to the alias catalog. General Chinese homophone recognition is not guaranteed without a metadata provider or a sufficiently complete alias catalog.
- Season-only or episode-only evidence is not enough to invent missing season/episode numbers. Such items remain in review.

## Resolution and naming

Resolution tags are extracted from filenames: 2160p/4K, 2048p/2K, 1080p, 720p, and 480p. The identity helper can accept real width/height metadata, but the current OpenList planner does not probe remote video streams; it does not claim to know actual resolution when the filename has no tag.

Movie examples:

```text
Movies/
└── Example (2024)/
    ├── Example (2024) - 1080p.mkv
    └── Example (2024) - 2048p.mkv
```

TV examples:

```text
TVShows/
└── Example Series/
    └── Season 01/
        ├── Example Series - S01E01 - 1080p.mkv
        └── Example Series - S01E01 - 2160p.mkv
```

This follows Emby-style title/year, season folder, and multi-version naming. Resolution is part of the filename so different quality versions do not collide with each other.

## Conflict handling and automatic candidates

- Exact target-path collisions are marked `conflict`; existing files are never overwritten.
- Different resolution suffixes generate distinct target paths and are not treated as same-name conflicts.
- Destination trees are indexed with bounded scanning. If a destination scan is truncated, the planner cannot prove the target is clear and sends the item to `review_required`.
- `auto_archive_candidate` means the identity and target are clear and the read-only destination scan found no exact collision. It is a plan only, not permission to execute.
- Ambiguous titles, uncertain season/episode data, and conflicts remain in staging for review.

## Run

```bash
npm run media-plan -- --format text
```

The command only reads OpenList directory listings. A future archive executor must independently re-check source stability, transfer completion, exact destination conflicts, and task locks immediately before any file operation.
