import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface DevspaceUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  artifactsEnabled?: boolean;
  artifactMaxFileBytes?: number;
  agentDir?: string;
  subagents?: boolean;
}

export interface DevspaceAuthConfig {
  ownerToken?: string;
}

export interface DevspaceFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DevspaceUserConfig;
  auth: DevspaceAuthConfig;
}

export function mcpishcodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.MCPISHCODE_CONFIG_DIR ?? join(homedir(), ".mcpishcode")));
}

export function mcpishcodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpishcodeConfigDir(env), "config.json");
}

export function mcpishcodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpishcodeConfigDir(env), "auth.json");
}

export function mcpishcodeSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpishcodeConfigDir(env), "skills");
}

export function mcpishcodeAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(mcpishcodeConfigDir(env), "agents");
}

export function loadDevspaceFiles(env: NodeJS.ProcessEnv = process.env): DevspaceFiles {
  const dir = mcpishcodeConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<DevspaceUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<DevspaceAuthConfig>(authPath) : {},
  };
}

export function writeDevspaceConfig(
  config: DevspaceUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = mcpishcodeConfigPath(env);
  mkdirSync(mcpishcodeConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeDevspaceAuth(
  auth: DevspaceAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = mcpishcodeAuthPath(env);
  mkdirSync(mcpishcodeConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function ensureDevspaceDefaultSkills(env: NodeJS.ProcessEnv = process.env): string[] {
  const targetPath = join(mcpishcodeSkillsDir(env), "subagent-delegation", "SKILL.md");
  if (existsSync(targetPath)) return [];

  const sourcePath = new URL("../skills/subagent-delegation/SKILL.md", import.meta.url);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath, "utf8"), { mode: 0o644 });
  return [targetPath];
}

export function resolveSubagentsFlag(
  config: Pick<DevspaceUserConfig, "subagents">,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  if (env.MCPISHCODE_SUBAGENTS === undefined) return config.subagents;
  return ["1", "true", "yes", "on"].includes(env.MCPISHCODE_SUBAGENTS.toLowerCase());
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}
