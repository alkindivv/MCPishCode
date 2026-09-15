# Performance and migration - audit build

This is a local source patch of the supplied MCPishCode 1.0.5 archive. It is not a
published upstream release. Existing installed/global/npm versions are unchanged.

## Launch the patched source

Use the project's declared Node range, `>=22.19 <27`. Keep a backup of your current
checkout and configuration. Do not delete the SQLite state or regenerate OAuth
credentials to apply this patch.

```bash
cd MCPishCode-optimized
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js doctor
MCPISHCODE_WIDGETS=off MCPISHCODE_OUTPUT_MODE=compact node dist/cli.js serve
```

Run the commands in order and stop on a failure. `npm ci` needs registry access
and the normal native-dependency installation process. The audit environment
could not complete that installation, so passing this full gate is a prerequisite
for trusting the patch in important workflows. Do not use `--ignore-scripts` as a
production workaround for native SQLite or PTY dependencies.

Your existing allowed roots, OAuth configuration, state directory and public URL
are reused. Only run `node dist/cli.js init` for a genuinely new installation.
For a full set of explicit resource budgets:

```bash
node --env-file=.env.performance.example dist/cli.js serve
```

Environment files are NOT loaded automatically. Already exported variables take
precedence over Node's env file, so unset conflicting old values first or use the
explicit assignments above. Do not put credentials into the committed example.
After restarting the server, refresh/reconnect the client so its cached tool
schema reflects the new mode. Compare using a fresh chat: this server patch
cannot remove previous large results from an existing transcript.

## What changed

The performance preset is `widgets=off`, `outputMode=compact`. Regular tool output
text is placed in `content` once; `structuredContent.result` becomes `ok` or
`error`, while essential fields such as exit codes, session IDs and applied status
remain. This is a contract change for consumers that previously treated
`structuredContent.result` as the entire transcript. Such consumers must read
`content`, or explicitly set `MCPISHCODE_OUTPUT_MODE=legacy` while migrating.
Legacy mode restores verbose text behavior, not every old UI/resource default.

Root project instructions are still discovered. Compact workspace output lists
paths with `needsRead: true` instead of copying their bodies into the initial
response. Read those files before work and follow file/output continuations.
Nested instruction discovery skips common dependency/build directories and can
stop at a resource budget. Check ancestor instructions for every modified path;
a missing catalog entry does not establish that no instruction file exists.

`MCPISHCODE_WIDGETS=changes` provides a collapsed workspace card and aggregate
`show_changes`. `full` restores per-tool cards, still collapsed and lazy-loaded.
Both keep compact model output by default. `off` disables this server's widget
resources and result-card metadata, not ChatGPT's own native tool activity UI.

## Limits and units

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `MCPISHCODE_MAX_OUTPUT_CHARS` | 8000 | Combined text returned by the result formatter; UTF-16 code units, not tokens |
| `MCPISHCODE_MAX_PREVIEW_CHARS` | 24000 | Optional preview text/patch cap; oversized patches omitted whole |
| `MCPISHCODE_DEFAULT_READ_LINES` | 160 | Default file-read line request |
| `MCPISHCODE_MAX_READ_LINES` | 2000 | Largest allowed explicit line request |
| `MCPISHCODE_OUTPUT_CACHE_BYTES` | 16777216 | Serialized UTF-8 bytes retained in the shared output/preview cache |
| `MCPISHCODE_OUTPUT_ENTRY_BYTES` | 1048576 | Largest retained entry; oversized entries rejected, not silently cached partly |
| `MCPISHCODE_OUTPUT_CACHE_TTL_MS` | 900000 | Fixed 15-minute lifetime; LRU pressure may evict earlier |
| `MCPISHCODE_MAX_PROCESS_SESSIONS` | 16 | Concurrent managed Codex-mode process sessions |
| `MCPISHCODE_MAX_MCP_SESSIONS` | 32 | Active MCP sessions plus reserved initializations |
| `MCPISHCODE_MCP_IDLE_TTL_MS` | 3600000 | Idle MCP lifetime; cleanup checks every minute |
| `MCPISHCODE_PROCESS_BUFFER_CHARS` | 64000 | Head/tail buffer capacity per managed process, Unicode code points |
| `MCPISHCODE_DEFAULT_OUTPUT_TOKENS` | 2000 | Codex process output estimate, converted using 4 characters/token; not a tokenizer |
| `MCPISHCODE_MAX_CONTEXT_ENTRIES` | 30 | Maximum entries per initial workspace catalog category |
| `MCPISHCODE_MAX_CONTEXT_SCAN_ENTRIES` | 50000 | Nested instruction traversal budget |
| `MCPISHCODE_CONTEXT_SCAN_TIMEOUT_MS` | 3000 | Cooperative nested instruction scan time budget |

