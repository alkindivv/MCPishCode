/** Resource budgets are server policy, not suggestions made to the model. */
export interface PerformanceConfig {
  outputMode: "compact" | "legacy";
  maxOutputCharacters: number;
  maxPreviewCharacters: number;
  defaultReadLines: number;
  maxReadLines: number;
  outputCacheBytes: number;
  outputEntryBytes: number;
  outputCacheTtlMs: number;
  maxProcessSessions: number;
  maxMcpSessions: number;
  mcpSessionIdleMs: number;
  processBufferCharacters: number;
  defaultProcessOutputTokens: number;
  maxContextEntries: number;
  maxContextScanEntries: number;
  contextScanTimeoutMs: number;
}

export const DEFAULT_PERFORMANCE_CONFIG: Readonly<PerformanceConfig> = Object.freeze({
  outputMode: "compact",
  maxOutputCharacters: 8_000,
  maxPreviewCharacters: 24_000,
  defaultReadLines: 160,
  maxReadLines: 2_000,
  outputCacheBytes: 16 * 1024 * 1024,
  outputEntryBytes: 1024 * 1024,
  outputCacheTtlMs: 15 * 60 * 1000,
  maxProcessSessions: 16,
  maxMcpSessions: 32,
  mcpSessionIdleMs: 60 * 60 * 1000,
  processBufferCharacters: 64_000,
  defaultProcessOutputTokens: 2_000,
  maxContextEntries: 30,
  maxContextScanEntries: 50_000,
  contextScanTimeoutMs: 3_000,
});

export function performanceConfig(config: { performance?: PerformanceConfig }): PerformanceConfig {
  return config.performance ?? { ...DEFAULT_PERFORMANCE_CONFIG };
}

export function loadPerformanceConfig(env: NodeJS.ProcessEnv): PerformanceConfig {
  const values = { ...DEFAULT_PERFORMANCE_CONFIG };
  const mode = env.MCPISHCODE_OUTPUT_MODE;
  if (mode && mode !== "compact" && mode !== "legacy") {
    throw new Error(`Invalid MCPISHCODE_OUTPUT_MODE: ${mode}`);
  }
  values.outputMode = mode === "legacy" ? "legacy" : "compact";
  const settings: Array<[Exclude<keyof PerformanceConfig, "outputMode">, string, number, number]> = [
    ["maxOutputCharacters", "MAX_OUTPUT_CHARS", 512, 100_000],
    ["maxPreviewCharacters", "MAX_PREVIEW_CHARS", 512, 100_000],
    ["defaultReadLines", "DEFAULT_READ_LINES", 1, 2_000],
    ["maxReadLines", "MAX_READ_LINES", 1, 10_000],
    ["outputCacheBytes", "OUTPUT_CACHE_BYTES", 4096, 128 * 1024 * 1024],
    ["outputEntryBytes", "OUTPUT_ENTRY_BYTES", 1024, 8 * 1024 * 1024],
    ["outputCacheTtlMs", "OUTPUT_CACHE_TTL_MS", 1000, 24 * 60 * 60 * 1000],
    ["maxProcessSessions", "MAX_PROCESS_SESSIONS", 1, 128],
    ["maxMcpSessions", "MAX_MCP_SESSIONS", 1, 256],
    ["mcpSessionIdleMs", "MCP_IDLE_TTL_MS", 60_000, 24 * 60 * 60 * 1000],
    ["processBufferCharacters", "PROCESS_BUFFER_CHARS", 1024, 1_000_000],
    ["defaultProcessOutputTokens", "DEFAULT_OUTPUT_TOKENS", 64, 25_000],
    ["maxContextEntries", "MAX_CONTEXT_ENTRIES", 1, 100],
    ["maxContextScanEntries", "MAX_CONTEXT_SCAN_ENTRIES", 100, 1_000_000],
    ["contextScanTimeoutMs", "CONTEXT_SCAN_TIMEOUT_MS", 100, 30_000],
  ];
  for (const [key, suffix, min, max] of settings) {
    const name = `MCPISHCODE_${suffix}`;
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}: expected an integer from ${min} to ${max}.`);
    }
    values[key] = value;
  }
  if (values.defaultReadLines > values.maxReadLines) {
    throw new Error("MCPISHCODE_DEFAULT_READ_LINES must not exceed MCPISHCODE_MAX_READ_LINES.");
  }
  if (values.outputEntryBytes > values.outputCacheBytes) {
    throw new Error("MCPISHCODE_OUTPUT_ENTRY_BYTES must not exceed MCPISHCODE_OUTPUT_CACHE_BYTES.");
  }
  return values;
}
