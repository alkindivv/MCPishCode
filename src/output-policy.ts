import { stripVTControlCharacters } from "node:util";
import { OutputCache } from "./output-cache.js";
import type { PerformanceConfig } from "./performance-config.js";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
export interface ToolResultInput {
  [key: string]: unknown;
  content: Array<TextBlock | ImageBlock>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
  details?: unknown;
}
export interface ResultContext { workspaceId: string; widget: boolean; }

/** Slice UTF-16 without producing broken surrogate pairs. Budgets are not token counts. */
export function textHead(text: string, limit: number): string {
  let end = Math.max(0, Math.min(text.length, limit));
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!)) end--;
  return text.slice(0, end);
}
function textTail(text: string, limit: number): string {
  let start = Math.max(0, text.length - Math.max(0, limit));
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!) && /[\uD800-\uDBFF]/u.test(text[start - 1]!)) start++;
  return text.slice(start);
}
export function boundedText(text: string, limit: number, marker = "\n[Output truncated]\n"): string {
  if (text.length <= limit) return text;
  if (marker.length >= limit) return textHead(marker, limit);
  const remaining = limit - marker.length;
  return textHead(text, Math.ceil(remaining / 2)) + marker + textTail(text, Math.floor(remaining / 2));
}

export class ToolResultPolicy {
  constructor(readonly cache: OutputCache, readonly config: PerformanceConfig) {}

  format(input: ToolResultInput, context: ResultContext): ToolResultInput {
    const compact = this.config.outputMode === "compact";
    const rawText = input.content.filter((item): item is TextBlock => item.type === "text").map((item) => item.text).join("\n");
    const text = compact ? stripVTControlCharacters(rawText) : rawText;
    const limited = compact && text.length > this.config.maxOutputCharacters;
    const outputId = limited ? this.cache.put(context.workspaceId, text) : undefined;
    const marker = outputId
      ? `\n[Output truncated. Read retained result with read_output(workspaceId, outputId="${outputId}", offset=0). Upstream truncation, if any, is not recoverable here.]\n`
      : "\n[Output truncated; this result exceeds cache capacity. Narrow the source query or inspect an existing log file. Do not repeat a write operation.]\n";
    const displayText = limited ? boundedText(text, this.config.maxOutputCharacters, marker) : text;
    const content: Array<TextBlock | ImageBlock> = displayText ? [{ type: "text", text: displayText }] : [];
    // Explicit image reads remain real image results. Never duplicate base64 into UI metadata.
    content.push(...input.content.filter((item): item is ImageBlock => item.type === "image"));
    let structured = input.structuredContent ? { ...input.structuredContent } : undefined;
    if (compact && structured && Array.isArray(structured.agentsFiles)) {
      structured = this.workspaceContext(structured, context.workspaceId);
    }
    if (compact && structured && typeof structured.result === "string") {
      structured.result = input.isError ? "error" : "ok";
    }
    if (limited && structured) {
      structured.outputTruncated = true;
      if (outputId) structured.outputId = outputId;
    }
    const result: ToolResultInput = {
      content,
      ...(structured ? { structuredContent: structured } : {}),
      ...(input.isError === undefined ? {} : { isError: input.isError }),
    };
    // No hidden payloads, card objects or visual resources in off mode.
    if (context.widget && input._meta) result._meta = this.previewMetadata(input._meta, context.workspaceId);
    return result;
  }

  /** Instruction contents are not silently shortened: explicitly require a bounded read. */
  private workspaceContext(source: Record<string, unknown>, workspaceId: string): Record<string, unknown> {
    const context = { ...source };
    const fields = ["agentsFiles", "availableAgentsFiles", "skills", "agents", "agentProviders", "skillDiagnostics", "contextDiagnostics"];
    const counts: Record<string, number> = {};
    let omitted = false;
    for (const field of fields) {
      const values = Array.isArray(source[field]) ? source[field] as unknown[] : [];
      counts[field] = values.length;
      if (values.length > this.config.maxContextEntries) omitted = true;
      context[field] = values.slice(0, this.config.maxContextEntries).map((value) => {
        const record = asRecord(value);
        if (!record) return typeof value === "string" ? textHead(value, 240) : value;
        if (field === "agentsFiles") return { path: record.path, content: "", needsRead: true };
        if (field === "skillDiagnostics") return { message: textHead(JSON.stringify(record), 240) };
        return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
          typeof item === "string" && key !== "path" && key !== "name" ? textHead(item, 240) : item,
        ]));
      });
    }
    context.contextCounts = counts;
    context.instruction = "Reuse workspaceId. Read every agentsFiles path before work; their contents are intentionally not inlined. Read applicable nested instructions and matching skills before using their scope. Discovery may skip dependency/build directories or stop at its budget: check ancestor instruction files for every path you modify. If contextTruncated is true, page through contextOutputId with read_output before relying on this incomplete catalog.";
    // Retain the complete metadata catalog without copying large root instruction bodies.
    const catalog = { ...source, agentsFiles: (source.agentsFiles as unknown[]).map((value) => {
      const file = asRecord(value); return { path: file?.path, needsRead: true };
    }) };
    for (const field of ["skillDiagnostics", "agents", "skills", "availableAgentsFiles", "agentProviders"]) {
      const values = context[field] as unknown[];
      while (values.length && JSON.stringify(context).length > this.config.maxOutputCharacters) { values.pop(); omitted = true; }
    }
    context.contextTruncated = omitted;
    if (omitted) {
      const id = this.cache.put(workspaceId, JSON.stringify(catalog));
      if (id) context.contextOutputId = id;
      else context.instruction += " Full catalog exceeds retention capacity; narrow discovery on the host. Do not assume omitted instructions or skills do not exist.";
    }
    return context;
  }

  private previewMetadata(meta: Record<string, unknown>, workspaceId: string): Record<string, unknown> {
    const sourceCard = asRecord(meta.card);
    if (!sourceCard) return { tool: meta.tool };
    const card = { ...sourceCard };
    delete card.payload;
    if (Array.isArray(card.files)) {
      if (card.files.length > this.config.maxContextEntries) card.filesTruncated = true;
      card.files = card.files.slice(0, this.config.maxContextEntries);
    }
    // Input commands can themselves contain large scripts. Keep only a short label.
    const summary = asRecord(card.summary);
    if (summary) card.summary = Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, typeof value === "string" ? textHead(value, 240) : value]));
    const sourcePayload = asRecord(sourceCard.payload);
    if (sourcePayload) {
      const payload = this.preparePreview(sourcePayload);
      const ref = this.cache.put(workspaceId, JSON.stringify(payload), "preview");
      if (ref) card.payloadRef = ref;
      else card.payload = { message: "Preview exceeds the cache budget. Inspect the source with a bounded read." };
    }
    return { tool: meta.tool, card };
  }

  private preparePreview(source: Record<string, unknown>): Record<string, unknown> {
    const limit = this.config.maxPreviewCharacters;
    // A chopped patch is not a valid diff. Show an honest fallback instead.
    const patch = typeof source.patch === "string" ? source.patch : typeof source.diff === "string" ? source.diff : undefined;
    if (patch !== undefined) {
      if (patch.length > limit) return { message: `Diff preview omitted (${patch.length} characters; limit ${limit}). Inspect individual files or a scoped git diff.` };
      return { patch };
    }
    if (Array.isArray(source.content)) {
      const text = source.content.map((item) => asRecord(item)).filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item!.text as string).join("\n");
      return { content: [{ type: "text", text: boundedText(stripVTControlCharacters(text), limit) }] };
    }
    if (typeof source.message === "string") return { message: boundedText(source.message, limit) };
    return {};
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
