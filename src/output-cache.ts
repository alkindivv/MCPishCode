import { randomBytes } from "node:crypto";

export type CachedOutputKind = "text" | "preview";
interface Entry {
  workspaceId: string;
  kind: CachedOutputKind;
  text: string;
  bytes: number;
  expiresAt: number;
}
export interface OutputCacheOptions {
  maxBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Process-local, workspace-scoped LRU. No files, credentials or source text are logged. */
export class OutputCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private usedBytes = 0;

  constructor(options: OutputCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.maxEntryBytes = options.maxEntryBytes ?? 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 256;
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
    for (const value of [this.maxBytes, this.maxEntryBytes, this.maxEntries, this.ttlMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid output cache budget.");
    }
  }

  get stats(): { entries: number; bytes: number } {
    this.prune();
    return { entries: this.entries.size, bytes: this.usedBytes };
  }

  put(workspaceId: string, text: string, kind: CachedOutputKind = "text"): string | undefined {
    this.prune();
    const bytes = Buffer.byteLength(text, "utf8");
    // Never pretend that a partial value is a complete cached result.
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return undefined;
    while (this.entries.size >= this.maxEntries || this.usedBytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    const id = `out_${randomBytes(16).toString("hex")}`;
    this.entries.set(id, { workspaceId, kind, text, bytes, expiresAt: this.now() + this.ttlMs });
    this.usedBytes += bytes;
    return id;
  }

  get(workspaceId: string, id: string, kind: CachedOutputKind = "text"): string {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.workspaceId !== workspaceId || entry.kind !== kind) {
      throw new Error("Output is unavailable, expired, or belongs to another workspace. Inspect the source again; do not repeat a write operation.");
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.text;
  }

  read(workspaceId: string, id: string, offset = 0, limit = 8_000): {
    text: string; offset: number; nextOffset?: number; totalCharacters: number;
  } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 2) {
      throw new Error("Output offset must be non-negative and limit must be at least 2.");
    }
    const text = this.get(workspaceId, id);
    if (offset > text.length) throw new Error("Output offset is beyond the end of this result.");
    if (offset > 0 && isLowSurrogate(text.charCodeAt(offset)) && isHighSurrogate(text.charCodeAt(offset - 1))) {
      throw new Error("Output offset splits a Unicode character; use the previous nextOffset value.");
    }
    let end = Math.min(text.length, offset + limit);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end--;
    return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : undefined, totalCharacters: text.length };
  }

  clear(): void {
    this.entries.clear();
    this.usedBytes = 0;
  }

  prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.remove(id);
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) this.usedBytes -= entry.bytes;
    this.entries.delete(id);
  }
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
