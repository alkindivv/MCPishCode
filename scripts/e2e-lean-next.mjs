import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { parse as parseJsonc } from "jsonc-parser";

const base = (process.env.E2E_BASE ?? "http://127.0.0.1:7678").replace(/\/$/, "");
const authPath = process.env.E2E_AUTH_PATH ?? "/root/.mcpishcode-lean-next/auth.json";
const artifactPath = process.env.E2E_ARTIFACT_PATH
  ?? "/root/.hermes/profiles/mcp-specialist/workspace/mcpishcode-lean-next-e2e.json";
const expectedPersistedWorkspaceId = process.env.E2E_EXPECT_PERSISTED_WORKSPACE_ID;
const candidateStateRoot = process.env.E2E_STATE_ROOT ?? "/root/.mcpishcode-lean-next";
const probeWorkspace = process.env.E2E_WORKSPACE
  ?? "/root/.hermes/profiles/mcp-specialist/cache/scratch/mcpishcode-lean-next-e2e-workspace";
const modernProtocolVersion = "2026-07-28";
const legacyProtocolVersion = "2025-06-18";

let requestId = 0;

function fail(message) {
  throw new Error(message);
}

function bodyFromResponse(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  const payload = (lines.length > 0 ? lines.at(-1).slice(5) : text).trim();
  try {
    return JSON.parse(payload);
  } catch (error) {
    fail(`Response was not JSON-RPC JSON: ${payload.slice(0, 500)} (${String(error)})`);
  }
}

function contentText(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function resultShape(result) {
  return {
    totalBytes: JSON.stringify(result ?? {}).length,
    contentBytes: JSON.stringify(result?.content ?? []).length,
    hasStructuredContent: Object.hasOwn(result ?? {}, "structuredContent"),
    hasCardMeta: Boolean(result?._meta?.card),
  };
}

function assertTextOnly(result, label) {
  const shape = resultShape(result);
  if (shape.hasStructuredContent || shape.hasCardMeta) {
    fail(`${label} returned duplicate app payload: ${JSON.stringify(shape)}`);
  }
  if (!Array.isArray(result?.content) || result.content.length === 0) {
    fail(`${label} did not return text content`);
  }
  return shape;
}

async function request(path, options = {}) {
  return fetch(`${base}${path}`, options);
}

async function inspectCandidateIsolation() {
  const configPath = join(candidateStateRoot, "config.jsonc");
  const stateDbPath = join(candidateStateRoot, "state", "mcpishcode.sqlite");
  const configSource = await readFile(configPath, "utf8");
  const config = parseJsonc(configSource);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail(`candidate config is not an object: ${configPath}`);
  }
  if (configSource.includes("/root/.mcpishcode-lean/")) {
    fail("candidate config references Lean state");
  }
  const db = new Database(stateDbPath, { readonly: true });
  try {
    const leanRootReferences = db
      .prepare("select count(*) as count from workspace_sessions where root like '/root/.mcpishcode-lean/%'")
      .get().count;
    if (leanRootReferences !== 0) {
      fail(`candidate state retains ${leanRootReferences} Lean worktree reference(s)`);
    }
    return { configPath, stateDbPath, leanRootReferences };
  } finally {
    db.close();
  }
}

