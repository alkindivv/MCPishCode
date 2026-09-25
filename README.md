# MCPishCode

Self-hosted Streamable HTTP MCP server for approved local coding workspaces.

MCPishCode lets a trusted MCP client open an approved project directory, read files,
apply a patch, and run bounded shell processes on the host machine. It is derived
from DevSpace upstream `531d3f9`, but keeps the MCPishCode product boundary:
no ChatGPT App/widget bundle, no `show_changes`, no `ui://` resources, no
`/mcp-app-assets` route, and no duplicate `structuredContent` or `_meta.card`
payloads.

## MCP surface

- `open_workspace` — open or reuse an approved workspace.
- `read` — read a workspace file.
- `apply_patch` — add, update, delete, or move files with a Codex patch.
- `exec_command` — run a command in a workspace.
- `write_stdin` — poll or write to an `exec_command` process.
- `download_artifact` — save a supported attached file into a workspace.

Supported protocols:

- Modern per-request MCP: `2026-07-28`
- Stateless legacy compatibility: `2025-06-18`

## Security model

- The server exposes only configured `allowedRoots`.
- Workspace paths are resolved and constrained server-side.
- MCP access requires OAuth dynamic client registration, Owner-password approval,
  PKCE, and a Bearer access token.
- Bind to loopback by default. Use a TLS reverse proxy or tunnel only when remote
  access is intentional.
- Treat any connected MCP client as a trusted coding partner: `exec_command` runs
  with the local service account's permissions inside the approved workspace.

## Install and run

Requires Node `>=22.19 <27` and pnpm `11.25.0`.

```bash
pnpm install --frozen-lockfile
pnpm build
npm install -g .
mcpishcode init
mcpishcode serve
```

The default configuration root is `~/.mcpishcode`. Override it with
`MCPISHCODE_CONFIG_DIR` for isolated environments. `mcpishcode init` writes
`config.jsonc` and `auth.json` with owner-only permissions.

A non-interactive server can use a stored `auth.json` or
`MCPISHCODE_OAUTH_OWNER_TOKEN`.

## Existing Lean state migration

MCPishCode preserves the historical state filename `mcpishcode.sqlite`. When
starting from a legacy Lean `config.json`, it atomically writes `config.jsonc`
and preserves the legacy file as `config.json.v1.0.bak`. The upstream migration
ledger (`devspace_schema_migrations`) is additive; the existing
`mcpishcode_schema_migrations` history remains intact.

Do not share a config/state directory between a candidate and an active server.
Use a separate port, `MCPISHCODE_CONFIG_DIR`, state directory, and worktree root
for every side-by-side validation.

## Repeatable E2E validation

The candidate harness executes a real local OAuth flow, dynamic registration,
PKCE token exchange, Bearer MCP calls, modern and legacy discovery, an existing
workspace read, and all six public tools. It also asserts the removed UI surface
and duplicate-payload exclusions.

```bash
node scripts/e2e-lean-next.mjs
```

The harness uses only its scratch workspace and writes a redacted artifact to:

```text
/root/.hermes/profiles/mcp-specialist/workspace/mcpishcode-lean-next-e2e.json
```

For a different environment, set `E2E_BASE`, `E2E_AUTH_PATH`,
`E2E_WORKSPACE`, and `E2E_ARTIFACT_PATH`.

## Development

```bash
pnpm build
pnpm typecheck
pnpm start
```

`pnpm test` remains available for upstream development, but the adoption
validation artifact is the end-to-end harness above.

## License

MIT
