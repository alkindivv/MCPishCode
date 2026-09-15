import { spawn } from "node:child_process";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MAX_COMMAND_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 110_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
const DEFAULT_BUFFER_CHARACTERS = 64_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessSnapshot {
  sessionId?: number;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessSession {
  id: number;
  workspaceId: string;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  running: boolean;
  exitCode?: number;
  signal?: string;
  exitWaiters: Set<() => void>;
  cleanupTimer?: NodeJS.Timeout;
}

interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  maxSessions?: number;
  defaultMaxOutputTokens?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { MCPISHCODE_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { MCPISHCODE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
}

function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++, count++) {
    const high = value.charCodeAt(i);
    if (high >= 0xd800 && high <= 0xdbff) {
      const low = value.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) i++;
    }
  }
  return count;
}

function codePointIndex(value: string, count: number): number {
  let i = 0;
  while (i < value.length && count-- > 0) {
    const high = value.charCodeAt(i++);
    if (high >= 0xd800 && high <= 0xdbff) {
      const low = value.charCodeAt(i);
      if (low >= 0xdc00 && low <= 0xdfff) i++;
    }
  }
  return i;
}
function takeHead(value: string, count: number): string {
  return value.slice(0, codePointIndex(value, Math.max(0, count)));
}
function takeTail(value: string, count: number): string {
  let start = value.length;
  while (start > 0 && count-- > 0) {
    const low = value.charCodeAt(--start);
    if (low >= 0xdc00 && low <= 0xdfff && start > 0) {
      const high = value.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start--;
    }
  }
  return value.slice(start);
}
function formatHeadTail(head: string, tail: string, omitted: number): string {
  return omitted > 0 ? `${head}\n... output truncated (${omitted} characters omitted) ...\n${tail}` : head + tail;
}