The cache additionally caps entries at 256. Cache bytes are NOT a total heap/RSS
cap. Text caps are NOT a universal MCP envelope-size cap: schemas, metadata,
paths, structured file lists, explicit images and request arguments can add more.
The scan deadline is cooperative and cannot interrupt a stuck filesystem syscall.
A per-process-session budget is not a sandbox or a limit on arbitrary shell child
processes or optional provider workers.

## Continue a long result without rerunning work

When a result includes `outputId`, call the model-visible `read_output`:

```json
{"workspaceId":"the-existing-workspace-id","outputId":"the-returned-output-id","offset":0,"limit":4000}
```

Use the returned `nextOffset` verbatim until it is absent. Offsets are UTF-16 code
units and pages avoid splitting surrogate pairs. IDs are workspace-scoped.
`contextOutputId` uses the same reader for a retained workspace metadata catalog.
A cache miss is an explicit error. Restart clears all retained data.

Only the text returned by the upstream tool can be retained. Text discarded by
an upstream read limit, shell truncation or the process ring buffer is not
recoverable by `read_output`. For very large logs, use a durable log produced by
the task itself and inspect a scoped portion. Never rerun a write, deployment or
other side-effecting command merely to recover its output.

Optional UI previews use app-only `get_tool_preview` after expansion. Preview data
is returned in `_meta`; the model-facing result remains small. Expired previews
show an error rather than silently rerunning the original tool. Patches are never
truncated mid-hunk just to satisfy a UI budget.

## Tests and benchmarks

From this source checkout:

```bash
npm run test:core
npm run typecheck:core
npm run test:performance
npm run benchmark:performance
```

`test:core` transpiles all source/test TS/TSX and runs 11 dependency-light suites;
it is NOT semantic typechecking or the full npm test suite. `typecheck:core`
semantically checks seven standalone modules, not the SDK/UI/provider integration.
`test:performance` runs the added 24 regression groups with the installed `tsx`.
The benchmark compares buffer algorithms at equal capacity and a representative
serialized tool result. Results exclude ChatGPT rendering, model inference,
network latency and exact token accounting. Original and modified buffer defaults
are also reported separately and must not be confused with the equal-capacity
algorithm comparison.

## Acceptance before regular use

After the full install/typecheck/test/build gate, use an isolated test project,
not a valuable checkout. Verify OAuth approval and rejected unauthenticated
requests; tool registration in minimal/full/codex modes; ordinary reads and
errors; long-output pagination and expiry; real shell exit codes; writes/edits;
UTF-8; and Ctrl-C/resize if PTY mode is used. Repeat with `off`, `changes`, and
`full`. With widgets enabled, no heavy preview should load before expansion;
expanding must load the right workspace's payload and report cache misses.

For aggregate review, change new/deleted/renamed/text/binary files in a disposable
Git repository and open a nested project folder. Confirm sibling changes are not
included and the real index is unchanged. `show_changes` advances its checkpoint
when the response is generated, not when the UI is viewed; use `markReviewed=false`
or `since="workspace_open"` when appropriate.

For the reported lag, compare fresh chats using the same small read/search/test
workflow with old and new source, a fixed tunnel and the same host. Record response
bytes, tool count, time to usable response, CPU/RSS and browser/app responsiveness.
Do not benchmark by repeating side-effecting operations. No sustained multi-hour
soak or real ChatGPT end-to-end measurement was performed during this audit.

## Rollback

Stop the patched process and restart the original source/global installation with
its previous configuration. Do not delete state. This patch adds no database
migration. `legacy` and `full` are compatibility options, but using the original
checkout is the reliable way to restore the complete original behavior.
