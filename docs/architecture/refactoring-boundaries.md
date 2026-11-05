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

## 第二阶段：网盘保存、环境配置与 CLI 公共层

- `cloud-save-common.mjs`：夸克/百度共同使用的资源类型判定、资源名规范化、条目选择、集数标签、文件名清理、JSON 参数解析、Cookie 读取、交互式选择和 Markdown/容量格式化。该模块只放纯逻辑或通用终端交互，不包含任何网盘 API。
- `quark-save.mjs`：保留夸克分享解析、目录 fid 解析、stoken、保存任务轮询和夸克重命名 API。
- `baidu-save.mjs`：保留百度分享页解析、提取码校验、bdstoken、转存和百度重命名 API。它不再通过导入 `quark-save.mjs` 获取通用分类/选择函数。
- `env-config.mjs`：统一 dotenv 解析、文件读取和环境变量合并。优先级保持为进程环境变量覆盖注入配置/文件配置；显式注入配置仍替代 dotenv 文件配置，避免测试和调用方行为变化。
- `cli-utils.mjs`：统一直接执行入口判断，以及环境检查脚本的 dotenv 路径、输出格式和可选超时参数解析。夸克/百度仍保留各自 provider 参数解析，因为两者参数集合和目标字段不同。
- `check-env.mjs`：只检查配置是否缺失/格式错误。
- `check-ready.mjs`：在配置检查基础上执行 Cookie、OpenList 和网盘目标的只读连通性检查。两者不合并，避免把静态配置校验与远端探测混为一谈。

时间戳格式化保留 provider 差异：夸克按毫秒处理，百度接口时间戳按秒/毫秒自动兼容；公共函数通过显式选项处理，不把两个接口的时间单位强行假设为一致。

