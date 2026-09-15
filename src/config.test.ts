import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ensureDevspaceDefaultSkills, resolveSubagentsFlag } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "mcpishcode-empty-config-test-"));
const baseEnv = {
  MCPISHCODE_CONFIG_DIR: emptyConfigDir,
  MCPISHCODE_ALLOWED_ROOTS: process.cwd(),
  MCPISHCODE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "off");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).mcpishcodeSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).mcpishcodeAgentsDir, join(emptyConfigDir, "agents"));
assert.equal(loadConfig(baseEnv).subagents, false);
assert.equal(loadConfig(baseEnv).artifactsEnabled, false);
assert.equal(loadConfig(baseEnv).artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_ARTIFACTS: "1" }).artifactsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, MCPISHCODE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_SKILLS: "1" }).skillsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, MCPISHCODE_SUBAGENTS: "1" }).subagents,
  true,
);
assert.equal(resolveSubagentsFlag({}, {}), undefined);
assert.equal(resolveSubagentsFlag({ subagents: true }, {}), true);
assert.equal(resolveSubagentsFlag({ subagents: true }, { MCPISHCODE_SUBAGENTS: "0" }), false);
assert.equal(resolveSubagentsFlag({}, { MCPISHCODE_SUBAGENTS: "1" }), true);

const seededConfigDir = mkdtempSync(join(tmpdir(), "mcpishcode-seeded-skills-test-"));
const seededSkillPaths = ensureDevspaceDefaultSkills({ MCPISHCODE_CONFIG_DIR: seededConfigDir });
assert.deepEqual(seededSkillPaths, [join(seededConfigDir, "skills", "subagent-delegation", "SKILL.md")]);
assert.equal(existsSync(seededSkillPaths[0]), true);
assert.match(readFileSync(seededSkillPaths[0], "utf8"), /name: subagent-delegation/);
assert.deepEqual(ensureDevspaceDefaultSkills({ MCPISHCODE_CONFIG_DIR: seededConfigDir }), []);

assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_WIDGETS: "invalid" }),
  /Invalid MCPISHCODE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_WIDGETS: "minimal" }),
  /Invalid MCPISHCODE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_WIDGETS: "write-only" }),
  /Invalid MCPISHCODE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_TOOL_MODE: "invalid" }),
  /Invalid MCPISHCODE_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, MCPISHCODE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_LOG_LEVEL: "trace" }),
  /Invalid MCPISHCODE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_LOG_FORMAT: "color" }),
  /Invalid MCPISHCODE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["mcpishcode"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, MCPISHCODE_OAUTH_SCOPES: "mcpishcode,admin" }).oauth.scopes,
  ["mcpishcode", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, MCPISHCODE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, MCPISHCODE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, MCPISHCODE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ MCPISHCODE_CONFIG_DIR: emptyConfigDir, MCPISHCODE_ALLOWED_ROOTS: process.cwd() }),
  /MCPISHCODE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_OAUTH_OWNER_TOKEN: "too-short" }),
  /MCPISHCODE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid MCPISHCODE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, MCPISHCODE_ARTIFACT_MAX_FILE_BYTES: "0" }),
  /Invalid MCPISHCODE_ARTIFACT_MAX_FILE_BYTES: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, MCPISHCODE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, MCPISHCODE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, MCPISHCODE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "mcpishcode-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://mcpishcode.example.com",
    subagents: true,
    artifactsEnabled: true,
    artifactMaxFileBytes: 321,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ MCPISHCODE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://mcpishcode.example.com");
assert.equal(fileConfig.subagents, true);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "mcpishcode.example.com",
]);
