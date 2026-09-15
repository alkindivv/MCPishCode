import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

export type ReviewSince = "last_shown" | "last_review" | "workspace_open";
export interface ReviewSummary { files: number; additions: number; removals: number; }
export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}
export interface ReviewChangesResult {
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
  previewOmitted?: boolean;
  previewMessage?: string;
}
interface WorkspaceReviewState {
  root: string;
  gitRoot?: string;
  openRef: string;
  baselineRef: string;
  diagnostic?: string;
}
export interface ReviewCheckpointManager {
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<void>;
  reviewChanges(input: { workspaceId: string; root: string; since?: ReviewSince; markReviewed?: boolean }): Promise<ReviewChangesResult>;
  close(): Promise<void>;
}

/** Private tree refs avoid touching the user's real index or creating repeated commit objects. */
export function createReviewCheckpointManager(options: { maxPatchCharacters?: number } = {}): ReviewCheckpointManager {
  const maxPatchCharacters = options.maxPatchCharacters ?? 24_000;
  const states = new Map<string, WorkspaceReviewState>();
  const queues = new Map<string, Promise<void>>();
  const owner = randomUUID();
  let closePromise: Promise<void> | undefined;

  function serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (closePromise) return Promise.reject(new Error("Review checkpoint manager is closed."));
    const task = (queues.get(id) ?? Promise.resolve()).then(operation);
    const settled = task.then(() => undefined, () => undefined);
    queues.set(id, settled);
    void settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return task;
  }

  async function initialize(workspaceId: string, root: string): Promise<WorkspaceReviewState> {
    const existing = states.get(workspaceId);
    if (existing) {
      if (existing.root !== root) throw new Error("Workspace root changed for an existing review checkpoint.");
      return existing;
    }
    const prefix = `refs/mcpishcode/review/${owner}/${safeWorkspaceRefSegment(workspaceId)}`;
    const state: WorkspaceReviewState = { root, openRef: `${prefix}/open`, baselineRef: `${prefix}/baseline` };
    states.set(workspaceId, state);
    try {
      const eligibility = await getGitEligibility(root);
      if (!eligibility.ok || !eligibility.gitRoot) {
        state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace with a HEAD commit.";
        return state;
      }
      state.gitRoot = eligibility.gitRoot;
      const tree = await createWorkingTreeSnapshot(state.gitRoot, root);
      await git(state.gitRoot, ["update-ref", state.openRef, tree]);
      await git(state.gitRoot, ["update-ref", state.baselineRef, tree]);
    } catch (error) {
      state.diagnostic = error instanceof Error ? error.message : String(error);
    }
    return state;
  }

  return {
    initializeWorkspace: ({ workspaceId, root }) => serial(workspaceId, async () => { await initialize(workspaceId, root); }),
    reviewChanges: ({ workspaceId, root, since = "last_shown", markReviewed = true }) => serial(workspaceId, async () => {
      const state = await initialize(workspaceId, root);
      if (!state.gitRoot || state.diagnostic) throw new Error(state.diagnostic ?? "show_changes requires Git.");
      const baselineRef = since === "workspace_open" ? state.openRef : state.baselineRef;
      const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{tree}`])).stdout.trim();
      const current = await createWorkingTreeSnapshot(state.gitRoot, root);
      const scope = relative(state.gitRoot, root).split(sep).join("/") || ".";
      // Explicit literal pathspec prevents metacharacters in a directory name widening the review scope.
      const common = [...(scope === "." ? [] : [`--relative=${scope}`]), "--no-ext-diff", "--no-textconv", "--find-renames", baseline, current, "--", `:(literal)${scope}`];
      const [numstat, status] = await Promise.all([
        git(state.gitRoot, ["diff", "--numstat", "-z", ...common], { maxBuffer: 4 * 1024 * 1024 }),
        git(state.gitRoot, ["diff", "--name-status", "-z", ...common], { maxBuffer: 4 * 1024 * 1024 }),
      ]);
      const files = parseNumstat(numstat.stdout, status.stdout, scope);
      const summary = files.reduce<ReviewSummary>((sum, file) => ({
        files: sum.files + 1, additions: sum.additions + file.additions, removals: sum.removals + file.removals,
      }), { files: 0, additions: 0, removals: 0 });
      let patch = "";
      let previewOmitted = false;
      if (summary.files > 0) {
        try {
          // No --binary: embedding binary blobs in a chat diff serves no review purpose.
          patch = (await git(state.gitRoot, ["diff", "--no-color", ...common], {
            maxBuffer: Math.max(4096, maxPatchCharacters * 4),
          })).stdout;
          if (patch.length > maxPatchCharacters) { patch = ""; previewOmitted = true; }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
          previewOmitted = true;
        }
      }
      if (markReviewed) await git(state.gitRoot, ["update-ref", state.baselineRef, current]);
      const previewMessage = previewOmitted ? "Diff preview omitted because it exceeds the preview budget. Inspect individual files or a scoped git diff." : undefined;
      return {
        result: (summary.files === 0
          ? `No changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
          : `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`) + (previewMessage ? ` ${previewMessage}` : ""),
        summary, files, patch, ...(previewOmitted ? { previewOmitted, previewMessage } : {}),
      };
    }),
    close() {
      if (!closePromise) closePromise = (async () => {
        await Promise.all(queues.values());
        await Promise.all([...states.values()].map(async (state) => {
          if (!state.gitRoot) return;
          await Promise.all([state.openRef, state.baselineRef].map((ref) => git(state.gitRoot!, ["update-ref", "-d", ref])));
        }));
        states.clear();
      })();
      return closePromise;
    },
  };
}

async function createWorkingTreeSnapshot(gitRoot: string, workspaceRoot: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcpishcode-review-index-"));
  const env = { GIT_INDEX_FILE: join(directory, "index") };
  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    // Run from the opened folder, not the enclosing repository: never snapshot changed siblings.
    await git(workspaceRoot, ["add", "-A", "--", "."], { env });
    return (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseNumstat(output: string, statusOutput: string, scope: string): ReviewFile[] {
  const statuses = new Map<string, string>();
  const statusFields = statusOutput.split("\0");
  for (let index = 0; index < statusFields.length - 1;) {
    const status = statusFields[index++]!;
    const first = statusFields[index++];
    const path = /^[RC]/u.test(status) ? statusFields[index++] : first;
    if (path) statuses.set(path, status);
  }
  const fields = output.split("\0");
  const files: ReviewFile[] = [];
  const local = (path: string): string => scope !== "." && path.startsWith(`${scope}/`) ? path.slice(scope.length + 1) : path;
  for (let index = 0; index < fields.length - 1;) {
    const header = fields[index++]!;
    // Split only the two numeric columns; Git filenames may themselves contain tabs.
    const firstTab = header.indexOf("\t");
    const secondTab = header.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additions = statNumber(header.slice(0, firstTab));
    const removals = statNumber(header.slice(firstTab + 1, secondTab));
    let path = header.slice(secondTab + 1);
    let previousPath: string | undefined;
    if (!path) { previousPath = fields[index++]; path = fields[index++] ?? ""; }
    if (!path) continue;
    const status = statuses.get(path) ?? "M";
    const type: ReviewFile["type"] = previousPath
      ? (additions === 0 && removals === 0 ? "rename-pure" : "rename-changed")
      : status.startsWith("A") ? "new" : status.startsWith("D") ? "deleted" : "change";
    files.push({ path: local(path), ...(previousPath ? { previousPath: local(previousPath) } : {}), type, additions, removals });
  }
  return files;
}
function statNumber(value: string): number { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0; }
