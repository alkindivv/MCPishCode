import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OutputCache } from "./output-cache.js";
import { ToolResultPolicy, boundedText } from "./output-policy.js";
import { DEFAULT_PERFORMANCE_CONFIG as defaults, loadPerformanceConfig } from "./performance-config.js";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { git } from "./git.js";

let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try { await run(); passed++; }
  catch (error) { throw new Error(`Regression failed: ${name}`, { cause: error }); }
}
const config = { ...defaults };
const text = (value: string) => ({ type: "text" as const, text: value });

await test("configuration budgets and cross-field validation", () => {
  assert.equal(loadPerformanceConfig({}).maxOutputCharacters, 8000);
  assert.equal(loadPerformanceConfig({}).outputMode, "compact");
  for (const value of ["-1", "NaN", "1.5", "999999999"]) {
    assert.throws(() => loadPerformanceConfig({ MCPISHCODE_MAX_OUTPUT_CHARS: value }));
  }
  assert.throws(() => loadPerformanceConfig({ MCPISHCODE_OUTPUT_MODE: "silent" }));
  assert.throws(() => loadPerformanceConfig({ MCPISHCODE_MAX_READ_LINES: "1" }));
  assert.throws(() => loadPerformanceConfig({ MCPISHCODE_OUTPUT_CACHE_BYTES: "4096" }));
});
await test("cache scope, kind isolation, TTL and accounting", () => {
  let now = 1;
  const cache = new OutputCache({ maxBytes: 30, maxEntryBytes: 20, ttlMs: 100, now: () => now });
  const first = cache.put("ws", "abc")!;
  assert.equal(cache.get("ws", first), "abc");
  assert.throws(() => cache.get("other", first));
  assert.throws(() => cache.get("ws", first, "preview"));
  assert.equal(cache.put("ws", "x".repeat(21)), undefined);
  assert.deepEqual(cache.stats, { entries: 1, bytes: 3 });
  now = 101;
  assert.throws(() => cache.get("ws", first));
  assert.deepEqual(cache.stats, { entries: 0, bytes: 0 });
});
await test("cache LRU eviction does not extend fixed TTL", () => {
  let now = 0;
  const cache = new OutputCache({ maxBytes: 10, maxEntryBytes: 10, maxEntries: 2, ttlMs: 100, now: () => now });
  const a = cache.put("ws", "aaaa")!;
  const b = cache.put("ws", "bbbb")!;
  now = 50; cache.get("ws", a);
  const c = cache.put("ws", "cccc")!;
  assert.throws(() => cache.get("ws", b));
  assert.equal(cache.get("ws", c), "cccc");
  now = 100; assert.throws(() => cache.get("ws", a));
  cache.clear(); assert.equal(cache.stats.bytes, 0);
});
await test("Unicode pagination reconstructs exactly with monotonically increasing cursors", () => {
  const cache = new OutputCache();
  const source = "A\u{1f600}BC\u{10000}D";
  const id = cache.put("ws", source)!;
  let offset = 0; let reconstructed = "";
  for (;;) {
    const page = cache.read("ws", id, offset, 2);
    reconstructed += page.text;
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.equal(reconstructed, source);
  assert.throws(() => cache.read("ws", id, 2, 2), /Unicode/);
  assert.throws(() => cache.read("ws", id, -1, 2));
  assert.throws(() => cache.read("ws", id, 100, 2));
});
await test("one model-visible text copy, no metadata in off mode", () => {
  const policy = new ToolResultPolicy(new OutputCache(), config);
  const result = policy.format({ content: [text("hello")], structuredContent: { result: "hello" },
    details: { secret: "not a result contract" }, _meta: { tool: "read", card: { payload: { content: [text("hello")] } } } }, { workspaceId: "ws", widget: false });
  assert.equal(JSON.stringify(result).match(/hello/g)?.length, 1);
  assert.equal(result.structuredContent?.result, "ok");
  assert.equal(result._meta, undefined); assert.equal(result.details, undefined);
});
await test("errors preserve status and terminal escape sequences are removed", () => {
  const policy = new ToolResultPolicy(new OutputCache(), config);
  const result = policy.format({ content: [text("\x1b[31mfailed\x1b[0m")], isError: true, structuredContent: { result: "failed" } }, { workspaceId: "ws", widget: false });
  assert.equal(result.isError, true); assert.equal(result.structuredContent?.result, "error");
  assert.deepEqual(result.content, [text("failed")]);
});
await test("long text has a hard display budget and recoverable retained source", () => {
  const cache = new OutputCache(); const policy = new ToolResultPolicy(cache, config);
  const source = "BEGIN\n" + "0123456789".repeat(9000) + "\nEND";
  const result = policy.format({ content: [text(source)], structuredContent: { result: source } }, { workspaceId: "ws", widget: false });
  const display = result.content[0]; assert.equal(display.type, "text");
  if (display.type !== "text") throw new Error("Expected text");
  assert.ok(display.text.length <= 8000); assert.match(display.text, /read_output/);
  assert.equal(result.structuredContent?.outputTruncated, true);
  assert.equal(cache.get("ws", String(result.structuredContent?.outputId)), source);
});
await test("oversize retention refuses full recovery rather than silently caching a fragment", () => {
  const policy = new ToolResultPolicy(new OutputCache({ maxEntryBytes: 1024 }), config);
  const result = policy.format({ content: [text("x".repeat(20_000))], structuredContent: { result: "ok" } }, { workspaceId: "ws", widget: false });
  assert.equal(result.structuredContent?.outputId, undefined);
  assert.match(JSON.stringify(result), /exceeds cache capacity/);
});
await test("legacy text mode preserves old verbose model contract explicitly", () => {
  const policy = new ToolResultPolicy(new OutputCache(), { ...config, outputMode: "legacy" });
  const result = policy.format({ content: [text("verbose")], structuredContent: { result: "verbose" } }, { workspaceId: "ws", widget: false });
  assert.equal(result.structuredContent?.result, "verbose");
});
await test("preview is a lazy workspace-scoped reference, not embedded patch text", () => {
  const cache = new OutputCache(); const policy = new ToolResultPolicy(cache, config);
  const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
  const result = policy.format({ content: [text("Edited a")], structuredContent: { result: "Edited a" },
    _meta: { tool: "edit", card: { workspaceId: "ws", payload: { patch } } } }, { workspaceId: "ws", widget: true });
  assert.ok(!JSON.stringify(result).includes("diff --git"));
  const card = result._meta?.card as Record<string, unknown>;
  assert.equal(card.payload, undefined);
  const preview = JSON.parse(cache.get("ws", String(card.payloadRef), "preview"));
  assert.equal(preview.patch, patch);
});
await test("oversize patch is omitted whole, never fed as a chopped diff to a renderer", () => {
  const cache = new OutputCache(); const policy = new ToolResultPolicy(cache, config);
  const result = policy.format({ content: [text("ok")], _meta: { tool: "show_changes", card: { payload: { patch: "x".repeat(30_000) } } } }, { workspaceId: "ws", widget: true });
  const card = result._meta?.card as Record<string, unknown>;
  const preview = JSON.parse(cache.get("ws", String(card.payloadRef), "preview"));
  assert.equal(preview.patch, undefined); assert.match(preview.message, /omitted/);
});
await test("image output remains usable without a second base64 metadata copy", () => {
  const policy = new ToolResultPolicy(new OutputCache(), config);
  const image = { type: "image" as const, mimeType: "image/png", data: "YWJj" };
  const result = policy.format({ content: [image], _meta: { tool: "read", card: { payload: { content: [image] } } } }, { workspaceId: "ws", widget: true });
  assert.equal(result.content[0], image); assert.equal(JSON.stringify(result).match(/YWJj/g)?.length, 1);
});
await test("workspace instructions are explicit on-demand reads, catalogs bounded with recovery", () => {
  const cache = new OutputCache(); const policy = new ToolResultPolicy(cache, config);
  const result = policy.format({ content: [text("opened")], structuredContent: {
    workspaceId: "ws", root: "/project", mode: "checkout", agentsFiles: [{ path: "AGENTS.md", content: "PRIVATE_BODY".repeat(10_000) }],
    skills: Array.from({ length: 60 }, (_, i) => ({ name: `skill${i}`, description: "d".repeat(1000), path: `/skills/${i}/SKILL.md` })),
    agents: [], agentProviders: [], availableAgentsFiles: [], skillDiagnostics: [], instruction: "old",
  } }, { workspaceId: "ws", widget: false });
  assert.ok(!JSON.stringify(result).includes("PRIVATE_BODY"));
  const structured = result.structuredContent!;
  assert.ok(JSON.stringify(structured).length < 8500);
  assert.equal((structured.agentsFiles as Array<{ needsRead: boolean }>)[0]!.needsRead, true);
  assert.equal(structured.contextTruncated, true);
  const catalog = JSON.parse(cache.get("ws", String(structured.contextOutputId)));
  assert.equal(catalog.skills.length, 60); assert.equal(catalog.agentsFiles[0].needsRead, true);
});
await test("text budgets never split valid surrogate pairs", () => {
  for (let budget = 1; budget < 100; budget++) {
    const value = boundedText("\u{1f600}".repeat(100), budget);
    assert.ok(value.length <= budget); assert.equal(Buffer.from(value, "utf8").toString("utf8"), value);
  }
});
await test("head-tail buffer preserves small output and resets completely", () => {
  const buffer = new HeadTailBuffer(30);
  buffer.append("hello"); buffer.append(" \u{1f600}");
  assert.deepEqual(buffer.drain(100), { output: "hello \u{1f600}", truncated: false });
  assert.deepEqual(buffer.drain(100), { output: "", truncated: false });
});
await test("head-tail overflow retains head and latest tail across many chunks", () => {
  const buffer = new HeadTailBuffer(100);
  buffer.append("BEGIN" + "x".repeat(100_000));
  for (let i = 0; i < 1000; i++) buffer.append("\u{1f600}");
  buffer.append("END");
  const result = buffer.drain(256);
  assert.equal(result.truncated, true); assert.ok(result.output.startsWith("BEGIN")); assert.ok(result.output.endsWith("END"));
  assert.ok([...result.output].length <= 256); assert.equal(Buffer.from(result.output, "utf8").toString("utf8"), result.output);
});
await test("tiny and invalid buffer budgets are handled", () => {
  assert.throws(() => new HeadTailBuffer(0));
  const buffer = new HeadTailBuffer(1); buffer.append("abc");
  assert.equal(buffer.drain(1).truncated, true);
});

const temp = await mkdtemp(join(tmpdir(), "mcpishcode-performance-test-"));
try {
  await test("dot-dot-prefixed ordinary names remain legal", async () => {
    await mkdir(join(temp, "..notes"));
    assert.equal(isPathInsideRoot(join(temp, "..notes"), temp), true);
    assert.equal(assertAllowedPath(join(temp, "..notes", "file"), [temp]), join(temp, "..notes", "file"));
  });
  if (process.platform !== "win32") {
    await test("existing, new and dangling symlink escapes are rejected", async () => {
      const workspace = join(temp, "workspace"); const outside = join(temp, "outside");
      await mkdir(workspace); await mkdir(outside); await writeFile(join(outside, "secret"), "secret");
      await symlink(outside, join(workspace, "escape"));
      await symlink(join(outside, "missing"), join(workspace, "dangling"));
      assert.throws(() => assertAllowedPath(join(workspace, "escape", "secret"), [workspace]));
      assert.throws(() => assertAllowedPath(join(workspace, "escape", "new"), [workspace]));
      assert.throws(() => assertAllowedPath(join(workspace, "dangling"), [workspace]));
      await mkdir(join(workspace, "inside")); await symlink("inside", join(workspace, "safe"));
      assert.doesNotThrow(() => assertAllowedPath(join(workspace, "safe", "new"), [workspace]));
    });
  }
  const command = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
  await test("pipe output decodes split UTF-8 and preserves exit code", async () => {
    const manager = new ProcessSessionManager();
    try {
      const snapshot = await manager.start({ workspaceId: "ws", cwd: temp,
        command: command("process.stdout.write(Buffer.from([240,159])); setTimeout(()=>{process.stdout.write(Buffer.from([152,128]));process.exitCode=3},20)"),
      });
      assert.equal(snapshot.output, "\u{1f600}"); assert.equal(snapshot.exitCode, 3); assert.equal(snapshot.running, false);
    } finally { await manager.shutdown(); }
  });
  await test("process validation happens before command side effects", async () => {
    const manager = new ProcessSessionManager();
    try {
      await assert.rejects(() => manager.start({ workspaceId: "ws", cwd: temp,
        command: command("require('fs').writeFileSync('SHOULD_NOT_EXIST','x')"), maxOutputTokens: -1 }));
      assert.equal(existsSync(join(temp, "SHOULD_NOT_EXIST")), false);
    } finally { await manager.shutdown(); }
  });
  await test("process cap, ownership, polling waiter cleanup and shutdown", async () => {
    const manager = new ProcessSessionManager({ maxSessions: 1 });
    try {
      const input = { workspaceId: "ws", cwd: temp, command: command("setInterval(()=>{},1000)"), yieldTimeMs: 0 };
      const first = await manager.start(input); assert.ok(first.sessionId);
      await assert.rejects(() => manager.start(input), /limit reached/);
      await assert.rejects(() => manager.write({ workspaceId: "other", sessionId: first.sessionId! }), /workspace/);
      for (let i = 0; i < 30; i++) await manager.write({ workspaceId: "ws", sessionId: first.sessionId!, yieldTimeMs: 0 });
      const internals = manager as unknown as { sessions: Map<number, { exitWaiters: Set<unknown> }> };
      assert.equal(internals.sessions.get(first.sessionId!)!.exitWaiters.size, 0);
    } finally { await manager.shutdown(); }
    await assert.rejects(() => manager.start({ workspaceId: "ws", cwd: temp, command: "echo fail" }), /shutting down/);
  });
  await test("review initialization is serialized; scopes, renames, file types, binary and index isolation", async () => {
    const repository = join(temp, "repo"); const root = join(repository, "project[1]");
    await mkdir(root, { recursive: true });
    await writeFile(join(repository, "sibling.txt"), "initial\n");
    await writeFile(join(root, "a.txt"), "hello\nkeep\n");
    await writeFile(join(root, "gone.txt"), "delete me\n");
    await writeFile(join(root, "rename.txt"), "same\n".repeat(50));
    await git(repository, ["init"]); await git(repository, ["config", "user.email", "test@example.test"]);
    await git(repository, ["config", "user.name", "Test"]); await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "initial"]);
    const indexBefore = await readFile(join(repository, ".git", "index"));
    const manager = createReviewCheckpointManager({ maxPatchCharacters: 2000 });
    try {
      const initialized = manager.initializeWorkspace({ workspaceId: "ws", root });
      const first = manager.reviewChanges({ workspaceId: "ws", root });
      await initialized; assert.equal((await first).summary.files, 0);
      await writeFile(join(repository, "sibling.txt"), "OUTSIDE_SECRET\n");
      await writeFile(join(root, "a.txt"), "hello\nkeep\nadded\n");
      await rm(join(root, "gone.txt")); await rename(join(root, "rename.txt"), join(root, "renamed.txt"));
      await writeFile(join(root, "new.txt"), "new\n"); await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 4]));
      const changed = await manager.reviewChanges({ workspaceId: "ws", root, markReviewed: false });
      assert.equal(changed.summary.files, 5);
      assert.equal(changed.files.find((f) => f.path === "a.txt")?.type, "change");
      assert.equal(changed.files.find((f) => f.path === "gone.txt")?.type, "deleted");
      assert.equal(changed.files.find((f) => f.path === "new.txt")?.type, "new");
      assert.equal(changed.files.find((f) => f.path === "renamed.txt")?.previousPath, "rename.txt");
      assert.ok(!changed.patch.includes("GIT binary patch")); assert.ok(!changed.patch.includes("OUTSIDE_SECRET"));
      assert.ok(!changed.files.some((f) => f.path.includes("sibling")));
      assert.deepEqual(await readFile(join(repository, ".git", "index")), indexBefore);
      await manager.reviewChanges({ workspaceId: "ws", root });
      assert.equal((await manager.reviewChanges({ workspaceId: "ws", root })).summary.files, 0);
      await writeFile(join(root, "large.txt"), "LARGE_CHANGE\n".repeat(3000));
      const big = await manager.reviewChanges({ workspaceId: "ws", root });
      assert.equal(big.previewOmitted, true); assert.equal(big.patch, ""); assert.match(big.result, /omitted/);
    } finally { await manager.close(); }
    assert.equal((await git(repository, ["for-each-ref", "refs/mcpishcode/review/"])).stdout.trim(), "");
  });
} finally { await rm(temp, { recursive: true, force: true }); }

await test("source wiring: all widgets collapsed, app-only fetch, no invalid optional Zod max chain", () => {
  const server = readFileSync(join(process.cwd(), "src", "server.ts"), "utf8");
  const ui = readFileSync(join(process.cwd(), "src", "ui", "workspace-app.tsx"), "utf8");
  assert.match(server, /visibility: \["app"\]/);
  assert.match(server, /await reviewCheckpoints\.initializeWorkspace/);
  assert.doesNotMatch(server, /\.optional\(\)\s*\.max\(budgets/);
  assert.match(ui, /expanded = false; \/\/ Never mount/);
  assert.match(ui, /app\.callServerTool/);
  assert.match(ui, /targetCard !== card/);
});
console.log(`PASS ${passed} performance regression groups`);