/** Bounded chunk deque: append work scales with incoming data, not the retained tail. */
export class HeadTailBuffer {
  private headChunks: string[] = [];
  private tailChunks: Array<{ text: string; characters: number }> = [];
  private tailStart = 0;
  private headCharacters = 0;
  private tailCharacters = 0;
  private totalCharacters = 0;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
    this.headLimit = Math.ceil(maxCharacters / 2);
    this.tailLimit = Math.floor(maxCharacters / 2);
  }

  append(output: string): void {
    if (!output) return;
    const length = codePointLength(output);
    this.totalCharacters += length;
    const headCount = Math.min(length, this.headLimit - this.headCharacters);
    const split = codePointIndex(output, headCount);
    if (headCount > 0) {
      const head = output.slice(0, split);
      this.headChunks.push(output.length > this.maxCharacters * 2 ? Buffer.from(head).toString("utf8") : head);
      this.headCharacters += headCount;
    }
    const remaining = length - headCount;
    if (remaining > 0 && this.tailLimit > 0) {
      // A single huge chunk must not be retained just to slice it on the next append.
      const retainedCount = Math.min(remaining, this.tailLimit);
      const tail = takeTail(output.slice(split), retainedCount);
      this.tailChunks.push({ text: output.length > this.maxCharacters * 2 ? Buffer.from(tail).toString("utf8") : tail, characters: retainedCount });
      this.tailCharacters += retainedCount;
      let excess = this.tailCharacters - this.tailLimit;
      while (excess > 0) {
        const first = this.tailChunks[this.tailStart]!;
        const drop = Math.min(first.characters, excess);
        if (drop === first.characters) {
          this.tailChunks[this.tailStart++] = { text: "", characters: 0 };
        }
        else this.tailChunks[this.tailStart] = { text: first.text.slice(codePointIndex(first.text, drop)), characters: first.characters - drop };
        this.tailCharacters -= drop;
        excess -= drop;
      }
      if (this.tailStart > 128 && this.tailStart * 2 > this.tailChunks.length) {
        this.tailChunks = this.tailChunks.slice(this.tailStart);
        this.tailStart = 0;
      }
    }
  }

  hasOutput(): boolean { return this.totalCharacters > 0; }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error("Output limit must be a positive integer.");
    const head = this.headChunks.join("");
    const tail = this.tailChunks.slice(this.tailStart).map((chunk) => chunk.text).join("");
    const omitted = this.totalCharacters - this.headCharacters - this.tailCharacters;
    const retained = formatHeadTail(head, tail, omitted);
    const result = truncateOutput(retained, maxCharacters);
    this.headChunks = [];
    this.tailChunks = [];
    this.tailStart = this.headCharacters = this.tailCharacters = this.totalCharacters = 0;
    return { output: result.output, truncated: omitted > 0 || result.truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  if (codePointLength(output) <= maxCharacters) return { output, truncated: false };
  const marker = "\n... output truncated ...\n";
  if (maxCharacters <= marker.length) return { output: takeHead(marker, maxCharacters), truncated: true };
  const available = maxCharacters - marker.length;
  return { output: takeHead(output, Math.ceil(available / 2)) + marker + takeTail(output, Math.floor(available / 2)), truncated: true };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private nextSessionId = 1;
  private readonly maxSessions: number;
  private readonly defaultMaxOutputTokens: number;
  private shuttingDown = false;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? 16;
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    for (const value of [this.maxBufferCharacters, this.completedSessionTtlMs, this.maxSessions, this.defaultMaxOutputTokens]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Process session budgets must be positive integers.");
    }
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (this.shuttingDown) throw new Error("Process manager is shutting down.");
    if (this.sessions.size >= this.maxSessions) throw new Error("Process session limit reached. Stop or poll existing sessions before starting another command.");
    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_COMMAND_YIELD_MS);
    this.validateOutputLimit(input.maxOutputTokens);
    const session = this.createSession(input);
    this.sessions.set(session.id, session);

    try {
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }

    await this.waitForExit(session, yieldTimeMs);

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    this.validateOutputLimit(input.maxOutputTokens);
    boundedInteger(input.yieldTimeMs, DEFAULT_POLL_YIELD_MS, MAX_POLL_YIELD_MS);
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = this.consume(session, input.maxOutputTokens);
    if (!session.running) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) session.process?.kill("SIGTERM");
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.running) session.process?.kill("SIGTERM");
    }
    await Promise.all(sessions.map((session) => this.waitForExit(session, 1_000)));
    for (const session of sessions) if (session.running) session.process?.kill("SIGKILL");
    this.sessions.clear();
  }

  private validateOutputLimit(limit: number | undefined): void {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Output token budget must be a positive integer.");
  }

  private waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    if (!session.running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        session.exitWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, yieldTimeMs);
      session.exitWaiters.add(done);
    });
  }

  private createSession(input: StartCommandInput): ProcessSession {
    return {
      id: this.nextSessionId++,
      workspaceId: input.workspaceId,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      running: true,
      exitWaiters: new Set(),
    };
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
      }),
      stdio: "pipe",
      windowsHide: true,
      detached,
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.append(session, data));
    child.stderr.on("data", (data: string) => this.append(session, data));
    child.stdin.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommand(input.command);
    let pty: import("node-pty").IPty;
    try {
      pty = nodePty.spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        env: processEnvironment({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
        }),
        name: "xterm-256color",
        cols: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      throw error;
    }

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal) => pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running) return;
    session.running = false;
    session.exitCode = exitCode;
    session.signal = signal;
    for (const done of session.exitWaiters) done();
    session.exitWaiters.clear();
    if (this.shuttingDown || !this.sessions.has(session.id)) return;
    session.cleanupTimer = setTimeout(
      () => this.sessions.delete(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
  }

  private append(session: ProcessSession, output: string): void {
    session.buffer.append(output);
  }

  private consume(session: ProcessSession, maxOutputTokens?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, this.defaultMaxOutputTokens, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);

    return {
      sessionId: session.running ? session.id : undefined,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }
}