async function issueToken() {
  const ownerToken = JSON.parse(await readFile(authPath, "utf8")).ownerToken;
  if (typeof ownerToken !== "string" || ownerToken.length < 16) {
    fail("candidate auth.json has no valid owner token");
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = "http://127.0.0.1:9999/callback";
  const registration = await request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "mcpishcode-lean-next-e2e",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!registration.ok) fail(`OAuth registration failed: ${registration.status}`);
  const client = await registration.json();
  if (typeof client.client_id !== "string" || !client.client_id.startsWith("mcpishcode-")) {
    fail("OAuth dynamic registration did not return an MCPishCode client ID");
  }
  const authorizationParams = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcpishcode",
    resource: `${base}/mcp`,
  });
  const authorizationPage = await request(`/authorize?${authorizationParams}`);
  const authorizationHtml = await authorizationPage.text();
  if (!authorizationPage.ok || !authorizationHtml.includes("Connect MCPishCode") || authorizationHtml.includes("DevSpace")) {
    fail(`OAuth authorization page branding failed: HTTP ${authorizationPage.status}`);
  }
  const authorization = await request("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(authorizationParams), owner_token: ownerToken }),
    redirect: "manual",
  });
  const location = authorization.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : undefined;
  if (!code) fail(`OAuth authorization failed: ${authorization.status}`);
  const token = await request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  if (!token.ok) fail(`OAuth token exchange failed: ${token.status}`);
  const accessToken = (await token.json()).access_token;
  if (typeof accessToken !== "string" || accessToken.length < 16) fail("OAuth returned no access token");
  return {
    accessToken,
    dynamicClientPrefix: "mcpishcode-",
    authorizationPageBranding: "MCPishCode",
  };
}

async function rpc(accessToken, method, params = {}, protocolVersion = modernProtocolVersion) {
  const name = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string" ? params.uri : undefined;
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      ...(protocolVersion === modernProtocolVersion ? {
        "mcp-method": method,
        "mcp-protocol-version": protocolVersion,
        ...(name ? { "mcp-name": name } : {}),
      } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `e2e-${++requestId}`,
      method,
      params: protocolVersion === modernProtocolVersion
        ? {
          ...params,
          _meta: {
            ...(params._meta ?? {}),
            "io.modelcontextprotocol/protocolVersion": protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": {},
            "openai/session": "mcpishcode-lean-next-e2e",
          },
        }
        : params,
    }),
  });
  const body = bodyFromResponse(await response.text());
  if (!response.ok || body.error) {
    fail(`${method} failed: HTTP ${response.status} ${JSON.stringify(body.error ?? body)}`);
  }
  return { result: body.result, sessionId: response.headers.get("mcp-session-id") };
}

async function rpcError(accessToken, method, params = {}) {
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-method": method,
      "mcp-protocol-version": modernProtocolVersion,
      ...(typeof params.uri === "string" ? { "mcp-name": params.uri } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `e2e-error-${++requestId}`,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": modernProtocolVersion,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = bodyFromResponse(await response.text());
  if (response.ok && !body.error) fail(`${method} unexpectedly succeeded`);
  return { httpStatus: response.status, errorCode: body.error?.code };
}

await mkdir(probeWorkspace, { recursive: true });
await rm(join(probeWorkspace, "patched-e2e.txt"), { force: true });
await writeFile(join(probeWorkspace, "candidate-e2e.txt"), "mcpishcode lean-next E2E probe\n");

const isolation = await inspectCandidateIsolation();
const health = await request("/healthz");
if (!health.ok) fail(`health failed: ${health.status}`);
const healthBody = await health.json();
if (healthBody?.name !== "mcpishcode") fail(`unexpected health payload: ${JSON.stringify(healthBody)}`);

const unauthMcp = await request("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "unauth", method: "tools/list", params: {} }),
});
if (unauthMcp.status !== 401) fail(`unauthenticated MCP expected 401, got ${unauthMcp.status}`);

const oauth = await issueToken();
const token = oauth.accessToken;
const discovery = await rpc(token, "server/discover");
const modernTools = await rpc(token, "tools/list");
const resources = await rpcError(token, "resources/list");
if (resources.httpStatus !== 404 || resources.errorCode !== -32601) {
  fail(`resources/list should be unavailable after UI removal: ${JSON.stringify(resources)}`);
}
const legacyInitialize = await rpc(token, "initialize", {
  protocolVersion: legacyProtocolVersion,
  capabilities: {},
  clientInfo: { name: "mcpishcode-lean-next-e2e", version: "1" },
}, legacyProtocolVersion);
const legacyTools = await rpc(token, "tools/list", {}, legacyProtocolVersion);

