/*
Failure modes (enumerated BEFORE implementation):
1. DCR, explicit owner consent, PKCE, token refresh/rotation or bearer auth fail.
2. Codex/Claude surfaces or legacy/modern protocol negotiation are incomplete.
3. Resources/templates/prompts, show_changes, widgets, app assets or /web survive.
4. Tool descriptors require structured results, or results leak structuredContent/cards.
5. open_workspace drops/truncates root instructions, nested paths or real skill paths.
6. Real read/edit/patch/process/stdin operations fail or lie about filesystem changes.
7. Enabled artifacts accept an invalid source or claim to create a nonexistent file.
8. Stale UI/activity config resurrects removed features; archive ships frontend code/deps.
9. A probe touches non-disposable state, leaks secrets into evidence, or fails to clean up.

Repeat from the project root (Node >=22; compiled dist and dependencies required):
  node scripts/e2e-text-only.mjs
Optional env: E2E_ROOT (project context), E2E_RUNTIME_ROOT (compiled package root),
E2E_MODULE_ROOT (alias for E2E_RUNTIME_ROOT), E2E_ARCHIVE (.tgz inspected without install),
E2E_ARTIFACT_PATH (alias for E2E_REPORT, under artifacts/), E2E_SCRATCH_ROOT
(default TMPDIR, otherwise artifacts/.scratch). E2E_EXPLICIT_MODE=1 overrides dynamic
ChatGPT/unknown-host detection. E2E_CODE_MODE=0 omits the additional opt-in scenario.
E2E_LEGACY_ENV=1 explicitly permits DEVSPACE_* aliases for a published-upstream RED run.
Canonical config.jsonc NEVER has ui/activity keys. A separate disposable stale-config
probe must reject them or ignore them without restoring the removed surfaces.
No build/install/hooks, production endpoints, credentials, providers, or unit tests.
Modern uses the upstream SDK's stateless server/discover + request _meta handshake,
not a fabricated legacy initialize response. Unsupported modern is BLOCKED, not PASS.
Every individual assertion is recorded; failure does not hide later independent checks.
*/
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const script = fileURLToPath(import.meta.url);
const root = resolve(process.env.E2E_ROOT ?? join(dirname(script), ".."));
const runtimeRoot = resolve(process.env.E2E_MODULE_ROOT ?? process.env.E2E_RUNTIME_ROOT ?? root);
const artifacts = join(root, "artifacts");
const reportPath = resolve(process.env.E2E_ARTIFACT_PATH ?? process.env.E2E_REPORT ?? join(artifacts, "e2e-text-only.json"));
const explicitMode = process.env.E2E_EXPLICIT_MODE === "1";
const codeMode = process.argv[3] === "codemode";
const surfaceMode = (mode) => mode === "codemode" ? "codex" : mode;
const clientName = (mode) => surfaceMode(mode) === "codex" ? "ChatGPT" : "text-only-e2e-unknown-host";
const protocols = ["2025-06-18", "2026-07-28"];
const execFileAsync = promisify(execFile);
const failures = ["oauth", "surfaces/protocols", "removed endpoints", "text-only results",
  "complete bootstrap context", "filesystem/process workflow", "invalid artifact", "package", "isolation/cleanup"];
let checks = [];
let secrets = [];
let temporary;

function sanitize(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [...secrets, temporary].filter(Boolean)) text = text.split(secret).join("[redacted]");
  return text.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [redacted]").slice(0, 1800);
}

async function check(name, operation, available = true) {
  if (!available) {
    checks.push({ name, status: "blocked", reason: "prerequisite unavailable" });
    return undefined;
  }
  try {
    const detail = await operation();
    const evidence = name === "oauth/dcr-consent-pkce-refresh" ? { refreshedAccessTokenIssued: true }
      : name.endsWith("/tools-list") ? { toolCount: detail.length, names: detail.map((tool) => tool.name).sort() }
      : name.endsWith("/open-workspace") ? { workspaceIdInText: true }
      : name.endsWith("/handshake") ? { protocolVersion: detail.protocolVersion,
        supportedVersions: detail.supportedVersions, capabilityNames: Object.keys(detail.capabilities ?? {}) }
      : detail;
    checks.push({ name, status: "pass", ...(evidence === undefined ? {} : { detail: evidence }) });
    return detail ?? true;
  } catch (error) {
    checks.push({ name, status: "fail", reason: sanitize(error.message) });
    return undefined;
  }
}

function textOf(result) {
  return (result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function forbiddenKeys(value, path = "") {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const next = `${path}/${key}`;
    const forbidden = key === "structuredContent" || (key === "card" && path.endsWith("/_meta"))
      || (path.includes("/_meta") && /^(ui|ui\/.*|openai\/outputTemplate|openai\/widget.*)$/.test(key));
    return [...(forbidden ? [next] : []), ...forbiddenKeys(child, next)];
  });
}

function assertTextResult(result) {
  assert(result && Array.isArray(result.content) && result.content.length > 0, "missing text result");
  assert(result.content.every((part) => part.type === "text" && typeof part.text === "string"), "non-text result content");
  assert.deepEqual(forbiddenKeys(result), [], "result contains structured/widget/card payload");
}

