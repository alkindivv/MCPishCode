# MCPishCode Lean

Text-only local coding workspaces for trusted MCP hosts, rebased on
[DevSpace](https://github.com/Waishnav/devspace) 1.1.1. MCPishCode keeps upstream
workspace, process, artifact, subagent, and opt-in execution functionality without
the embedded application or workspace website.

## Text-only contract

- MCP results contain text rather than cards, widgets, or duplicated structured
  content. Instruction contents and full discovered skill paths remain available
  to the host.
- There are no MCP app resources, app asset routes, change-review tools or CLI
  commands, or workspace web pages.
- Workspace activity recording is removed. Existing database tables and migration
  history remain for state compatibility; they do not enable recording.
- The owner OAuth approval page remains: it is authentication, not a workspace UI.

## Requirements and installation

Use Node `>=22.19 <27`, Git, and a Bash-compatible shell. Windows requires Git Bash,
WSL, or another compatible Bash environment. This fork does not use the upstream
website installer.

From a source checkout:

```bash
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
node dist/cli.js --version
```

The package is `@alkindivv/mcpishcode-lean`, version `1.1.1-lean.1`. Packaging contains
compiled TypeScript, entrypoints, the configuration schema, and skills; it does not
build or package React, Vite, MCP widgets, or the external website.

## Configure and serve

```bash
node dist/cli.js init --public-url https://your-tunnel.example.com --roots ~/work
node dist/cli.js serve
```

Setup can also be non-interactive (`init --yes`, `--providers`, `--roots`,
`--public-url`, `--force`, and `--json`). MCP setup requires explicit or previously
stored roots. Point your own HTTPS tunnel or reverse proxy to the configured local
address (default `http://127.0.0.1:7676`) and connect the host to its public `/mcp`
URL. Enter the owner password in the OAuth approval page; do not put it in URLs.
Non-interactive setup reports the password file path rather than printing the
password.

Default configuration and authentication files live in `~/.mcpishcode`:

- `config.jsonc` — validated configuration, using `schema/v1/mcpishcode.schema.json`.
- `auth.json` — private owner password.
- Default state: `~/.local/share/mcpishcode`, using `mcpishcode.sqlite`.
- Default managed worktrees: `~/.mcpishcode/worktrees`.

`MCPISHCODE_CONFIG_DIR` takes precedence over the compatible
`DEVSPACE_CONFIG_DIR`. `MCPISHCODE_OAUTH_OWNER_TOKEN` likewise takes precedence over
`DEVSPACE_OAUTH_OWNER_TOKEN` and the stored password. Existing explicit state paths,
OAuth scopes, redirect hosts, and resource aliases remain configurable. The default
scope is `mcpishcode`. Refresh-token retry grace remains opt-in (default zero).

`tools.mode` can explicitly select `codex` or `claude`; unset uses upstream host
detection. `server.trustProxy` accepts `false`, `true`, or `"loopback"`. This fork
removes `ui`, `activity`, and `logging.assets` configuration options rather than
leaving disabled UI switches. Remove those keys when porting a versioned upstream
configuration. Legacy unversioned `ui.enabled` is accepted only during migration
and discarded.

Do not point an upgrade at live state without an isolated copy, migration checks,
and a rollback snapshot. Retaining the database filename does not prove downgrade
safety.

## Subagents and tools

Subagent CLI commands work without a server, public URL, or OAuth:

```bash
node bin/mcpishcode.js agents skill --install agents
node bin/mcpishcode.js agents targets
node bin/mcpishcode.js agents run codex --write-mode read_only "Review this change"
node bin/mcpishcode.js agents wait <id> --timeout 60
```

See `skills/subagents/SKILL.md` for bounded delegation, cancellation, event inspection,
and isolated writing worktrees. Existing upstream experimental flags stay opt-in;
this port does not add provider policies or enable experimental execution by default.

Allowed roots constrain filesystem tools, not arbitrary shell commands. Shells and
subagents run with the local user's authority. Treat connected hosts as trusted
coding partners, use narrow roots and write modes, and keep tunnel credentials and
owner passwords private.

## Verification

```bash
pnpm schema:config
pnpm typecheck
pnpm test
pnpm test:package
npm pack --dry-run --ignore-scripts
```

`pnpm test` builds the TypeScript runtime and runs `scripts/e2e-text-only.mjs` against
isolated state. `pnpm test:package` checks the tarball and repeats the E2E against
its extracted runtime. CI runs both and uploads sanitized JSON evidence and the
package. Remaining historical upstream unit tests are source references, not the
Lean test command; removed UI behavior is covered by the E2E absence assertions.

The external `website/` source is intentionally untouched and is not included in the
runtime package. Upstream documentation may describe UI or commands absent from
this fork; use this README, the generated schema, and CLI help for the Lean contract.