const toolList = modernTools.result?.tools ?? [];
const toolNames = toolList.map((tool) => tool.name).sort();
for (const required of ["open_workspace", "read", "apply_patch", "exec_command", "write_stdin", "download_artifact"]) {
  if (!toolNames.includes(required)) fail(`tools/list missing ${required}: ${toolNames.join(", ")}`);
}
if (toolNames.includes("show_changes")) fail("tools/list still exposes show_changes");
for (const tool of toolList) {
  if (tool?._meta?.ui || tool?._meta?.["openai/outputTemplate"]) {
    fail(`tools/list exposes app widget metadata on ${tool.name}`);
  }
}
const resourceUris = [];
const uiResource = await rpcError(token, "resources/read", { uri: "ui://devspace/workspace-app.html" });
if (uiResource.httpStatus !== 404 || uiResource.errorCode !== -32601) {
  fail(`resources/read should be unavailable after UI removal: ${JSON.stringify(uiResource)}`);
}
const assets = await request("/mcp-app-assets/missing.js");
if (assets.status !== 404) fail(`MCP app asset route expected 404, got ${assets.status}`);

const opened = await rpc(token, "tools/call", {
  name: "open_workspace",
  arguments: { path: probeWorkspace },
});
const openShape = assertTextOnly(opened.result, "open_workspace");
const openedText = contentText(opened.result);
const workspaceId = openedText.match(/\bws_[0-9a-f]+\b/i)?.[0];
if (!workspaceId) fail(`open_workspace did not return a workspace_id in text: ${openedText}`);
let persistedReadShape;
if (expectedPersistedWorkspaceId) {
  if (workspaceId !== expectedPersistedWorkspaceId) {
    fail(`candidate workspace ID changed after restart: expected ${expectedPersistedWorkspaceId}, got ${workspaceId}`);
  }
  const persistedRead = await rpc(token, "tools/call", {
    name: "read",
    arguments: { workspace_id: expectedPersistedWorkspaceId, path: "candidate-e2e.txt" },
  });
  persistedReadShape = assertTextOnly(persistedRead.result, "persisted candidate workspace read");
  if (!contentText(persistedRead.result).includes("mcpishcode lean-next E2E probe")) {
    fail("persisted candidate workspace read did not return probe content");
  }
}
const rejectedArtifactPath = "blocked-e2e.bin";
await rm(join(probeWorkspace, rejectedArtifactPath), { force: true });
const rejectedArtifact = await rpc(token, "tools/call", {
  name: "download_artifact",
  arguments: {
    workspace_id: workspaceId,
    path: rejectedArtifactPath,
    file: {
      download_url: "https://example.invalid/mcpishcode-e2e.bin",
      file_id: "file-mcpishcode-e2e",
    },
  },
});
const rejectedArtifactShape = assertTextOnly(rejectedArtifact.result, "download_artifact rejection");
if (!rejectedArtifact.result?.isError || !contentText(rejectedArtifact.result).includes("trusted file host")) {
  fail(`download_artifact did not reject the untrusted URL: ${contentText(rejectedArtifact.result)}`);
}
try {
  await readFile(join(probeWorkspace, rejectedArtifactPath));
  fail("download_artifact wrote a file after rejecting the untrusted URL");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const read = await rpc(token, "tools/call", {
  name: "read",
  arguments: { workspace_id: workspaceId, path: "candidate-e2e.txt" },
});
const readShape = assertTextOnly(read.result, "candidate workspace read");
if (!contentText(read.result).includes("mcpishcode lean-next E2E probe")) {
  fail("candidate workspace read did not return probe content");
}

const appliedPatch = await rpc(token, "tools/call", {
  name: "apply_patch",
  arguments: {
    workspace_id: workspaceId,
    patch: "*** Begin Patch\n*** Add File: patched-e2e.txt\n+patched by MCPishCode E2E\n*** End Patch",
  },
});
const appliedPatchShape = assertTextOnly(appliedPatch.result, "apply_patch");
if (!contentText(appliedPatch.result).includes("Applied patch to 1 file")) {
  fail("apply_patch did not report one changed file");
}
const patchedRead = await rpc(token, "tools/call", {
  name: "read",
  arguments: { workspace_id: workspaceId, path: "patched-e2e.txt" },
});
const patchedReadShape = assertTextOnly(patchedRead.result, "patched file read");
if (!contentText(patchedRead.result).includes("patched by MCPishCode E2E")) {
  fail("patched file read did not return patched content");
}

const processStart = await rpc(token, "tools/call", {
  name: "exec_command",
  arguments: {
    workspace_id: workspaceId,
    cmd: "read line; printf 'stdin:%s\n' \"$line\"",
    yield_time_ms: 0,
  },
});
const processStartShape = assertTextOnly(processStart.result, "exec_command");
const processSessionId = Number(contentText(processStart.result).match(/session ID (\d+)/)?.[1]);
if (!Number.isInteger(processSessionId) || processSessionId < 1) {
  fail(`exec_command did not return a running session ID: ${contentText(processStart.result)}`);
}
const processWrite = await rpc(token, "tools/call", {
  name: "write_stdin",
  arguments: {
    workspace_id: workspaceId,
    session_id: processSessionId,
    chars: "verified\n",
    yield_time_ms: 1_000,
  },
});
const processWriteShape = assertTextOnly(processWrite.result, "write_stdin");
if (!contentText(processWrite.result).includes("stdin:verified")) {
  fail(`write_stdin did not return process output: ${contentText(processWrite.result)}`);
}

const artifact = {
  probe: "mcpishcode-lean-next-isolated-e2e",
  timestamp: new Date().toISOString(),
  endpoint: `${base}/mcp`,
  health: healthBody,
  unauthenticatedMcpStatus: unauthMcp.status,
  oauth: {
    dynamicRegistration: true,
    dynamicClientPrefix: oauth.dynamicClientPrefix,
    authorizationCodePkce: true,
    authorizationPageBranding: oauth.authorizationPageBranding,
    bearerMcp: true,
  },
  modern: {
    protocolVersion: modernProtocolVersion,
    discoveredVersions: discovery.result?.supportedVersions ?? [],
    serverName: healthBody.name,
    tools: toolNames,
  },
  legacy: {
    protocolVersion: legacyInitialize.result?.protocolVersion,
    toolCount: legacyTools.result?.tools?.length ?? 0,
    sessionId: legacyInitialize.sessionId,
  },
  exclusions: {
    showChanges: toolNames.includes("show_changes"),
    resourcesList: resources,
    uiResourceUris: resourceUris,
    uiResourceRead: uiResource,
    assetRouteStatus: assets.status,
    toolWidgetMetadata: toolList
      .filter((tool) => tool?._meta?.ui || tool?._meta?.["openai/outputTemplate"])
      .map((tool) => tool.name),
  },
  isolation: {
    candidateStateRoot,
    configPath: isolation.configPath,
    stateDbPath: isolation.stateDbPath,
    leanRootReferences: isolation.leanRootReferences,
    persistedWorkspaceCheck: Boolean(expectedPersistedWorkspaceId),
  },
  workspace: {
    workspaceId,
    openedWorkspaceIdFormat: workspaceId.startsWith("ws_") ? "ws_" : "unexpected",
    openWorkspace: openShape,
    downloadArtifactRejected: rejectedArtifactShape,
    persistedRead: persistedReadShape,
    read: readShape,
    applyPatch: appliedPatchShape,
    patchedRead: patchedReadShape,
    process: {
      execCommand: processStartShape,
      writeStdin: processWriteShape,
    },
  },
};

await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(artifact));
