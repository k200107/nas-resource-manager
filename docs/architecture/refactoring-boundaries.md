# Refactoring boundaries

This document records which files own user-facing commands and which files own reusable implementation. The goal is to remove duplicated internals without collapsing distinct workflows into one oversized CLI.

## Keep as separate command entry points

| Command / file | Responsibility | Decision |
|---|---|---|
| `media-plan.mjs` | Read staging files, identify media, build destinations, detect conflicts | Keep |
| `media-archive.mjs` | Preview and execute explicit OpenList move/rename operations | Keep |
| `media-task.mjs` | Manage local media-ingest task records | Keep |
| `openlist-copy.mjs` | Existing NAS/SMB copy workflow | Keep; must not be replaced by archive Move |
| `openlist-tasks.mjs` | Inspect/cancel OpenList background jobs | Keep |
| `openlist-reconcile.mjs` | Reconcile an exact OpenList task ID into the internal state machine | Keep for now; consider a subcommand only after CLI contracts stabilize |
| `quark-save.mjs`, `baidu-save.mjs` | Provider-specific cloud-save workflows | Keep separate because provider APIs, auth, share parsing, and transfer semantics differ |
| `search-rrdynb.mjs`, readiness/configuration commands | Search and setup | Keep |

## Keep as focused internal modules

- `media-identity.mjs`: pure title, year, resolution, and episode identity helpers.
- `media-sidecar.mjs`: pure association and naming of subtitles, NFO, and artwork.
- `media-task-store.mjs`: state machine, local persistence, resource locks, and archive idempotency ledger.
- `openlist-client.mjs`: shared OpenList HTTP transport, auth headers, timeout, JSON parsing, and API success predicate.

The archive planner and executor remain separate safety boundaries. The planner may read and prepare configured library roots; the executor is the only component allowed to move/rename archive candidates after explicit confirmation.

## Consolidations

- `openlist-test-fixtures.mjs` was superseded by the richer `openlist-media-fixtures.mjs`. The old `media-test-fixtures` npm command remains as a compatibility alias to the unified generator.
- OpenList JSON transport previously appeared independently in copy, task, media planning, media archive, and fixture code. New/updated code should call `openlist-client.mjs`; endpoint-specific business logic and pagination stay in their owning modules.
- Chinese number parsing for seasons belongs to `media-identity.mjs`; sidecar and planner code should import it rather than maintain separate implementations.

## Documentation ownership

- `README.md`: installation, environment setup, command examples, developer testing.
- `SKILL.md`: primary agent behavior and workflow policy.
- `SUBAGENT.md`: delegated-agent hard rules and concise command runbook.
- `docs/architecture/media-ingest-and-organization.md`: canonical architecture and data-flow explanation.
- `docs/media-plan.md`: media naming, identity, sidecar and collision semantics.
- `docs/media-task-state.md`: state machine, verification, lock and idempotency rules.

Do not delete SKILL.md or SUBAGENT.md: they are different runtime instruction surfaces even where some workflow facts overlap. Keep detailed examples in docs and link to them where the agent runtime supports reading local docs.

## Safety invariants

- Never replace NAS-side OpenList Move with local download/upload.
- Preserve OpenList Copy as a separate capability for copy/backup workflows.
- Never overwrite existing targets.
- Never infer transfer completion from a missing task.
- Never auto-delete stale resource locks.
- Never test against the user's real Movies/TVShows library; use a dedicated fixture root.