function resultShape(result) {
  return { contentTypes: (result?.content ?? []).map((part) => part.type),
    bytes: Buffer.byteLength(JSON.stringify(result ?? {})), forbiddenKeys: forbiddenKeys(result), isError: !!result?.isError };
}

async function request(base, path, options = {}) {
  assert.equal(new URL(base).hostname, "127.0.0.1", "only localhost TCP is permitted");
  return fetch(`${base}${path}`, { redirect: "manual", ...options, signal: AbortSignal.timeout(15_000) });
}

async function postForm(base, path, form) {
  return request(base, path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form) });
}

function parseRpc(source, id) {
  let messages;
  if (/^data:/m.test(source)) {
    messages = source.split(/\r?\n\r?\n/).filter((event) => /^data:/m.test(event)).map((event) =>
      JSON.parse(event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")));
  } else messages = [JSON.parse(source)];
  const message = messages.find((item) => item.id === id);
  assert(message, "no matching JSON-RPC response id");
  return message;
}

function rpcClient(base, accessToken, protocol, mode) {
  let sequence = 0;
  let session;
  return async (method, params = {}, notification = false) => {
    const modern = protocol === protocols[1];
    const id = `${mode}-${protocol}-${++sequence}`;
    const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": protocol };
    if (session) headers["mcp-session-id"] = session;
    if (modern) Object.assign(headers, { "mcp-method": method,
      ...(params.name || params.uri ? { "mcp-name": params.name ?? params.uri } : {}) });
    const meta = { "io.modelcontextprotocol/protocolVersion": protocol,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: clientName(mode), version: "e2e" } };
    const response = await request(base, "/mcp", { method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", ...(notification ? {} : { id }), method,
      params: modern ? { ...params, _meta: { ...meta, ...params._meta } } : params }) });
    session = response.headers.get("mcp-session-id") ?? session;
    if (notification) return { status: response.status };
    return { status: response.status, body: parseRpc(await response.text(), id) };
  };
}

async function rpcSuccess(rpc, method, params) {
  const reply = await rpc(method, params);
  assert.equal(reply.status, 200, `${method} HTTP ${reply.status}`);
  assert(!reply.body.error, `${method} RPC error ${reply.body.error?.code}: ${reply.body.error?.message}`);
  assert(reply.body.result, `${method} missing result`);
  return reply.body.result;
}

