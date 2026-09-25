# MCPishCode Lean: text-native boundary

This branch rebases the existing Lean port onto DevSpace 1.1.1 / upstream
`559781284677e5b128aa44a2c95f8bdb0c72b7c0`. It is a source release, not a
production state migration or cutover.

## Removed, not toggled

- MCP Apps widgets, resources/resource templates and frontend asset endpoints.
- `show_changes`, review-checkpoint implementation and CLI review command.
- `/web`, browser workspace pages, workspace activity journal/store runtime.
- UI-related tool descriptor metadata and `_meta.card` result payloads.
- Duplicate `structuredContent` and external output schemas that require it.
- React/Vite build, browser bundles and direct UI-only package dependencies.
- `ui` and `activity` configuration switches: they cannot re-enable these features.

OAuth owner-consent HTML remains. Removing authentication UI would break account
linking; it is not a coding widget or workspace dashboard.

Existing database migration identities are preserved. Empty activity tables in
the upstream schema do not imply active recording; no journal is instantiated.
No historical state is deleted by this source change.

## Preserved

- Both Codex and Claude tool surfaces; explicit mode and host-based selection.
- Modern `2026-07-28` and legacy `2025-06-18` protocol plumbing.
- OAuth discovery, registration, consent, PKCE, bearer auth and refresh.
- Workspace read/edit/patch/process capabilities and optional native-file input.
- Canonical allowed-path resolution and latest upstream HTTP lifecycle fixes.
- Workspace identity, worktree details, loaded instruction CONTENTS, nested
  instruction paths, complete skill paths/descriptions, provider/profile details
  and diagnostics in the single model-visible text response.
- Experimental code mode remains opt-in; results use the same text-native wire
  boundary, not widget/structured duplicates.

## Verification

Run the branch's build/typecheck and `node scripts/e2e-text-only.mjs`. The test
uses real localhost HTTP, isolated OAuth clients/tokens/config/state/workspaces,
and synthetic file/process operations. Its JSON report is repeatable and excludes
credentials. The release gate also packs the npm tarball, checks its manifest for
frontend dependencies/assets, and repeats the E2E against its extracted modules.

A healthy isolated candidate does not prove an existing client refreshed schemas
or that production user-state migration is safe. Those remain separate cutover
gates. No public service is restarted as part of the source rebase.
