# Configuration Reference

MCPishCode can be configured through `mcpishcode init`, persisted config files, or
environment variables.

The default files are:

```text
~/.mcpishcode/config.json
~/.mcpishcode/auth.json
```

Use another config directory with:

```bash
MCPISHCODE_CONFIG_DIR=/path/to/config npx @alkindivv/mcpishcode serve
```

## Commands

```bash
npx @alkindivv/mcpishcode init
npx @alkindivv/mcpishcode serve
npx @alkindivv/mcpishcode doctor
npx @alkindivv/mcpishcode config get
npx @alkindivv/mcpishcode config set publicBaseUrl https://mcpishcode.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `MCPISHCODE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `MCPISHCODE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `MCPISHCODE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `MCPISHCODE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `MCPISHCODE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.mcpishcode/worktrees`. |
| `MCPISHCODE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/mcpishcode`. |

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
MCPISHCODE_ARTIFACTS=1 npx @alkindivv/mcpishcode serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCPISHCODE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `MCPISHCODE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.mcpishcode/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
MCPishCode safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

MCPishCode uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `MCPISHCODE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `MCPISHCODE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `MCPISHCODE_OAUTH_SCOPES` | `mcpishcode` |
| `MCPISHCODE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`MCPISHCODE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`MCPISHCODE_MINIMAL_TOOLS` remains a backward-compatible alias when
`MCPISHCODE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `MCPISHCODE_TOOL_MODE` and always uses
its fixed short tool names regardless of `MCPISHCODE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`MCPISHCODE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Opt-in. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Default in this audit build. Disables widget resources and result-card metadata. |

## Skills

| Variable | Purpose |
| --- | --- |
| `MCPISHCODE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `MCPISHCODE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `MCPISHCODE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `MCPISHCODE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

MCPishCode discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.mcpishcode/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `MCPISHCODE_SUBAGENTS=1`, unless `~/.mcpishcode/skills/subagent-delegation/SKILL.md` exists
- `MCPISHCODE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `MCPISHCODE_SKILL_PATHS`

When Subagents are enabled, MCPishCode discovers agent profiles
from:

- `~/.mcpishcode/agents/*.md`
- project `.mcpishcode/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `mcpishcode agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `mcpishcode agents ls`,
`mcpishcode agents run`, and `mcpishcode agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `MCPISHCODE_SKILL_PATHS` when needed.

Example:

```bash
MCPISHCODE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @alkindivv/mcpishcode serve
```

## Logging

| Variable | Default |
| --- | --- |
| `MCPISHCODE_LOG_LEVEL` | `info` |
| `MCPISHCODE_LOG_FORMAT` | `json` |
| `MCPISHCODE_LOG_REQUESTS` | `1` |
| `MCPISHCODE_LOG_ASSETS` | `0` |
| `MCPISHCODE_LOG_TOOL_CALLS` | `1` |
| `MCPISHCODE_LOG_SHELL_COMMANDS` | `0` |
| `MCPISHCODE_TRUST_PROXY` | `0` |

Set `MCPISHCODE_LOG_FORMAT=pretty` for local debugging.

Set `MCPISHCODE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
MCPISHCODE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
MCPISHCODE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
MCPISHCODE_PUBLIC_BASE_URL="https://mcpishcode.example.com" \
MCPISHCODE_WORKTREE_ROOT="$HOME/.mcpishcode/worktrees" \
MCPISHCODE_ARTIFACTS="1" \
MCPISHCODE_TOOL_MODE="minimal" \
MCPISHCODE_WIDGETS="full" \
npx @alkindivv/mcpishcode serve
```

The environment assignments must be part of the same command invocation, or
exported first.

## Output and resource budgets (audit build)

See [Performance and migration](performance.md) and `.env.performance.example`.
`MCPISHCODE_OUTPUT_MODE=compact` is the default. Text appears in `content` once;
`structuredContent.result` contains `ok` or `error`, not a duplicate transcript.
`read_output` is available in all tool modes. Optional `get_tool_preview` is
app-only and is absent with widgets off. All widget cards start collapsed.
The new budgets are environment settings; `.env` files are not automatically loaded.