async function reservePort() {
  const reservation = createTcpServer();
  await new Promise((done, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", done); });
  return { port: reservation.address().port, release: () => new Promise((done) => reservation.close(done)) };
}

async function fixtures(mode) {
  const workspace = join(temporary, "workspace");
  const skillDir = join(temporary, "skills", "text-only-fixture");
  await Promise.all([mkdir(join(workspace, "nested"), { recursive: true }), mkdir(skillDir, { recursive: true }),
    mkdir(join(temporary, "config"), { recursive: true }), mkdir(join(temporary, "agents"), { recursive: true })]);
  const instructions = `# Disposable ${mode} instructions\nBEGIN_ROOT_INSTRUCTIONS\n`
    + Array.from({ length: 120 }, (_, index) => `Rule ${index}: preserve this complete synthetic instruction line.`).join("\n")
    + "\nEND_ROOT_INSTRUCTIONS\n";
  const nested = "# Nested instructions\nNESTED_SCOPE_TEXT_ONLY\n";
  const skill = "---\nname: text-only-fixture\ndescription: Exercise disposable text-only E2E workflows.\n---\n# Fixture\nSKILL_BODY_TEXT_ONLY\n";
  await Promise.all([writeFile(join(workspace, "AGENTS.md"), instructions),
    writeFile(join(workspace, "nested", "AGENTS.md"), nested), writeFile(join(skillDir, "SKILL.md"), skill),
    writeFile(join(workspace, "read-edit.txt"), "SYNTHETIC_BEFORE\n")]);
  return { workspace, instructions, nested, skill, skillPath: join(skillDir, "SKILL.md") };
}

function configDocument(mode, port, workspace) {
  return { configVersion: 1,
    server: { host: "127.0.0.1", port, publicBaseUrl: `http://127.0.0.1:${port}`, allowedHosts: ["127.0.0.1"], trustProxy: false },
    storage: { stateDir: join(temporary, "state") },
    workspaces: { allowedRoots: [workspace], worktreeRoot: join(temporary, "worktrees") },
    tools: explicitMode ? { mode: surfaceMode(mode) } : {}, artifacts: { enabled: true, maxFileBytes: 1024 },
    skills: { enabled: true, paths: [join(temporary, "skills")], agentDir: join(temporary, "agents") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
    oauth: { scopes: ["mcpishcode"], refreshTokenGraceSeconds: 0, allowedRedirectHosts: ["127.0.0.1"] },
    logging: { level: "silent", requests: false, toolCalls: false, shellCommands: false } };
}

async function loadIsolatedConfig(mode, port, fixture, owner) {
  const configPath = join(temporary, "config", "config.jsonc");
  const document = configDocument(mode, port, fixture.workspace);
  await writeFile(configPath, JSON.stringify(document), { mode: 0o600 });
  process.env.MCPISHCODE_CONFIG_DIR = dirname(configPath);
  process.env.MCPISHCODE_OWNER_TOKEN = owner;
  process.env.MCPISHCODE_OAUTH_OWNER_TOKEN = owner;
  if (codeMode) {
    process.env.MCPISHCODE_EXPERIMENTAL_CODE_MODE = "1";
    process.env.DEVSPACE_EXPERIMENTAL_CODE_MODE = "1";
  }
  if (process.env.E2E_LEGACY_ENV === "1") {
    process.env.DEVSPACE_CONFIG_DIR = dirname(configPath);
    process.env.DEVSPACE_OAUTH_OWNER_TOKEN = owner;
  }
  const { loadConfig } = await import(pathToFileURL(join(runtimeRoot, "dist", "config.js")));
  const config = loadConfig(process.env);
  assert.equal(resolve(config.stateDir), join(temporary, "state"), "state dir is not isolated");
  assert.deepEqual(config.allowedRoots.map((path) => resolve(path)), [fixture.workspace], "roots are not isolated");
  assert.equal(config.toolSurfaceOverride, explicitMode ? surfaceMode(mode) : undefined, "tools.mode was not respected");
  await check("config/canonical-has-no-ui-activity", () => {
    assert(!Object.hasOwn(document, "ui") && !Object.hasOwn(document, "activity"));
    assert(!Object.hasOwn(config, "uiEnabled") && !Object.hasOwn(config, "activity"), "removed runtime config knobs remain");
  });
  let staleConfig;
  await check("config/stale-ui-enabled-rejected-or-inert", async () => {
    await writeFile(configPath, JSON.stringify({ ...document, ui: { enabled: true }, activity: { enabled: true, maxTurns: 2 } }));
    try { staleConfig = loadConfig(process.env); } catch (error) {
      assert.match(error.message, /ui|activity|unknown|unrecognized|unexpected/i, "stale config failed for an unrelated reason");
      return { handling: "rejected", endpointProbe: "canonical server" };
    }
    assert(!Object.hasOwn(staleConfig, "uiEnabled") && !Object.hasOwn(staleConfig, "activity"), "stale config retained removed knobs");
    return { handling: "ignored", endpointProbe: "stale config server" };
  });
  await writeFile(configPath, JSON.stringify(document), { mode: 0o600 });
  const selected = staleConfig ?? config;
  if (codeMode) assert.equal(selected.experimentalCodeMode, true, "experimental mode env was not respected");
  else assert.equal(selected.experimentalCodeMode, false, "Code Mode must be disabled by default");
  return selected;
}

async function issueOAuth(base, mode, owner) {
  const registration = await request(base, "/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName(mode), redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  assert.equal(registration.status, 201, "DCR status");
  const client = await registration.json();
  assert.equal(typeof client.client_id, "string");
  if (client.client_secret) secrets.push(client.client_secret);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  secrets.push(verifier, state, client.client_id);
  const form = { response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1/callback",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    resource: `${base}/mcp`, scope: "mcpishcode", state };
  await consentChecks(base, form, owner);
  const approved = await postForm(base, "/authorize", { ...form, owner_token: owner });
  assert.equal(approved.status, 302, "owner approval status");
  const callback = new URL(approved.headers.get("location"));
  assert.equal(callback.origin + callback.pathname, form.redirect_uri, "unexpected callback");
  assert.equal(callback.searchParams.get("state"), state, "OAuth state mismatch");
  const code = callback.searchParams.get("code");
  assert(code, "authorization code missing");
  secrets.push(code);
  return exchangeAndRefresh(base, client, { grant_type: "authorization_code", code,
    client_id: client.client_id, redirect_uri: form.redirect_uri, code_verifier: verifier, resource: `${base}/mcp` });
}

async function consentChecks(base, form, owner) {
  await check("oauth/owner-consent-get-does-not-auto-approve", async () => {
    const page = await request(base, `/authorize?${new URLSearchParams(form)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<form\b/i);
    assert.match(html, /name=["']owner_token["']/);
    assert(!html.includes(owner), "owner secret leaked into consent page");
  });
  for (const [name, token] of [["missing", ""], ["incorrect", "not-the-owner"]]) {
    await check(`oauth/${name}-owner-rejected`, async () => {
      const rejected = await postForm(base, "/authorize", { ...form, owner_token: token });
      assert.equal(rejected.status, 401);
      assert(!rejected.headers.has("location"), "unapproved request was redirected");
    });
  }
}

async function exchangeAndRefresh(base, client, tokenForm) {
  await check("oauth/wrong-pkce-rejected", async () => {
    const rejected = await postForm(base, "/token", { ...tokenForm, code_verifier: "incorrect-verifier" });
    assert.equal(rejected.status, 400);
  });
  const exchanged = await postForm(base, "/token", tokenForm);
  assert.equal(exchanged.status, 200, "PKCE token exchange status");
  const token = await exchanged.json();
  assert.equal(typeof token.access_token, "string");
  assert.equal(typeof token.refresh_token, "string");
  secrets.push(token.access_token, token.refresh_token);
  await check("oauth/code-is-single-use", async () => {
    assert.equal((await postForm(base, "/token", tokenForm)).status, 400);
  });
  const refreshed = await postForm(base, "/token", { grant_type: "refresh_token", refresh_token: token.refresh_token,
    client_id: client.client_id, resource: `${base}/mcp` });
  assert.equal(refreshed.status, 200, "refresh status");
  const rotated = await refreshed.json();
  secrets.push(rotated.access_token, rotated.refresh_token);
  assert.equal(typeof rotated.access_token, "string");
  assert.equal(typeof rotated.refresh_token, "string");
  assert.notEqual(rotated.refresh_token, token.refresh_token, "refresh token was not rotated");
  await check("oauth/old-refresh-replay-rejected", async () => {
    const replay = await postForm(base, "/token", { grant_type: "refresh_token", refresh_token: token.refresh_token,
      client_id: client.client_id, resource: `${base}/mcp` });
    assert.equal(replay.status, 400);
  });
  return rotated.access_token;
}

async function endpointChecks(base, token) {
  await check("auth/unauthenticated-mcp-rejected", async () => {
    const denied = await request(base, "/mcp", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(denied.status, 401);
  });
  const paths = ["/mcp-app-assets/workspace-app.html", "/mcp-app-assets/missing.js", "/web", "/web/", "/web/login",
    "/web/api/workspaces", "/web/assets/missing.js"];
  for (const path of paths) {
    for (const authenticated of [false, true]) await check(`http/${path}/${authenticated ? "bearer" : "public"}`, async () => {
      const response = await request(base, path, { headers: authenticated ? { authorization: `Bearer ${token}` } : {} });
      assert.equal(response.status, 404, `removed route ${path} HTTP ${response.status}`);
      await response.arrayBuffer();
      return { status: response.status };
    });
  }
  await check("http/no-app-assets-options-handler", async () => {
    const response = await request(base, "/mcp-app-assets/workspace-app.html", { method: "OPTIONS" });
    assert.equal(response.status, 404);
  });
}

async function protocolReady(rpc, protocol, mode) {
  const info = protocol === protocols[0]
    ? await rpcSuccess(rpc, "initialize", { protocolVersion: protocol, capabilities: {},
      clientInfo: { name: clientName(mode), version: "e2e" } })
    : await rpcSuccess(rpc, "server/discover", {});
  if (protocol === protocols[0]) {
    assert.equal(info.protocolVersion, protocol, "legacy negotiated protocol");
    const notified = await rpc("notifications/initialized", {}, true);
    assert([200, 202, 204].includes(notified.status), "initialized notification rejected");
  } else assert(info.supportedVersions?.includes(protocol), "modern SDK discovery does not advertise requested version");
  return info;
}

async function listAllTools(rpc) {
  const tools = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await rpcSuccess(rpc, "tools/list", cursor ? { cursor } : {});
    assert(Array.isArray(page.tools), "tools/list is not an array");
    tools.push(...page.tools);
    cursor = page.nextCursor;
    assert(!cursor || !cursors.has(cursor), "tool pagination loop");
    if (cursor) cursors.add(cursor);
    assert(cursors.size < 20, "tool pagination exceeds safety limit");
  } while (cursor);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, "duplicate tools");
  return tools;
}

async function surfaceChecks(rpc, prefix, tools, info, mode) {
  const names = tools.map((tool) => tool.name).sort();
  await check(`${prefix}/expected-surface`, () => {
    const required = codeMode ? ["open_workspace", "execute", "poll_execution", "cancel_execution", "download_artifact"]
      : ["open_workspace", "read", "download_artifact",
        ...(mode === "codex" ? ["apply_patch", "exec_command", "write_stdin"] : ["write", "edit", "bash"])];
    for (const name of required) assert(names.includes(name), `missing tool ${name}`);
    const absent = codeMode ? ["read", "write", "edit", "apply_patch", "exec_command", "write_stdin"]
      : mode === "codex" ? ["edit", "bash"] : ["apply_patch", "exec_command", "write_stdin"];
    for (const name of absent) assert(!names.includes(name), `unexpected other-host/internal tool ${name}`);
    return { tools: names };
  });
  await check(`${prefix}/no-show-changes-or-ui-in-instructions`, () => {
    assert(!names.includes("show_changes"));
    assert(!/show_changes|ui:\/\/|\/web\b|mcp-app-assets/.test(info.instructions ?? ""), "removed feature in instructions");
  });
  await check(`${prefix}/no-resource-prompt-capabilities`, () => {
    assert(!Object.hasOwn(info.capabilities ?? {}, "resources"), "resources capability advertised");
    assert(!Object.hasOwn(info.capabilities ?? {}, "prompts"), "prompts capability advertised");
  });
  for (const tool of tools) await check(`${prefix}/descriptor/${tool.name}`, () => {
    assert(!Object.hasOwn(tool, "outputSchema"), "outputSchema requires a structured tool result");
    assert.deepEqual(forbiddenKeys(tool), [], "tool has app/widget metadata");
  });
}

async function removedRpcChecks(rpc, prefix) {
  const methods = [["resources/list", {}], ["resources/templates/list", {}],
    ["resources/read", { uri: "ui://devspace/workspace-app.html" }], ["prompts/list", {}], ["prompts/get", { name: "workspace" }]];
  for (const [method, params] of methods) await check(`${prefix}/removed/${method}`, async () => {
    const reply = await rpc(method, params);
    assert.equal(reply.body.error?.code, -32601, `${method} handler still present`);
    return { httpStatus: reply.status, errorCode: reply.body.error.code };
  });
}

async function callTool(rpc, prefix, name, args, allowError = false) {
  const reply = await rpc("tools/call", { name, arguments: args });
  const result = reply.body.result;
  await check(`${prefix}/text-result/${name}`, () => { assertTextResult(result); return resultShape(result); });
  assert.equal(reply.status, 200, `${name} HTTP ${reply.status}`);
  assert(!reply.body.error, `${name} RPC error ${reply.body.error?.code}`);
  if (!allowError) assert(!result?.isError, `${name} returned a tool error: ${textOf(result).slice(0, 300)}`);
  return result;
}

async function openAndContext(rpc, prefix, fixture) {
  const opened = await callTool(rpc, prefix, "open_workspace", { path: fixture.workspace });
  const text = textOf(opened);
  const workspaceId = text.match(/\bws_[a-f0-9-]+\b/i)?.[0];
  assert(workspaceId, "workspace id is not available in TEXT");
  secrets.push(workspaceId);
  await check(`${prefix}/full-root-instructions-in-text`, () => {
    assert(text.includes(fixture.instructions.trimEnd()), "FULL root AGENTS.md content missing/truncated in text");
  });
  await check(`${prefix}/nested-instruction-path-in-text`, () => {
    assert(text.includes("nested/AGENTS.md"), "nested instruction path missing from text");
  });
  await check(`${prefix}/actual-skill-path-in-text`, async () => {
    assert(text.includes(fixture.skillPath), "actual absolute skill path missing from text");
    assert.equal(await readFile(fixture.skillPath, "utf8"), fixture.skill);
  });
  if (codeMode) return workspaceId;
  await check(`${prefix}/read-nested-instructions`, async () => {
    const read = await callTool(rpc, prefix, "read", { workspace_id: workspaceId, path: "nested/AGENTS.md" });
    assert(textOf(read).includes("NESTED_SCOPE_TEXT_ONLY"));
  });
  await check(`${prefix}/read-real-skill`, async () => {
    const read = await callTool(rpc, prefix, "read", { workspace_id: workspaceId, path: fixture.skillPath });
    assert(textOf(read).includes("SKILL_BODY_TEXT_ONLY"));
  });
  return workspaceId;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function verifyFile(rpc, prefix, workspaceId, fixture, path, expected) {
  assert.equal(await readFile(join(fixture.workspace, path), "utf8"), expected, "real filesystem readback mismatch");
  const read = await callTool(rpc, prefix, "read", { workspace_id: workspaceId, path });
  for (const line of expected.trimEnd().split("\n")) assert(textOf(read).includes(line), "MCP readback mismatch");
}

async function mutationWorkflow(rpc, prefix, workspaceId, fixture, mode, suffix) {
  const ws = { workspace_id: workspaceId };
  const path = `workflow-${suffix}.txt`;
  const expected = `SYNTHETIC_AFTER_${suffix}\n`;
  if (mode === "codex") {
    await callTool(rpc, prefix, "apply_patch", { ...ws,
      patch: `*** Begin Patch\n*** Add File: ${path}\n+SYNTHETIC_BEFORE\n*** End Patch` });
    await callTool(rpc, prefix, "apply_patch", { ...ws,
      patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-SYNTHETIC_BEFORE\n+${expected.trim()}\n*** End Patch` });
  } else {
    await callTool(rpc, prefix, "write", { ...ws, path, content: "SYNTHETIC_BEFORE\n" });
    await callTool(rpc, prefix, "edit", { ...ws, path, edits: [{ old_text: "SYNTHETIC_BEFORE", new_text: expected.trim() }] });
  }
  await verifyFile(rpc, prefix, workspaceId, fixture, path, expected);
  return { readbackVerified: true, mutation: mode === "codex" ? "apply_patch add+update" : "write+edit" };
}

async function processWorkflow(rpc, prefix, workspaceId, fixture, mode, suffix) {
  const path = `process-${suffix}.txt`;
  if (mode === "claude") {
    const code = `require('node:fs').writeFileSync(${JSON.stringify(path)},'CLAUDE_PROCESS_OK\\n');console.log('CLAUDE_PROCESS_OK')`;
    const result = await callTool(rpc, prefix, "bash", { workspace_id: workspaceId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}`, timeout: 10 });
    assert(textOf(result).includes("CLAUDE_PROCESS_OK"));
    await verifyFile(rpc, prefix, workspaceId, fixture, path, "CLAUDE_PROCESS_OK\n");
    return { process: "bash", stdin: "not exposed by Claude surface; covered by Codex" };
  }
  return stdinWorkflow(rpc, prefix, workspaceId, fixture, path);
}

async function stdinWorkflow(rpc, prefix, workspaceId, fixture, path) {
  const code = `process.stdout.write('STDIN_READY\\n');process.stdin.once('data',d=>{require('node:fs').writeFileSync(${JSON.stringify(path)},d);console.log('STDIN_ACK:'+d.toString().trim());process.exit(0)});setTimeout(()=>process.exit(9),15000)`;
  const started = await callTool(rpc, prefix, "exec_command", { workspace_id: workspaceId,
    cmd: `${shellQuote(process.execPath)} -e ${shellQuote(code)}`, yield_time_ms: 500 });
  const session = textOf(started).match(/session(?:[_ ]id)?\s*[:=]?\s*(\d+)/i)?.[1];
  assert(session, "running process session ID not present in TEXT");
  let combined = textOf(await callTool(rpc, prefix, "write_stdin", { workspace_id: workspaceId,
    session_id: Number(session), chars: "REAL_STDIN_BYTES\n", yield_time_ms: 1000 }));
  for (let attempt = 0; attempt < 5 && !combined.includes("Process exited"); attempt++) {
    combined += textOf(await callTool(rpc, prefix, "write_stdin", { workspace_id: workspaceId,
      session_id: Number(session), chars: "", yield_time_ms: 500 }));
  }
  assert(combined.includes("STDIN_ACK:REAL_STDIN_BYTES"), "stdin was not consumed by real process");
  assert.match(combined, /Process exited with code 0\./, "process did not complete successfully");
  await verifyFile(rpc, prefix, workspaceId, fixture, path, "REAL_STDIN_BYTES\n");
  return { process: "exec_command+write_stdin", stdinAndReadbackVerified: true };
}

async function artifactRejection(rpc, prefix, workspaceId, fixture, suffix) {
  const path = `invalid-artifact-${suffix}.txt`;
  // Explicitly INVALID input, not a pretend provider file reference; adapters are disabled.
  const reply = await rpc("tools/call", { name: "download_artifact", arguments: {
    workspace_id: workspaceId, path, file: { invalid_source: true } } });
  assert(reply.body.error || reply.body.result?.isError, "invalid artifact input was accepted");
  if (reply.body.result) await check(`${prefix}/artifact-error-text-only`, () => assertTextResult(reply.body.result));
  await assert.rejects(access(join(fixture.workspace, path)), { code: "ENOENT" });
  return { invalidSourceRejected: true, destinationAbsent: true, nativeProviderDownload: "not attempted" };
}

async function codeModeWorkflow(rpc, prefix, workspaceId) {
  let result = await callTool(rpc, prefix, "execute", { workspace_id: workspaceId,
    code: 'const value = await tools.read({path:"read-edit.txt"}); console.log(value.result); return value;', yield_time_ms: 1000 });
  const parseExecution = (response) => JSON.parse(textOf(response));
  let snapshot = parseExecution(result);
  assert.equal(typeof snapshot.execution_id, "string", "execution id missing from text JSON");
  secrets.push(snapshot.execution_id);
  for (let attempt = 0; attempt < 8 && snapshot.running; attempt++) {
    result = await callTool(rpc, prefix, "poll_execution", { workspace_id: workspaceId,
      execution_id: snapshot.execution_id, yield_time_ms: 1000 });
    snapshot = parseExecution(result);
  }
  assert.equal(snapshot.status, "completed", `Code Mode execution ${snapshot.status}: ${snapshot.error ?? ""}`);
  assert(textOf(result).includes("SYNTHETIC_BEFORE"), "tools.read result not returned in text JSON");
  await callTool(rpc, prefix, "poll_execution", { workspace_id: workspaceId, execution_id: snapshot.execution_id, yield_time_ms: 0 });
  const cancelled = await callTool(rpc, prefix, "cancel_execution", { workspace_id: workspaceId, execution_id: snapshot.execution_id });
  assert.equal(parseExecution(cancelled).status, "completed", "cancel completed execution changed its result");
  return { primitive: "tools.read", returnedInText: true, pollAndCancelCompletedExecution: true };
}

async function codeModeProcessWorkflow(rpc, prefix, workspaceId) {
  const code = "let s=await tools.exec_command({cmd:'sleep 0.1; printf mode-ok',yield_time_ms:0}); while(s.running) s=await tools.write_stdin({session_id:s.session_id,yield_time_ms:1000}); return {exit:s.exit_code,result:s.result};";
  let result = await callTool(rpc, prefix, "execute", { workspace_id: workspaceId, code, yield_time_ms: 1000 });
  let snapshot = JSON.parse(textOf(result));
  assert.equal(typeof snapshot.execution_id, "string", "execution id missing from text JSON");
  secrets.push(snapshot.execution_id);
  for (let attempt = 0; attempt < 10 && snapshot.running; attempt++) {
    result = await callTool(rpc, prefix, "poll_execution", { workspace_id: workspaceId,
      execution_id: snapshot.execution_id, yield_time_ms: 1000 });
    snapshot = JSON.parse(textOf(result));
  }
  assert.equal(snapshot.status, "completed", `Code Mode process ${snapshot.status}: ${snapshot.error ?? ""}`);
  const value = snapshot.value ?? (typeof snapshot.result === "string" ? JSON.parse(snapshot.result) : snapshot.result);
  assert.equal(value?.exit, 0, "internal process exit_code DTO missing or unsuccessful");
  assert.match(value?.result ?? "", /mode-ok/, "internal running/session_id DTO polling did not return output");
  return { internalProcessDTO: "running/session_id/exit_code preserved", exit: value.exit, outputVerified: true };
}

async function runProtocol(base, token, protocol, mode, fixture) {
  const prefix = `${mode}/${protocol}`;
  const rpc = rpcClient(base, token, protocol, mode);
  const info = await check(`${prefix}/handshake`, () => protocolReady(rpc, protocol, mode));
  if (!info) {
    checks.push({ name: `${prefix}/workflow`, status: "blocked", reason: "protocol handshake unavailable; no SDK support assumed" });
    return;
  }
  const tools = await check(`${prefix}/tools-list`, () => listAllTools(rpc));
  if (tools) await surfaceChecks(rpc, prefix, tools, info, surfaceMode(mode));
  await removedRpcChecks(rpc, prefix);
  const workspaceId = await check(`${prefix}/open-workspace`, () => openAndContext(rpc, prefix, fixture));
  const available = typeof workspaceId === "string";
  await check(`${prefix}/show-changes-not-callable`, async () => {
    const reply = await rpc("tools/call", { name: "show_changes", arguments: { workspace_id: workspaceId } });
    assert(reply.body.error || reply.body.result?.isError, "show_changes remains callable");
  }, available);
  if (codeMode) {
    await check(`${prefix}/open-text-signatures`, async () => {
      const result = await callTool(rpc, prefix, "open_workspace", { path: fixture.workspace });
      assert.match(textOf(result), /(?:tools\.)?read\s*[( :]/, "read signature missing from open_workspace text");
    }, available);
    await check(`${prefix}/execute-read-poll-cancel`, () => codeModeWorkflow(rpc, prefix, workspaceId), available);
    await check(`${prefix}/internal-process-dto-polling`, () => codeModeProcessWorkflow(rpc, prefix, workspaceId), available);
    await check(`${prefix}/artifacts-enabled-invalid-source`, () => artifactRejection(rpc, prefix, workspaceId, fixture, protocol.replaceAll("-", "")), available);
    return;
  }
  await check(`${prefix}/initial-read`, async () => {
    const result = await callTool(rpc, prefix, "read", { workspace_id: workspaceId, path: "read-edit.txt" });
    assert(textOf(result).includes("SYNTHETIC_BEFORE"));
  }, available);
  const suffix = protocol.replaceAll("-", "");
  await check(`${prefix}/mutations-and-readback`, () => mutationWorkflow(rpc, prefix, workspaceId, fixture, mode, suffix), available);
  await check(`${prefix}/process-and-readback`, () => processWorkflow(rpc, prefix, workspaceId, fixture, mode, suffix), available);
  await check(`${prefix}/artifacts-enabled-invalid-source`, () => artifactRejection(rpc, prefix, workspaceId, fixture, suffix), available);
}

async function closeRuntime(server, running) {
  await running?.close();
  if (!server) return;
  const closing = new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  server.closeAllConnections?.();
  await closing;
}

async function worker(mode) {
  temporary = process.env.E2E_TEMP;
  let running, server, reservation;
  try {
    const fixture = await fixtures(mode);
    const owner = randomBytes(32).toString("hex");
    secrets.push(owner);
    reservation = await reservePort();
    const config = await loadIsolatedConfig(mode, reservation.port, fixture, owner);
    const { createServer } = await import(pathToFileURL(join(runtimeRoot, "dist", "server.js")));
    running = createServer(config, { incomingArtifactAdapters: [] });
    await reservation.release();
    reservation = undefined;
    server = await new Promise((done, reject) => {
      const listening = running.app.listen(config.port, "127.0.0.1", () => done(listening));
      listening.once("error", reject);
    });
    await check("runtime/localhost-health", async () => {
      const response = await request(config.publicBaseUrl, "/healthz");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    });
    const token = await check("oauth/dcr-consent-pkce-refresh", () => issueOAuth(config.publicBaseUrl, mode, owner));
    // Secret return values are never included in artifacts.
    const oauthCheck = checks.find((item) => item.name === "oauth/dcr-consent-pkce-refresh");
    if (oauthCheck?.detail) oauthCheck.detail = { refreshedAccessTokenIssued: true };
    if (typeof token === "string") {
      await endpointChecks(config.publicBaseUrl, token);
      for (const protocol of protocols) await runProtocol(config.publicBaseUrl, token, protocol, mode, fixture);
    } else checks.push({ name: "mcp/workflows", status: "blocked", reason: "OAuth prerequisite failed" });
  } catch (error) {
    checks.push({ name: "runtime/startup", status: "fail", reason: sanitize(error.message) });
  } finally {
    await check("cleanup/server-and-runtime", async () => { await reservation?.release(); await closeRuntime(server, running); });
    await check("cleanup/disposable-files", async () => {
      await rm(temporary, { recursive: true, force: true });
      await assert.rejects(access(temporary), { code: "ENOENT" });
    });
    const report = JSON.parse(sanitizeReport({ mode, explicitToolsMode: explicitMode ? surfaceMode(mode) : null, clientName: clientName(mode),
      environmentAliases: process.env.E2E_LEGACY_ENV === "1" ? "MCPISHCODE+DEVSPACE (upstream RED compatibility)" : "MCPISHCODE only", checks }));
    process.send?.(report);
    process.disconnect?.();
  }
}

function sanitizeReport(report) {
  let text = JSON.stringify(report);
  for (const secret of [...secrets, temporary].filter(Boolean)) text = text.split(secret).join("[redacted]");
  return text;
}

async function archiveChecks(archive) {
  const entries = await check("archive/read-entry-list", async () => {
    const { stdout } = await execFileAsync("tar", ["-tzf", archive], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 });
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  });
  if (!Array.isArray(entries)) return;
  checks.at(-1).detail = { inspectedEntries: entries.length };
  await check("archive/no-frontend-html-journal-review-files", () => {
    const forbidden = entries.filter((entry) => /(^|\/)(src|dist)\/(ui|web)(\/|$)|(^|\/)vite(?:\.web)?\.config\.|workspace-web|workspace-app|workspace-activity-(journal|store)|review-checkpoints|\.html$/.test(entry));
    assert.deepEqual(forbidden, [], "archive includes removed frontend/journal/review code");
    return { inspectedEntries: entries.length, forbiddenEntries: forbidden };
  });
  await check("archive/no-frontend-manifest-deps-build-scripts", async () => {
    const manifests = entries.filter((entry) => entry === "package/package.json" || entry === "package.json");
    assert.equal(manifests.length, 1, "archive must contain exactly one root package.json");
    const manifest = JSON.parse((await execFileAsync("tar", ["-xOzf", archive, manifests[0]], { maxBuffer: 1024 * 1024, timeout: 30_000 })).stdout);
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies });
    const frontend = deps.filter((name) => /^(react|react-dom|lucide(?:-react)?|@pierre\/diffs|vite|@vitejs\/.*|@types\/react(?:-dom)?|@modelcontextprotocol\/ext-apps)$/.test(name));
    assert.deepEqual(frontend, [], "frontend dependencies remain in manifest");
    assert(!/vite|build:app|build:web/.test(JSON.stringify(manifest.scripts ?? {})), "frontend build scripts remain");
    return { manifest: { name: manifest.name, version: manifest.version }, frontendDependencies: frontend };
  });
}

async function runWorker(mode, scratchRoot) {
  const directory = await mkdtemp(join(scratchRoot, `text-only-${mode}-`));
  await mkdir(join(directory, "home"));
  const env = { PATH: process.env.PATH, HOME: join(directory, "home"), TMPDIR: directory, XDG_CONFIG_HOME: join(directory, "home", ".config"),
    XDG_DATA_HOME: join(directory, "home", ".local", "share"), E2E_ROOT: root, E2E_RUNTIME_ROOT: runtimeRoot,
    E2E_TEMP: directory, E2E_LEGACY_ENV: process.env.E2E_LEGACY_ENV ?? "0",
    E2E_EXPLICIT_MODE: process.env.E2E_EXPLICIT_MODE ?? "0", NO_COLOR: "1" };
  return new Promise((done) => {
    const child = fork(script, ["--worker", mode], { cwd: join(directory, "home"), env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let report;
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("message", (message) => { report = message; });
    child.on("error", (error) => { report = { mode, checks: [{ name: "worker/spawn", status: "fail", reason: error.message }] }; });
    child.on("exit", async (code, signal) => {
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
      done(report ?? { mode, checks: [{ name: "worker/completion", status: "fail", reason: `worker exited ${code ?? signal}; timeout or crash; no results assumed` }] });
    });
  });
}

async function main() {
  assert(!relative(artifacts, reportPath).startsWith("..") && !isAbsolute(relative(artifacts, reportPath)), "E2E_REPORT must be under artifacts/");
  await mkdir(dirname(reportPath), { recursive: true });
  const scratchRoot = resolve(process.env.E2E_SCRATCH_ROOT ?? process.env.TMPDIR ?? join(artifacts, ".scratch"));
  await mkdir(scratchRoot, { recursive: true });
  if (process.env.E2E_ARCHIVE) await archiveChecks(resolve(process.env.E2E_ARCHIVE));
  else checks.push({ name: "archive/frontend-files-and-manifest", status: "not-requested", reason: "set E2E_ARCHIVE to inspect a real .tgz" });
  const runtimeAvailable = await check("runtime/compiled-entrypoints", async () => {
    const hashes = {};
    for (const file of ["server.js", "config.js"]) hashes[file] = createHash("sha256")
      .update(await readFile(join(runtimeRoot, "dist", file))).digest("hex");
    const manifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
    return { package: manifest.name, version: manifest.version, sha256: hashes, node: process.version };
  });
  const modes = ["codex", "claude", ...(process.env.E2E_CODE_MODE === "0" ? [] : ["codemode"])];
  const reports = runtimeAvailable ? await Promise.all(modes.map((mode) => runWorker(mode, scratchRoot))) : [];
  if (!runtimeAvailable) for (const mode of modes) checks.push({ name: `${mode}/runtime-workflow`, status: "blocked", reason: "compiled entrypoints unavailable; no runtime result assumed" });
  const all = [...checks, ...reports.flatMap((report) => report.checks)];
  const counts = Object.fromEntries(["pass", "fail", "blocked", "not-requested"].map((status) => [status, all.filter((item) => item.status === status).length]));
  const report = { schemaVersion: 1, scope: "disposable localhost TCP; no production auth/state/provider calls", failureModes: failures,
    runtimeRoot, protocols, archiveRequested: !!process.env.E2E_ARCHIVE, checks, hosts: reports, counts,
    outcome: counts.fail || counts.blocked ? "RED" : "GREEN", limits: [
      explicitMode ? "Explicit tools.mode overrides host identification." : "OAuth DCR ChatGPT selects Codex; an unknown host selects the default Claude surface.",
      "Native artifact provider download is not attempted; invalid-source rejection is exercised with adapters disabled.",
      ...(!process.env.E2E_ARCHIVE ? ["Package archive inspection not requested."] : [])] };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outcome: report.outcome, counts, report: reportPath }));
  process.exitCode = report.outcome === "GREEN" ? 0 : 1;
}

if (process.argv[2] === "--worker") await worker(process.argv[3]);
else await main();
