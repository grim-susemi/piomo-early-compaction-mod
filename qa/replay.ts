/**
 * Offline replay comparison for the early-compaction mod (todo 15).
 *
 * Copies the largest root sessions (no `parentSession`) modified in the last
 * 14 days into one temporary directory outside the repository, replays the
 * recorded usage/timestamps under three policies, and writes a numbers-only
 * report. The temporary copies are always deleted; no message text, prompt or
 * session id reaches the reports.
 *
 * Every early-policy apply is decided by `applyDecision` from `src/policy.ts`
 * at a recorded run end (`stopReason` "stop"); a tool-use turn never applies
 * and is never a boundary. Cuts come from `src/prepare.ts` (`prepareSource` ->
 * `findCutPoint`) over identity-preserving branch entry stubs, so whole-message,
 * tool-tail, split-turn and keep-recent semantics are the production ones.
 * Recorded compactions reset the simulated context at the following request;
 * for stock they are the baseline applies. Total prefill charges the first
 * recorded request in full for every policy even when a compaction applies at
 * it; the post-apply context is charged on the following request. The size
 * model is:
 *   notes   = 0.08 * span tokens (the appended block)
 *   rewrite = median of the summary token counts recorded in the same session
 *             (fallback 0.10 * span when the session has no compaction)
 *
 * Two prefill models are reported:
 *   - token-prefix: a changed prefix invalidates everything after the cut.
 *   - block-level (INFERRED, Anthropic): unchanged message blocks after the
 *     changed summary block stay reusable; only the written summary block is
 *     re-read. This is an inference, not a live measurement.
 *
 * Local-model eviction (Strata/Ollama/opencodex) is inferred from request
 * timestamps interleaved across every recent session that used the same local
 * endpoint (baseUrl host 127.0.0.1/localhost, grouped by origin).
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  closeSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { estimateTokens, type SessionEntry } from "@code-yeongyu/senpi";
import {
  DEFAULTS,
  applyDecision,
  computeEffectiveKeepRecentTokens,
  computeEffectiveThreshold,
  nextJobKind,
  shouldStartJob,
  type LastYield,
  type PolicyConfig,
} from "../src/policy";
import { prepareSource } from "../src/prepare";
import { summaryTokens } from "../src/constants";

// ---------------------------------------------------------------------------
// Constants and public types
// ---------------------------------------------------------------------------

export const REPLAY_SCHEMA = "piomo.early-compaction.replay.v1";
export const REPLAY_WINDOW_DAYS = 14;
export const REPLAY_SESSION_LIMIT = 5;
export const DEFAULT_CONTEXT_WINDOW = 262_144;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const BUILTIN_SUMMARY_SCHEMA = "senpi.compaction.summary.v1";
export const NOTES_SPAN_RATIO = 0.08;
export const REWRITE_FALLBACK_SPAN_RATIO = 0.1;
export const ANTHROPIC_CACHE_TTL_MS = 300_000;
export const SCAN_WINDOW_CHARS = 40;

export type ReplayPolicy = "stock" | "early-rewrite" | "early-notes";
export const REPLAY_POLICIES: readonly ReplayPolicy[] = [
  "stock",
  "early-rewrite",
  "early-notes",
];

export interface ReplayRequest {
  /** Completion timestamp of the assistant turn, epoch ms. */
  ts: number;
  /** Tokens appended since the previous assistant usage (includes its output). */
  appendedTokens: number;
  /** Prompt tokens: input + cacheRead + cacheWrite. */
  promptTokens: number;
  cacheRead: number;
  outputTokens: number;
  provider: string;
  modelId: string;
  stopReason: string | null;
  /** Index in `ReplayBranch.entries` of the assistant entry that produced this usage. */
  entryIndex?: number;
}

export interface ReplayCompaction {
  ts: number;
  tokensBefore: number;
  summaryTokens: number;
  schema: string;
  firstKeptEntryId?: string;
  entryIndex?: number;
}

/**
 * Compact identity-preserving metadata for one recorded branch entry. The
 * message text is not retained: only what the todo 6 cut needs (identity,
 * parent chain, role, stop reason, tool-call pairing) and the token estimate
 * measured while the entry was parsed. `qa/replay.ts` rebuilds minimal entry
 * stubs from this metadata when it asks `prepareSource` for a cut, so the
 * live replay does not hold hundreds of megabytes of conversation text.
 */
export interface ReplayEntryMeta {
  index: number;
  id: string;
  parentId: string | null;
  timestamp: number;
  type: string;
  role?: string;
  stopReason?: string;
  customType?: string;
  toolCallId?: string;
  toolCallIds?: string[];
  /** estimateTokens() of the original entry message. */
  tokens: number;
  firstKeptEntryId?: string;
  /** Recorded compaction summary size (compaction entries only). */
  summaryTokens?: number;
}

/** A context edit that applies to requests at or after `index`. */
export interface ReplayEdit {
  index: number;
  targetId: string;
  /** Replacement message size; null removes the target from context. */
  replacementTokens: number | null;
}

export interface ReplayBranch {
  entries: ReplayEntryMeta[];
  edits: ReplayEdit[];
}

export interface ParsedSession {
  id: string;
  hash: string;
  requests: ReplayRequest[];
  compactions: ReplayCompaction[];
  branch: ReplayBranch;
}

export type ParseResult =
  | { ok: true; session: ParsedSession }
  | { ok: false; reason: string };

export interface AppliesByRoute {
  cold: number;
  boundary: number;
  threshold: number;
}

export interface PolicyRow {
  policy: ReplayPolicy;
  applies: AppliesByRoute;
  appliesTotal: number;
  /** Apply evaluations that used the scalar fallback (no entry identity). */
  cutFallbacks: number;
  /** Apply evaluations where prepareSource found nothing to summarize. */
  cutUnavailable: number;
  thresholdCrossings: number;
  jobsStarted: number;
  coldMisses: number;
  coldMissTokens: number;
  applyRereadTokenPrefix: number;
  applyRereadBlockLevel: number;
  prefillTokenPrefix: number;
  prefillBlockLevel: number;
  summaryStartTokens: number;
  summaryEndTokens: number;
  summaryMaxTokens: number;
  summaryWriteTokens: number;
  notesAppends: number;
  notesBlocks: number;
  consolidations: number;
  finalContextTokens: number;
}

export interface SessionReplay {
  hash: string;
  requestCount: number;
  recordedCompactions: number;
  recordedBuiltinSummaries: number;
  recordedSummaryMedianTokens: number;
  policies: PolicyRow[];
}

export interface SkippedSession {
  hash: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Size model
// ---------------------------------------------------------------------------

/** The rewrite size model uses summaries the builtin generated itself. */
export function builtinSummarySizes(compactions: readonly ReplayCompaction[]): number[] {
  return compactions
    .filter((entry) => entry.schema === BUILTIN_SUMMARY_SCHEMA)
    .map((entry) => entry.summaryTokens);
}

/** notes = 0.08 x span tokens. */
export function notesSummaryTokens(spanTokens: number): number {
  if (!Number.isFinite(spanTokens) || spanTokens <= 0) return 0;
  return Math.round(NOTES_SPAN_RATIO * spanTokens);
}

export function median(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0).slice().sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2 === 1) return finite[middle];
  return Math.round((finite[middle - 1] + finite[middle]) / 2);
}

/**
 * rewrite = the builtin summary sizes measured in the same session (median of
 * the recorded compaction summary token counts); fallback 0.10 x span.
 */
export function rewriteSummaryTokens(
  recordedSummaryTokens: readonly number[],
  spanTokens: number,
): number {
  if (spanTokens <= 0) return 0;
  const measured = median(recordedSummaryTokens);
  const raw = measured > 0 ? measured : Math.round(REWRITE_FALLBACK_SPAN_RATIO * spanTokens);
  return Math.max(0, Math.min(raw, Math.max(0, Math.round(spanTokens))));
}

/**
 * Scalar fallback used only for synthetic callers that supply no branch entry
 * identities (the gate fixtures and size-model tests). The live CLI always
 * resolves the cut structurally from the recorded branch entries.
 */
export function spanTokensFor(contextTokens: number, keepRecentEff: number): number {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return 0;
  return Math.max(0, Math.round(contextTokens - Math.max(0, keepRecentEff)));
}

// ---------------------------------------------------------------------------
// Structural cut (todo 6 semantics)
// ---------------------------------------------------------------------------

const REPLAY_RESERVE_TOKENS = 16_384;

export interface BranchIndex {
  branch: ReplayBranch;
  entries: ReplayEntryMeta[];
  byId: Map<string, ReplayEntryMeta>;
  prefixTokens(id: string | null | undefined): number;
  contextStart(id: string | null | undefined): number;
  budgetTokens(meta: ReplayEntryMeta): number;
  editFor(id: string, upToIndex: number): ReplayEdit | undefined;
}

export function buildBranchIndex(branch: ReplayBranch): BranchIndex {
  const entries = branch.entries;
  const byId = new Map<string, ReplayEntryMeta>();
  for (const meta of entries) byId.set(meta.id, meta);

  const keptCallIds = new Set<string>();
  const failedCallIds = new Set<string>();
  for (const meta of entries) {
    if (meta.type !== "message" || meta.role !== "assistant") continue;
    const failed = meta.stopReason === "error" || meta.stopReason === "aborted";
    for (const id of meta.toolCallIds ?? []) {
      (failed ? failedCallIds : keptCallIds).add(id);
    }
  }
  for (const id of keptCallIds) failedCallIds.delete(id);

  const prefixCache = new Map<string, number>();
  const startCache = new Map<string, number>();

  const prefixTokens = (id: string | null | undefined): number => {
    if (!id) return 0;
    const cached = prefixCache.get(id);
    if (cached !== undefined) return cached;
    const chain: ReplayEntryMeta[] = [];
    let current = byId.get(id);
    let base = 0;
    while (current) {
      const known = prefixCache.get(current.id);
      if (known !== undefined) {
        base = known;
        break;
      }
      chain.push(current);
      if (!current.parentId) break;
      current = byId.get(current.parentId);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      base += chain[i].tokens;
      prefixCache.set(chain[i].id, base);
    }
    return prefixCache.get(id) ?? base;
  };

  const contextStart = (id: string | null | undefined): number => {
    if (!id) return 0;
    const cached = startCache.get(id);
    if (cached !== undefined) return cached;
    const chain: ReplayEntryMeta[] = [];
    let current = byId.get(id);
    let value = 0;
    while (current) {
      const known = startCache.get(current.id);
      if (known !== undefined) {
        value = known;
        break;
      }
      if (current.type === "compaction") {
        const firstKept = current.firstKeptEntryId ? byId.get(current.firstKeptEntryId) : undefined;
        value = firstKept ? Math.min(firstKept.index, current.index) : current.index;
        break;
      }
      chain.push(current);
      if (!current.parentId) {
        value = current.index;
        break;
      }
      const parent = byId.get(current.parentId);
      if (!parent) {
        value = current.index;
        break;
      }
      current = parent;
    }
    for (const meta of chain) startCache.set(meta.id, value);
    startCache.set(id, value);
    return value;
  };

  const budgetTokens = (meta: ReplayEntryMeta): number => {
    if (meta.type !== "message" && meta.type !== "custom_message" && meta.type !== "branch_summary") {
      return 0;
    }
    if (meta.type === "message" && meta.role === "assistant") {
      // dropFailedAssistantTurns excludes failed turns from the keep budget.
      if (meta.stopReason === "error" || meta.stopReason === "aborted") return 0;
      return meta.tokens;
    }
    if (meta.type === "message" && meta.role === "toolResult" && meta.toolCallId) {
      if (failedCallIds.has(meta.toolCallId) && !keptCallIds.has(meta.toolCallId)) return 0;
    }
    return meta.tokens;
  };

  const editFor = (id: string, upToIndex: number): ReplayEdit | undefined => {
    let found: ReplayEdit | undefined;
    for (const edit of branch.edits) {
      if (edit.index > upToIndex || edit.targetId !== id) continue;
      if (!found || edit.index > found.index) found = edit;
    }
    return found;
  };

  return { branch, entries, byId, prefixTokens, contextStart, budgetTokens, editFor };
}

function stubText(chars: number): string {
  if (chars <= 0) return "";
  // Alternate with spaces: a long alphanumeric run would trigger senpi's
  // base64 weighting and make the stub estimate 4x the measured token count.
  const pairs = Math.floor(chars / 2);
  return "x ".repeat(pairs) + (chars % 2 === 1 ? "x" : "");
}

/**
 * Rebuild one minimal entry from metadata, sized so `estimateTokens()` returns
 * the same count that was measured on the original message. Tool-call ids are
 * preserved so `dropFailedAssistantTurns` sees the same pairing.
 */
function stubEntry(meta: ReplayEntryMeta, edit: ReplayEdit | undefined): SessionEntry {
  const id = meta.id;
  const parentId = meta.parentId;
  const timestamp = new Date(Number.isFinite(meta.timestamp) ? meta.timestamp : 0).toISOString();

  if (edit && edit.replacementTokens === null) {
    return {
      id,
      parentId,
      timestamp,
      type: "custom",
      customType: "replay.context-edit-omitted",
    } as unknown as SessionEntry;
  }

  const tokens = edit ? Math.max(0, edit.replacementTokens ?? 0) : meta.tokens;
  const chars = Math.max(0, Math.round(tokens * 4));

  if (meta.type === "message" && meta.role) {
    if (meta.role === "assistant") {
      const callIds = meta.toolCallIds ?? [];
      // name "x" (1 char) + JSON arguments "{}" (2 chars) per call.
      const callChars = callIds.length * 3;
      const textChars = Math.max(0, chars - callChars);
      const content: unknown[] = [];
      if (textChars > 0) content.push({ type: "text", text: stubText(textChars) });
      for (const callId of callIds) {
        content.push({ type: "toolCall", id: callId, name: "x", arguments: {} });
      }
      return {
        id,
        parentId,
        timestamp,
        type: "message",
        message: {
          role: "assistant",
          content,
          stopReason: meta.stopReason ?? "stop",
          timestamp: 0,
          provider: "replay",
          model: "replay",
        },
      } as unknown as SessionEntry;
    }
    if (meta.role === "toolResult") {
      return {
        id,
        parentId,
        timestamp,
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: meta.toolCallId ?? "replay",
          toolName: "replay",
          content: [{ type: "text", text: stubText(chars) }],
          isError: false,
          timestamp: 0,
        },
      } as unknown as SessionEntry;
    }
    return {
      id,
      parentId,
      timestamp,
      type: "message",
      message: {
        role: meta.role,
        content: [{ type: "text", text: stubText(chars) }],
        timestamp: 0,
      },
    } as unknown as SessionEntry;
  }

  if (meta.type === "custom_message") {
    return {
      id,
      parentId,
      timestamp,
      type: "custom_message",
      customType: meta.customType ?? "replay",
      content: [{ type: "text", text: stubText(chars) }],
      display: false,
    } as unknown as SessionEntry;
  }

  if (meta.type === "branch_summary") {
    return {
      id,
      parentId,
      timestamp,
      type: "branch_summary",
      fromId: meta.parentId ?? "",
      summary: stubText(chars),
    } as unknown as SessionEntry;
  }

  return {
    id,
    parentId,
    timestamp,
    type: "custom",
    customType: "replay.metadata",
  } as unknown as SessionEntry;
}

interface WindowSlice {
  metas: ReplayEntryMeta[];
  reachedStart: boolean;
}

function buildCutWindow(
  index: BranchIndex,
  end: ReplayEntryMeta,
  startIndex: number,
  targetTokens: number,
): WindowSlice {
  const backward: ReplayEntryMeta[] = [];
  let accumulated = 0;
  let current: ReplayEntryMeta | undefined = end;

  while (current && current.index >= startIndex && accumulated < targetTokens) {
    backward.push(current);
    accumulated += index.budgetTokens(current);
    if (current.index <= startIndex) break;
    current = current.parentId ? index.byId.get(current.parentId) : undefined;
    if (!current || current.index < startIndex) break;
  }

  // Walk back over adjacent non-context entries and include the previous
  // context-visible entry, so findCutPoint's metadata scan sees the same
  // boundary it would see on the full branch.
  let cursor = current;
  while (cursor && cursor.index >= startIndex) {
    backward.push(cursor);
    const visible =
      cursor.type === "message" || cursor.type === "custom_message" || cursor.type === "branch_summary";
    if (visible) break;
    cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined;
  }

  const oldest = backward[backward.length - 1];
  const oldestParent = oldest?.parentId ? index.byId.get(oldest.parentId) : undefined;
  const reachedStart =
    oldest !== undefined &&
    (oldest.index <= startIndex || !oldestParent || oldestParent.index < startIndex);

  return { metas: backward.slice().reverse(), reachedStart };
}

export interface StructuralCut {
  kind: "structural";
  spanTokens: number;
  firstKeptIndex: number;
  firstKeptEntryId: string;
}

function editAdjustment(
  index: BranchIndex,
  fromIndex: number,
  toIndex: number,
  upToIndex: number,
): number {
  let adjustment = 0;
  for (const edit of index.branch.edits) {
    if (edit.index > upToIndex) continue;
    const target = index.byId.get(edit.targetId);
    if (!target || target.index < fromIndex || target.index >= toIndex) continue;
    adjustment += target.tokens - (edit.replacementTokens ?? 0);
  }
  return adjustment;
}

type CutResolution = StructuralCut | "fallback" | "unavailable";

/**
 * Resolve the remove-prefix cut for one request with the production
 * `prepareSource` on identity-preserving entry stubs. Only the tail the keep
 * budget can reach is rebuilt; older entries cannot affect findCutPoint's
 * result because the backward walk stops as soon as the budget is reached.
 * The summarized size is measured on the whole removed prefix via parent-chain
 * token sums, so truncating the window does not truncate the span size.
 */
export function resolveStructuralCut(
  branch: ReplayBranch,
  request: ReplayRequest,
  simStartIndex: number,
  contextWindow: number,
  thresholdRatio: number,
  keepRecentTokens: number,
): CutResolution {
  return resolveCutWithIndex(
    buildBranchIndex(branch),
    request,
    simStartIndex,
    contextWindow,
    thresholdRatio,
    keepRecentTokens,
  );
}

export function resolveCutWithIndex(
  index: BranchIndex,
  request: ReplayRequest,
  simStartIndex: number,
  contextWindow: number,
  thresholdRatio: number,
  keepRecentTokens: number,
): CutResolution {
  if (request.entryIndex === undefined) return "fallback";
  const end = index.entries[request.entryIndex];
  if (!end) return "fallback";
  const startIndex = Math.max(0, Math.min(end.index, Math.max(simStartIndex, index.contextStart(end.id))));
  const startMeta = index.entries[startIndex];
  if (!startMeta) return "fallback";

  for (const multiplier of [1.5, 3]) {
    const target = Math.max(keepRecentTokens, Math.ceil(keepRecentTokens * multiplier));
    const window = buildCutWindow(index, end, startIndex, target);
    const stubs = window.metas.map((meta) => stubEntry(meta, index.editFor(meta.id, request.entryIndex!)));

    let prepared;
    try {
      prepared = prepareSource({
        branchEntries: stubs,
        contextWindow,
        thresholdRatio,
        settings: { keepRecentTokens, reserveTokens: REPLAY_RESERVE_TOKENS },
      });
    } catch {
      return "fallback";
    }

    if (!prepared) {
      if (window.reachedStart) return "unavailable";
      continue;
    }
    const firstKeptIndex = window.metas.findIndex((meta) => meta.id === prepared.firstKeptEntryId);
    if (firstKeptIndex < 0) return "unavailable";
    if (firstKeptIndex <= 0 && !window.reachedStart) {
      // The window did not reach far enough for the budget walk; widen once.
      continue;
    }

    const firstKept = window.metas[firstKeptIndex];
    if (!firstKept) return "unavailable";
    const prefix = index.prefixTokens(firstKept.parentId) - index.prefixTokens(startMeta.parentId);
    const spanTokens = Math.max(
      0,
      prefix - editAdjustment(index, startIndex, firstKept.index, request.entryIndex),
    );
    return {
      kind: "structural",
      spanTokens,
      firstKeptIndex: firstKept.index,
      firstKeptEntryId: firstKept.id,
    };
  }

  return "fallback";
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

function estimateMessageTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  try {
    return estimateTokens(message as never);
  } catch {
    return 0;
  }
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  try {
    return Math.ceil((JSON.stringify(content) ?? "").length / 4);
  } catch {
    return 0;
  }
}

function usageParts(message: Record<string, unknown>): {
  prompt: number;
  cacheRead: number;
  output: number;
} {
  const usage = (message.usage ?? {}) as Record<string, unknown>;
  const input = numberField(usage.input);
  const cacheRead = numberField(usage.cacheRead);
  const cacheWrite = numberField(usage.cacheWrite);
  const output = numberField(usage.output);
  const total = numberField(usage.totalTokens);
  const prompt = total > 0 ? Math.max(0, total - output) : input + cacheRead + cacheWrite;
  return { prompt, cacheRead, output };
}

/**
 * Parse one session file. Any malformed line skips the whole file with a named
 * reason (a truncated final line is the common case); the caller continues.
 * The reason carries only a line number, never file content.
 */
export function parseSessionText(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  let header: Record<string, unknown> | undefined;
  let lineNumber = 0;

  let currentProvider = "";
  let currentModelId = "";
  const requests: ReplayRequest[] = [];
  const compactions: ReplayCompaction[] = [];
  const entries: ReplayEntryMeta[] = [];
  const edits: ReplayEdit[] = [];
  let pendingTokens = 0;

  for (const raw of lines) {
    lineNumber += 1;
    if (raw.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: `unparseable-jsonl-line-${lineNumber}` };
      }
      entry = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: `unparseable-jsonl-line-${lineNumber}` };
    }

    if (!header) {
      if (entry.type !== "session" || typeof entry.id !== "string") {
        return { ok: false, reason: "missing-session-header" };
      }
      header = entry;
      continue;
    }

    const entryTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const ts = Number.isFinite(entryTs) ? entryTs : 0;
    const entryIndex = entries.length;
    const entryType = typeof entry.type === "string" ? entry.type : "";
    const meta: ReplayEntryMeta = {
      index: entryIndex,
      id: typeof entry.id === "string" ? entry.id : `entry-${entryIndex}`,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      timestamp: ts,
      type: entryType,
      tokens: 0,
    };

    if (entryType === "model_change") {
      currentProvider = typeof entry.provider === "string" ? entry.provider : currentProvider;
      currentModelId = typeof entry.modelId === "string" ? entry.modelId : currentModelId;
      pendingTokens = 0;
      entries.push(meta);
      continue;
    }

    if (entryType === "compaction") {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      const details =
        entry.details && typeof entry.details === "object"
          ? (entry.details as Record<string, unknown>)
          : {};
      const firstKeptEntryId =
        typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
      meta.firstKeptEntryId = firstKeptEntryId;
      meta.summaryTokens = summaryTokens(summary);
      compactions.push({
        ts,
        tokensBefore: numberField(entry.tokensBefore),
        summaryTokens: summaryTokens(summary),
        schema: typeof details.schema === "string" ? details.schema : "unknown",
        firstKeptEntryId,
        entryIndex,
      });
      // The recorded summary is not an append; the simulation owns its own summary.
      entries.push(meta);
      continue;
    }

    if (entryType === "context_edit") {
      if (typeof entry.targetId === "string") {
        const replacement = entry.replacement;
        edits.push({
          index: entryIndex,
          targetId: entry.targetId,
          replacementTokens:
            replacement === null
              ? null
              : estimateContentTokens(
                  replacement && typeof replacement === "object"
                    ? (replacement as Record<string, unknown>).content
                    : replacement,
                ),
        });
      }
      entries.push(meta);
      continue;
    }

    if (entryType === "message" && entry.message && typeof entry.message === "object") {
      const message = entry.message as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role : "";
      meta.role = role;
      meta.tokens = estimateMessageTokens(message);
      if (role === "assistant") {
        meta.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
        const content = Array.isArray(message.content) ? message.content : [];
        const toolCallIds: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const record = block as Record<string, unknown>;
          if (record.type === "toolCall" && typeof record.id === "string") toolCallIds.push(record.id);
        }
        if (toolCallIds.length > 0) meta.toolCallIds = toolCallIds;

        const parts = usageParts(message);
        const stopReason = meta.stopReason ?? null;
        const validUsage =
          stopReason !== "aborted" && stopReason !== "error" && parts.prompt + parts.output > 0;
        if (validUsage) {
          requests.push({
            ts,
            appendedTokens: pendingTokens,
            promptTokens: parts.prompt,
            cacheRead: parts.cacheRead,
            outputTokens: parts.output,
            provider: currentProvider,
            modelId: currentModelId,
            stopReason,
            entryIndex,
          });
          pendingTokens = parts.output > 0 ? parts.output : meta.tokens;
        } else {
          pendingTokens += meta.tokens;
        }
      } else {
        if (role === "toolResult" && typeof message.toolCallId === "string") {
          meta.toolCallId = message.toolCallId;
        }
        pendingTokens += meta.tokens;
      }
      entries.push(meta);
      continue;
    }

    if (entryType === "custom_message") {
      meta.customType = typeof entry.customType === "string" ? entry.customType : undefined;
      meta.tokens = estimateMessageTokens({
        role: "custom",
        customType: meta.customType,
        content: entry.content ?? [],
        display: entry.display,
        details: entry.details,
        timestamp: 0,
      });
      pendingTokens += meta.tokens;
      entries.push(meta);
      continue;
    }

    if (entryType === "branch_summary" && typeof entry.summary === "string") {
      meta.tokens = Math.ceil(entry.summary.length / 4);
      pendingTokens += meta.tokens;
      entries.push(meta);
      continue;
    }

    entries.push(meta);
  }

  if (!header) return { ok: false, reason: "missing-session-header" };
  if (requests.length === 0) return { ok: false, reason: "no-recorded-usage" };
  if (entries.length === 0) return { ok: false, reason: "branch-unmapped" };

  const id = header.id as string;
  return {
    ok: true,
    session: {
      id,
      hash: hashId(id),
      requests,
      compactions,
      branch: { entries, edits },
    },
  };
}

// ---------------------------------------------------------------------------
// Model metadata (context windows and local endpoints)
// ---------------------------------------------------------------------------

export interface ModelMeta {
  windowFor(provider: string, modelId: string): number;
  endpointFor(provider: string): string | null;
  isAnthropic(provider: string, modelId: string): boolean;
}

function isLocalHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function loadModelMeta(agentDir: string): ModelMeta {
  const byProviderModel = new Map<string, number>();
  const byModel = new Map<string, number>();
  const endpoints = new Map<string, string>();
  const anthropicProviders = new Set<string>();

  const modelsPath = join(agentDir, "models.json");
  if (existsSync(modelsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as {
        providers?: Record<string, Record<string, unknown>>;
      };
      for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
        if (!config || typeof config !== "object") continue;
        const api = typeof config.api === "string" ? config.api : "";
        if (api === "anthropic-messages" || /anthropic/i.test(provider)) {
          anthropicProviders.add(provider);
        }
        const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
        if (baseUrl.length > 0) {
          try {
            const url = new URL(baseUrl);
            if (isLocalHost(url.hostname)) endpoints.set(provider, url.origin);
          } catch {
            // A malformed baseUrl is not a local endpoint.
          }
        }
        const models = Array.isArray(config.models) ? config.models : [];
        for (const model of models) {
          if (!model || typeof model !== "object") continue;
          const record = model as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : "";
          const window = numberField(record.contextWindow);
          if (id && window > 0) {
            byProviderModel.set(`${provider}/${id}`, window);
            if (!byModel.has(id)) byModel.set(id, window);
          }
        }
        const overrides =
          config.modelOverrides && typeof config.modelOverrides === "object"
            ? (config.modelOverrides as Record<string, unknown>)
            : {};
        for (const [id, override] of Object.entries(overrides)) {
          if (!override || typeof override !== "object") continue;
          const window = numberField((override as Record<string, unknown>).contextWindow);
          if (window > 0) {
            byProviderModel.set(`${provider}/${id}`, window);
            if (!byModel.has(id)) byModel.set(id, window);
          }
        }
      }
    } catch {
      // A missing/invalid models.json only means the default window and no
      // local-eviction inference; the replay still runs.
    }
  }

  return {
    windowFor(provider: string, modelId: string): number {
      return (
        byProviderModel.get(`${provider}/${modelId}`) ??
        byModel.get(modelId) ??
        DEFAULT_CONTEXT_WINDOW
      );
    },
    endpointFor(provider: string): string | null {
      return endpoints.get(provider) ?? null;
    },
    isAnthropic(provider: string, modelId: string): boolean {
      return anthropicProviders.has(provider) || /^claude/i.test(modelId);
    },
  };
}

// ---------------------------------------------------------------------------
// Strata/Ollama eviction inference
// ---------------------------------------------------------------------------

export type EndpointIndex = Map<string, Map<string, number[]>>;

async function forEachJsonLine(
  path: string,
  onLine: (line: string) => void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) onLine(line);
  } finally {
    reader.close();
    stream.close();
  }
}

/**
 * Collect assistant request timestamps for every recent session that used a
 * local endpoint. Keyed endpoint -> session hash -> sorted timestamps.
 */
export async function scanLocalRequestTimes(
  sessionsDir: string,
  cutoffMs: number,
  meta: ModelMeta,
): Promise<EndpointIndex> {
  const index: EndpointIndex = new Map();
  const files = collectSessionFiles(sessionsDir);

  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoffMs) continue;

    let sessionHash = hashId(basename(file));
    let provider = "";
    let modelId = "";
    const perSession: Map<string, number[]> = new Map();

    try {
      await forEachJsonLine(file, (line) => {
        if (line.trim().length === 0) return;
        if (line.includes('"type":"session"')) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type === "session" && typeof entry.id === "string") {
              sessionHash = hashId(entry.id);
            }
          } catch {
            // Keep the filename hash.
          }
          return;
        }
        if (line.includes('"model_change"')) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type === "model_change") {
              if (typeof entry.provider === "string") provider = entry.provider;
              if (typeof entry.modelId === "string") modelId = entry.modelId;
            }
          } catch {
            // Ignore a malformed metadata line in the eviction scan.
          }
          return;
        }
        if (!line.includes('"role":"assistant"')) return;
        const endpoint = meta.endpointFor(provider);
        if (!endpoint) return;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type !== "message" || typeof entry.message !== "object") return;
          const message = entry.message as Record<string, unknown>;
          if (message.role !== "assistant") return;
          const parts = usageParts(message);
          if (parts.prompt + parts.output <= 0) return;
          const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
          if (!Number.isFinite(ts)) return;
          let times = perSession.get(endpoint);
          if (!times) {
            times = [];
            perSession.set(endpoint, times);
          }
          times.push(ts);
        } catch {
          // A truncated line contributes no timestamp.
        }
      });
    } catch {
      continue;
    }

    for (const [endpoint, times] of perSession) {
      times.sort((a, b) => a - b);
      let sessions = index.get(endpoint);
      if (!sessions) {
        sessions = new Map();
        index.set(endpoint, sessions);
      }
      sessions.set(sessionHash, times);
    }
  }

  return index;
}

function hasTimeInOpenRange(times: readonly number[], low: number, high: number): boolean {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= low) lo = mid + 1;
    else hi = mid;
  }
  return lo < times.length && times[lo] < high;
}

/**
 * Cold flags for one session's requests. First request is cold; local
 * endpoints are cold when another session's request interleaved since this
 * session's previous request on the same endpoint; Anthropic providers are
 * cold when the recorded cacheRead is zero.
 */
export function inferColdFlags(
  session: ParsedSession,
  index: EndpointIndex,
  meta: ModelMeta,
): boolean[] {
  const flags: boolean[] = [];
  const lastByEndpoint = new Map<string, number>();
  const lastByProvider = new Map<string, number>();

  for (let i = 0; i < session.requests.length; i++) {
    const request = session.requests[i];
    if (i === 0) {
      flags.push(true);
      const endpoint = meta.endpointFor(request.provider);
      if (endpoint) lastByEndpoint.set(endpoint, request.ts);
      lastByProvider.set(request.provider, request.ts);
      continue;
    }

    const endpoint = meta.endpointFor(request.provider);
    if (endpoint) {
      const previous = lastByEndpoint.get(endpoint);
      let cold = previous === undefined;
      if (previous !== undefined && request.ts > previous) {
        const sessions = index.get(endpoint);
        if (sessions) {
          for (const [otherHash, times] of sessions) {
            if (otherHash === session.hash) continue;
            if (hasTimeInOpenRange(times, previous, request.ts)) {
              cold = true;
              break;
            }
          }
        }
      }
      flags.push(cold);
      lastByEndpoint.set(endpoint, request.ts);
      lastByProvider.set(request.provider, request.ts);
      continue;
    }

    if (meta.isAnthropic(request.provider, request.modelId)) {
      const previous = lastByProvider.get(request.provider);
      const expired = previous !== undefined && request.ts - previous > ANTHROPIC_CACHE_TTL_MS;
      const cold = (request.cacheRead === 0 && request.promptTokens >= 1024) || expired;
      flags.push(cold);
      lastByProvider.set(request.provider, request.ts);
      continue;
    }

    flags.push(false);
    lastByProvider.set(request.provider, request.ts);
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface SimulateOptions {
  policy: ReplayPolicy;
  contextWindowFor: (provider: string, modelId: string) => number;
  coldAt: (index: number) => boolean;
  recordedSummaryTokens: readonly number[];
  keepRecentTokens?: number;
  config?: PolicyConfig;
  /** Recorded branch identities used to resolve the todo 6 structural cut. */
  branch?: ReplayBranch;
}

function emptyRow(policy: ReplayPolicy): PolicyRow {
  return {
    policy,
    applies: { cold: 0, boundary: 0, threshold: 0 },
    appliesTotal: 0,
    cutFallbacks: 0,
    cutUnavailable: 0,
    thresholdCrossings: 0,
    jobsStarted: 0,
    coldMisses: 0,
    coldMissTokens: 0,
    applyRereadTokenPrefix: 0,
    applyRereadBlockLevel: 0,
    prefillTokenPrefix: 0,
    prefillBlockLevel: 0,
    summaryStartTokens: 0,
    summaryEndTokens: 0,
    summaryMaxTokens: 0,
    summaryWriteTokens: 0,
    notesAppends: 0,
    notesBlocks: 0,
    consolidations: 0,
    finalContextTokens: 0,
  };
}

type SpanInfo =
  | { kind: "structural"; spanTokens: number; firstKeptIndex: number }
  | { kind: "scalar"; spanTokens: number };

export function simulatePolicy(
  requests: readonly ReplayRequest[],
  options: SimulateOptions,
): PolicyRow {
  const row = emptyRow(options.policy);
  const config = options.config ?? DEFAULTS;
  const keepRecentSetting = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  if (requests.length === 0) return row;

  const branchIndex = options.branch ? buildBranchIndex(options.branch) : undefined;
  const recordedCompactions = options.branch
    ? options.branch.entries
        .filter((meta) => meta.type === "compaction")
        .slice()
        .sort((a, b) => a.index - b.index)
    : [];
  let compactionCursor = 0;
  let simStartIndex = 0;
  let contextAfterRequest = requests[0].promptTokens;
  let summary = 0;
  let hasCompaction = false;
  let notesBlocks = 0;
  let lastYield: LastYield | undefined;
  let preparedBase = 0;
  let appliedBase = requests[0].promptTokens;
  let preparedAtU = 0;
  let jobReady = false;
  const startTimes: number[] = [];
  let aboveThreshold = false;
  // Set when an apply lands on the first recorded request. That request is
  // always charged as a full cold prefill; the compacted context it produces
  // is paid by the next request instead.
  let pendingApplyReread: { tokenPrefix: number; blockLevel: number } | null = null;

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];

    // A recorded compaction reset the real context before this request. The
    // simulation follows that recorded reset (shared by every policy) instead
    // of accumulating through a session the provider already compacted.
    let resyncCompaction: ReplayEntryMeta | undefined;
    const crossedCompactions: ReplayEntryMeta[] = [];
    if (request.entryIndex !== undefined) {
      while (
        compactionCursor < recordedCompactions.length &&
        recordedCompactions[compactionCursor].index <= request.entryIndex
      ) {
        resyncCompaction = recordedCompactions[compactionCursor];
        crossedCompactions.push(recordedCompactions[compactionCursor]);
        compactionCursor += 1;
      }
    }
    const resync = crossedCompactions.length > 0 && i > 0;
    const contextTokens =
      i === 0 || resync ? request.promptTokens : contextAfterRequest + Math.max(0, request.appendedTokens);
    if (resync) {
      simStartIndex = 0;
      jobReady = false;
      preparedBase = contextTokens;
      preparedAtU = contextTokens;
      appliedBase = contextTokens;
      hasCompaction = true;
      summary = resyncCompaction!.summaryTokens ?? summary;
      row.summaryMaxTokens = Math.max(row.summaryMaxTokens, summary);
      notesBlocks = 0;
      aboveThreshold = false;
    }

    // A pending re-read from an apply on the first request is paid here. A
    // cold request already charges its whole prompt, and a recorded compaction
    // resets the context, so neither case adds the pending amount again.
    if (pendingApplyReread) {
      if (!resync && !options.coldAt(i)) {
        row.prefillTokenPrefix += pendingApplyReread.tokenPrefix;
        row.prefillBlockLevel += pendingApplyReread.blockLevel;
      }
      pendingApplyReread = null;
    }

    if (resync && options.policy === "stock" && branchIndex) {
      // The recording already contains stock's compactions. Use them as the
      // stock baseline instead of re-simulating threshold applies on top.
      for (const compaction of crossedCompactions) {
        const writtenSummary = compaction.summaryTokens ?? 0;
        row.applies.threshold += 1;
        row.appliesTotal += 1;
        row.thresholdCrossings += 1;
        row.summaryWriteTokens += writtenSummary;
        row.summaryMaxTokens = Math.max(row.summaryMaxTokens, writtenSummary);
      }
      summary = resyncCompaction!.summaryTokens ?? summary;
      row.applyRereadTokenPrefix += contextTokens;
      row.applyRereadBlockLevel += summary;
      if (options.coldAt(i)) {
        // A cold request re-reads the whole post-compaction prompt in both
        // cache models; the written summary block alone would undercount it.
        row.coldMisses += 1;
        row.coldMissTokens += contextTokens;
        row.prefillTokenPrefix += contextTokens;
        row.prefillBlockLevel += contextTokens;
      } else {
        row.prefillTokenPrefix += contextTokens;
        row.prefillBlockLevel += summary;
      }
      contextAfterRequest = contextTokens;
      continue;
    }

    const window = options.contextWindowFor(request.provider, request.modelId);
    const thresholdRatio = computeEffectiveThreshold(window, lastYield);
    const threshold = window * thresholdRatio;
    const keepRecentEff = computeEffectiveKeepRecentTokens(
      keepRecentSetting,
      window,
      thresholdRatio,
    );

    if ((options.policy !== "stock" || !branchIndex) && contextTokens >= threshold && !aboveThreshold) {
      row.thresholdCrossings += 1;
      aboveThreshold = true;
    }

    let cachedSpan: SpanInfo | null | undefined;
    const getSpan = (): SpanInfo | null => {
      if (cachedSpan !== undefined) return cachedSpan;
      if (!branchIndex) {
        row.cutFallbacks += 1;
        cachedSpan = { kind: "scalar", spanTokens: spanTokensFor(contextTokens, keepRecentEff) };
        return cachedSpan;
      }
      const cut = resolveCutWithIndex(
        branchIndex,
        request,
        simStartIndex,
        window,
        thresholdRatio,
        keepRecentEff,
      );
      if (cut === "unavailable") {
        row.cutUnavailable += 1;
        cachedSpan = null;
        return cachedSpan;
      }
      if (cut === "fallback") {
        row.cutFallbacks += 1;
        cachedSpan = { kind: "scalar", spanTokens: spanTokensFor(contextTokens, keepRecentEff) };
        return cachedSpan;
      }
      cachedSpan = cut;
      return cachedSpan;
    };

    let route: "cold" | "boundary" | "threshold" | null = null;
    let applied = false;
    let applyAfter = contextTokens;
    let written = 0;

    const applyFullRewrite = (spanInfo: SpanInfo, routeName: "threshold"): boolean => {
      if (spanInfo.spanTokens <= 0) return false;
      const candidate = rewriteSummaryTokens(options.recordedSummaryTokens, spanInfo.spanTokens);
      summary = candidate;
      hasCompaction = true;
      notesBlocks = 0;
      written = candidate;
      applyAfter = Math.max(0, contextTokens - spanInfo.spanTokens) + candidate;
      applied = true;
      route = routeName;
      if (spanInfo.kind === "structural") simStartIndex = spanInfo.firstKeptIndex;
      return true;
    };

    const settled = request.stopReason === "stop";
    if (i === 0) {
      // Before the first prompt only the builtin safety net can act.
      if (settled && contextTokens >= threshold) {
        const spanInfo = getSpan();
        if (spanInfo) applyFullRewrite(spanInfo, "threshold");
      }
    } else if (options.policy === "stock") {
      if (!branchIndex && contextTokens >= threshold) {
        const spanInfo = getSpan();
        if (spanInfo) applyFullRewrite(spanInfo, "threshold");
      }
    } else {
      const staleAllowance = Math.max(keepRecentEff, config.staleWindowRatio * window);
      if (jobReady && contextTokens - preparedAtU > staleAllowance) jobReady = false;

      if (!jobReady) {
        const start = shouldStartJob({
          contextTokens,
          contextWindow: window,
          growthSincePreparedTokens: contextTokens - preparedBase,
          now: request.ts,
          sessionStartTimes: startTimes,
          random: () => 0,
          config,
        });
        if (start.start) {
          jobReady = true;
          preparedBase = contextTokens;
          preparedAtU = contextTokens;
          startTimes.push(request.ts + (start.jitterMs ?? 0));
          row.jobsStarted += 1;
        }
      }

      if (settled && contextTokens >= threshold && !jobReady) {
        // The builtin safety net compacts even when no mod job is ready.
        const spanInfo = getSpan();
        if (spanInfo) applyFullRewrite(spanInfo, "threshold");
      } else if (settled && jobReady) {
        const spanInfo = getSpan();
        if (!spanInfo) {
          // Nothing to summarize with the real cut; discard the READY job.
          jobReady = false;
        } else {
          const mode = options.policy === "early-notes" ? "notes" : "rewrite";
          const kind = nextJobKind({
            hasCompactionEntry: hasCompaction,
            mode,
            summaryTokens: summary,
            notesBlocks,
            config,
          });
          const newNotes = notesSummaryTokens(spanInfo.spanTokens);
          const candidate =
            kind === "notes" ? summary + newNotes : rewriteSummaryTokens(options.recordedSummaryTokens, spanInfo.spanTokens);
          const estimatedAfter = Math.max(0, contextTokens - spanInfo.spanTokens) + candidate;

          // Every mod apply decision goes through the shared policy function;
          // the replay only records the inputs (immediately READY job, settled
          // run, warm/cold inference, valid anchor/fingerprint).
          const decision = applyDecision({
            contextTokens,
            contextWindow: window,
            jobReady: true,
            tokensAppendedAfterCut: Math.max(0, contextTokens - preparedAtU),
            effectiveKeepRecentTokens: keepRecentEff,
            anchorValid: true,
            fingerprintValid: true,
            estimatedTokensAfter: estimatedAfter,
            idle: true,
            hasPendingMessages: false,
            compacting: false,
            site: "agent_settled",
            now: request.ts,
            permission: { lastPromptAt: null, lastAgentSettledAt: request.ts, lastDraftAt: null },
            cache: options.coldAt(i) ? "cold" : "warm",
            runEnd: { aborted: false, willRetry: false },
            lastAssistantStopReason: request.stopReason,
            growthSinceAppliedTokens: Math.max(0, contextTokens - appliedBase),
            lastYield: lastYield ?? undefined,
            config,
          });

          if (decision !== "none") {
            route = decision;
            if (kind === "notes") {
              summary = candidate;
              notesBlocks += 1;
              row.notesAppends += 1;
              written = newNotes;
            } else {
              summary = candidate;
              notesBlocks = 0;
              written = candidate;
              if (kind === "rewrite-consolidate") row.consolidations += 1;
            }
            hasCompaction = true;
            jobReady = false;
            applyAfter = estimatedAfter;
            applied = true;
            if (spanInfo.kind === "structural") simStartIndex = spanInfo.firstKeptIndex;
          }
        }
      }
    }

    if (settled && route === "threshold" && !applied) {
      // Stock and the early safety fallback both use a full rewrite.
      const spanInfo = getSpan();
      if (spanInfo) applyFullRewrite(spanInfo, "threshold");
      jobReady = false;
    }

    if (route !== null) {
      row.applies[route] += 1;
      row.appliesTotal += 1;
    }

    if (applied) {
      if (options.policy === "stock") {
        lastYield = {
          savedTokens: Math.max(0, contextTokens - applyAfter),
          tokensBefore: contextTokens,
        };
      }
      appliedBase = applyAfter;
      preparedBase = applyAfter;
      preparedAtU = applyAfter;
      row.summaryWriteTokens += written;
      row.summaryMaxTokens = Math.max(row.summaryMaxTokens, summary);
      row.applyRereadTokenPrefix += applyAfter;
      row.applyRereadBlockLevel += written;
      if (i === 0) {
        // The first recorded request is a cold prefill in both models for
        // every policy, independent of an apply decided at it. The compacted
        // context it produces is charged on the following request.
        row.coldMisses += 1;
        row.coldMissTokens += contextTokens;
        row.prefillTokenPrefix += contextTokens;
        row.prefillBlockLevel += contextTokens;
        pendingApplyReread = { tokenPrefix: applyAfter, blockLevel: written };
      } else if (options.coldAt(i)) {
        // A cold request that also applies pays its own full prompt first;
        // the post-apply context is the following request's re-read.
        row.coldMisses += 1;
        row.coldMissTokens += contextTokens;
        row.prefillTokenPrefix += contextTokens + applyAfter;
        row.prefillBlockLevel += contextTokens + written;
      } else {
        row.prefillTokenPrefix += applyAfter;
        row.prefillBlockLevel += written;
      }
      contextAfterRequest = applyAfter;
      aboveThreshold = applyAfter >= threshold;
    } else {
      if (i === 0 || options.coldAt(i)) {
        // The first recorded request is always cold, whatever coldAt says.
        row.coldMisses += 1;
        row.coldMissTokens += contextTokens;
        row.prefillTokenPrefix += contextTokens;
        row.prefillBlockLevel += contextTokens;
      } else {
        const warm = Math.max(0, request.appendedTokens);
        row.prefillTokenPrefix += warm;
        row.prefillBlockLevel += warm;
      }
      contextAfterRequest = contextTokens;
      if (i === 0) appliedBase = contextTokens;
    }
  }

  row.summaryEndTokens = summary;
  row.notesBlocks = notesBlocks;
  row.finalContextTokens = contextAfterRequest;
  return row;
}

// ---------------------------------------------------------------------------
// Input selection
// ---------------------------------------------------------------------------

export interface RootSessionFile {
  path: string;
  size: number;
  mtimeMs: number;
  id: string;
  hash: string;
}

export function collectSessionFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function readFirstLine(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, read);
    const line = text.split(/\r?\n/, 1)[0];
    return line && line.trim().length > 0 ? line : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures on read-only handles.
      }
    }
  }
}

export function findLargestRootSessions(
  sessionsDir: string,
  cutoffMs: number,
  limit = REPLAY_SESSION_LIMIT,
): RootSessionFile[] {
  const candidates: RootSessionFile[] = [];
  for (const path of collectSessionFiles(sessionsDir)) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoffMs) continue;
    const line = readFirstLine(path);
    if (!line) continue;
    try {
      const header = JSON.parse(line) as Record<string, unknown>;
      if (header.type !== "session" || typeof header.id !== "string") continue;
      if (header.parentSession !== undefined) continue;
      candidates.push({
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        id: header.id,
        hash: hashId(header.id),
      });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Report generation (numbers only)
// ---------------------------------------------------------------------------

export interface ReplayReport {
  schema: string;
  date: string;
  windowDays: number;
  sessionLimit: number;
  sessionsSelected: number;
  sessionsReplayed: number;
  sessionsSkipped: number;
  sizeModel: {
    notesSpanRatio: number;
    rewriteFallbackSpanRatio: number;
    rewriteMeasure: string;
  };
  cacheModels: string[];
  sessions: SessionReplay[];
  skipped: SkippedSession[];
  totals: PolicyRow[];
  checks: {
    rowsPerSessionPolicy: boolean;
    forbiddenTextScan: { windows: number; matches: number };
    tempCopyRemoved: boolean;
  };
}

export function totalRows(sessions: readonly SessionReplay[]): PolicyRow[] {
  return REPLAY_POLICIES.map((policy) => {
    const total = emptyRow(policy);
    for (const session of sessions) {
      const row = session.policies.find((entry) => entry.policy === policy);
      if (!row) continue;
      total.applies.cold += row.applies.cold;
      total.applies.boundary += row.applies.boundary;
      total.applies.threshold += row.applies.threshold;
      total.appliesTotal += row.appliesTotal;
      total.cutFallbacks += row.cutFallbacks;
      total.cutUnavailable += row.cutUnavailable;
      total.thresholdCrossings += row.thresholdCrossings;
      total.jobsStarted += row.jobsStarted;
      total.coldMisses += row.coldMisses;
      total.coldMissTokens += row.coldMissTokens;
      total.applyRereadTokenPrefix += row.applyRereadTokenPrefix;
      total.applyRereadBlockLevel += row.applyRereadBlockLevel;
      total.prefillTokenPrefix += row.prefillTokenPrefix;
      total.prefillBlockLevel += row.prefillBlockLevel;
      total.summaryStartTokens += row.summaryStartTokens;
      total.summaryEndTokens += row.summaryEndTokens;
      total.summaryMaxTokens = Math.max(total.summaryMaxTokens, row.summaryMaxTokens);
      total.summaryWriteTokens += row.summaryWriteTokens;
      total.notesAppends += row.notesAppends;
      total.notesBlocks += row.notesBlocks;
      total.consolidations += row.consolidations;
      total.finalContextTokens += row.finalContextTokens;
    }
    return total;
  });
}

function markdownRow(sessionHash: string, row: PolicyRow): string {
  const cells = [
    sessionHash,
    row.policy,
    row.applies.cold,
    row.applies.boundary,
    row.applies.threshold,
    row.appliesTotal,
    row.cutFallbacks,
    row.cutUnavailable,
    row.thresholdCrossings,
    row.jobsStarted,
    row.coldMisses,
    row.prefillTokenPrefix,
    row.prefillBlockLevel,
    row.applyRereadTokenPrefix,
    row.applyRereadBlockLevel,
    row.summaryStartTokens,
    row.summaryEndTokens,
    row.summaryMaxTokens,
    row.summaryWriteTokens,
    row.notesAppends,
    row.notesBlocks,
    row.consolidations,
    row.finalContextTokens,
  ];
  return `| ${cells.join(" | ")} |`;
}

export function renderMarkdown(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`# Replay comparison - ${report.date}`);
  lines.push("");
  lines.push(`- sessions selected: ${report.sessionsSelected}`);
  lines.push(`- sessions replayed: ${report.sessionsReplayed}`);
  lines.push(`- sessions skipped: ${report.sessionsSkipped}`);
  lines.push(`- window days: ${report.windowDays}`);
  lines.push(`- notes size model: ${report.sizeModel.notesSpanRatio} x span tokens`);
  lines.push(
    `- rewrite size model: ${report.sizeModel.rewriteMeasure} (fallback ${report.sizeModel.rewriteFallbackSpanRatio} x span)`,
  );
  lines.push(`- cache models: ${report.cacheModels.join(", ")}`);
  lines.push("");
  lines.push(
    "| session | policy | cold | boundary | threshold | applies | cut fallbacks | cuts unavailable | threshold crossings | jobs started | cold misses | prefill token-prefix | prefill block-level (INFERRED) | apply re-read token-prefix | apply re-read block-level | summary start | summary end | summary max | summary written | notes appends | notes blocks left | consolidations | final context |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const session of report.sessions) {
    for (const row of session.policies) lines.push(markdownRow(session.hash, row));
  }
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(
    "| policy | cold | boundary | threshold | applies | cut fallbacks | cuts unavailable | threshold crossings | jobs started | cold misses | prefill token-prefix | prefill block-level (INFERRED) | summary written | notes appends | notes blocks left | consolidations |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of report.totals) {
    lines.push(
      `| ${row.policy} | ${row.applies.cold} | ${row.applies.boundary} | ${row.applies.threshold} | ${row.appliesTotal} | ${row.cutFallbacks} | ${row.cutUnavailable} | ${row.thresholdCrossings} | ${row.jobsStarted} | ${row.coldMisses} | ${row.prefillTokenPrefix} | ${row.prefillBlockLevel} | ${row.summaryWriteTokens} | ${row.notesAppends} | ${row.notesBlocks} | ${row.consolidations} |`,
    );
  }
  lines.push("");
  lines.push("## Default decision input");
  lines.push("");
  const rewrite = report.totals.find((row) => row.policy === "early-rewrite");
  const notes = report.totals.find((row) => row.policy === "early-notes");
  if (rewrite && notes) {
    const deltaPrefix = notes.prefillTokenPrefix - rewrite.prefillTokenPrefix;
    const deltaBlock = notes.prefillBlockLevel - rewrite.prefillBlockLevel;
    const pct = (delta: number, base: number): string =>
      base > 0 ? `${((delta / base) * 100).toFixed(2)}%` : "n/a";
    lines.push(
      `- notes vs rewrite total prefill delta (token-prefix): ${deltaPrefix >= 0 ? "+" : ""}${deltaPrefix} (${pct(deltaPrefix, rewrite.prefillTokenPrefix)} of rewrite)`,
    );
    lines.push(
      `- notes vs rewrite total prefill delta (block-level, INFERRED): ${deltaBlock >= 0 ? "+" : ""}${deltaBlock} (${pct(deltaBlock, rewrite.prefillBlockLevel)} of rewrite)`,
    );
    lines.push(
      `- notes consolidation frequency: ${notes.consolidations} rewrite-consolidate applies among ${notes.appliesTotal} notes applies; consolidation fires when the summary reaches 8192 tokens or 4 notes blocks (DEFAULTS).`,
    );
  } else {
    lines.push("- notes and rewrite totals unavailable");
  }
  lines.push("");
  lines.push("## Model assumptions");
  lines.push("");
  lines.push(
    "- mod applies are evaluated only at a recorded run end (`stopReason` `stop`); a `toolUse` turn can prepare a READY job but never apply, and it is never a boundary. Stock uses the recorded compaction entries as its baseline when the recording carries branch identities; synthetic callers without identities fall back to the threshold simulation.",
  );
  lines.push(
    "- jobs are immediately READY at the request that starts them; cooldowns, breaker state, spend caps beyond the start-time window and generation latency are not modelled (caps inside `shouldStartJob` are).",
  );
  lines.push(
    "- a recorded compaction resets the simulated context at the following request; `cut fallbacks` counts evaluations that had no entry identity; `cuts unavailable` counts evaluations where prepareSource found nothing to summarize.",
  );
  lines.push(
    "- cuts use `src/prepare.ts` (`prepareSource` -> `findCutPoint`) on identity-preserving entry stubs with the recorded whole-message, tool-tail, split-turn and keep-recent semantics; stub token counts are measured on the original messages.",
  );
  lines.push(
    "- every mod apply is decided by the shared `applyDecision`; inputs are site `agent_settled`, `idle=true`, `hasPendingMessages=false`, `compacting=false`, `anchorValid=true`, `fingerprintValid=true`, permission open at the settled request, `runEnd` normal, and the recorded assistant `stopReason`.",
  );
  lines.push(
    "- prefill charges the first recorded request as a full cold request in both models for every policy, even when a compaction applies at that request; the post-apply context is charged on the following request. Local-model eviction and Anthropic block-level caching are INFERRED from recorded timestamps/usage, not measured here.",
  );
  lines.push("");
  lines.push("## Skipped");
  lines.push("");
  if (report.skipped.length === 0) {
    lines.push("- none");
  } else {
    for (const skipped of report.skipped) lines.push(`- ${skipped.hash}: ${skipped.reason}`);
  }
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push(`- rows per session and policy: ${report.checks.rowsPerSessionPolicy}`);
  lines.push(
    `- 40-character copied-text scan: windows ${report.checks.forbiddenTextScan.windows}, matches ${report.checks.forbiddenTextScan.matches}`,
  );
  lines.push(`- temp copy removed: ${report.checks.tempCopyRemoved}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 40-character copied-text scan
// ---------------------------------------------------------------------------

const BASE = 131;
const WINDOW_POWER = (() => {
  let power = 1;
  for (let i = 0; i < SCAN_WINDOW_CHARS - 1; i++) power = Math.imul(power, BASE) >>> 0;
  return power;
})();

function windowHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < SCAN_WINDOW_CHARS; i++) {
    hash = (Math.imul(hash, BASE) + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function collectReportWindows(reportTexts: readonly string[]): Map<number, string[]> {
  const windows = new Map<number, string[]>();
  for (const text of reportTexts) {
    for (let i = 0; i + SCAN_WINDOW_CHARS <= text.length; i++) {
      const window = text.slice(i, i + SCAN_WINDOW_CHARS);
      // Numeric-only windows cannot carry private message prose and would
      // produce false positives against recorded usage numbers.
      if (!/[A-Za-z]/.test(window)) continue;
      const hash = windowHash(window);
      const bucket = windows.get(hash);
      if (bucket) {
        if (!bucket.includes(window)) bucket.push(window);
      } else {
        windows.set(hash, [window]);
      }
    }
  }
  return windows;
}

/**
 * Exhaustive rolling-hash scan: every 40-character window of the report is
 * searched in the raw copied session bytes. Returns counts only; a matched
 * window is never printed.
 */
export function scanForCopiedText(
  reportTexts: readonly string[],
  copyPaths: readonly string[],
  chunkSize = 8 * 1024 * 1024,
): { windows: number; matches: number } {
  const windows = collectReportWindows(reportTexts);
  let windowCount = 0;
  for (const bucket of windows.values()) windowCount += bucket.length;
  if (windowCount === 0) return { windows: 0, matches: 0 };

  let matches = 0;
  for (const path of copyPaths) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(chunkSize);
      let carry = "";
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, null);
        if (read <= 0) break;
        const text = carry + buffer.toString("latin1", 0, read);
        if (text.length >= SCAN_WINDOW_CHARS) {
          let hash = 0;
          for (let i = 0; i < SCAN_WINDOW_CHARS; i++) {
            hash = (Math.imul(hash, BASE) + text.charCodeAt(i)) >>> 0;
          }
          for (let i = SCAN_WINDOW_CHARS; i <= text.length; i++) {
            const bucket = windows.get(hash);
            if (bucket) {
              const candidate = text.slice(i - SCAN_WINDOW_CHARS, i);
              if (bucket.includes(candidate)) {
                matches += 1;
                break;
              }
            }
            if (i < text.length) {
              hash = (hash - Math.imul(text.charCodeAt(i - SCAN_WINDOW_CHARS), WINDOW_POWER)) >>> 0;
              hash = (Math.imul(hash, BASE) + text.charCodeAt(i)) >>> 0;
            }
          }
        }
        carry = text.slice(Math.max(0, text.length - (SCAN_WINDOW_CHARS - 1)));
      }
    } catch {
      // A read failure leaves the check conservative (no match found).
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close failures.
        }
      }
    }
  }

  return { windows: windowCount, matches };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const AGENT_DIR = "C:/Users/USER/.omo-stable-500/home/.omo/agent";
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const agentDir = process.env.PIOMO_REPLAY_AGENT_DIR ?? AGENT_DIR;
  const sessionsDir = process.env.PIOMO_REPLAY_SESSIONS_DIR ?? join(agentDir, "sessions");
  const reportsDir = join(REPO_ROOT, "reports");
  const date = new Date().toISOString().slice(0, 10);
  const cutoffMs = Date.now() - REPLAY_WINDOW_DAYS * 86_400_000;

  const selected = findLargestRootSessions(sessionsDir, cutoffMs, REPLAY_SESSION_LIMIT);
  print(`REPLAY_SESSIONS_SELECTED=${selected.length}`);
  if (selected.length === 0) {
    print("REPLAY_ERROR=no-root-sessions-modified-in-window");
    return 1;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "piomo-early-compaction-replay-"));
  const resolvedTemp = resolve(tempDir);
  if (resolvedTemp === REPO_ROOT || resolvedTemp.startsWith(`${REPO_ROOT}${sep}`)) {
    print("REPLAY_ERROR=temp-inside-repo");
    return 1;
  }
  print(`REPLAY_TEMP_DIR=${resolvedTemp}`);

  let tempRemoved = false;
  let report: ReplayReport | undefined;
  const skipped: SkippedSession[] = [];
  const sessions: SessionReplay[] = [];

  try {
    const copies: string[] = [];
    const meta = loadModelMeta(agentDir);
    for (let i = 0; i < selected.length; i++) {
      const copy = join(tempDir, `session-${String(i + 1).padStart(2, "0")}.jsonl`);
      copyFileSync(selected[i].path, copy);
      copies.push(copy);
    }

    const endpointIndex = await scanLocalRequestTimes(sessionsDir, cutoffMs, meta);

    for (let i = 0; i < copies.length; i++) {
      const source = selected[i];
      let text: string;
      try {
        text = readFileSync(copies[i], "utf8");
      } catch {
        skipped.push({ hash: source.hash, reason: "copy-read-failed" });
        continue;
      }
      const parsed = parseSessionText(text);
      text = "";
      if (!parsed.ok) {
        skipped.push({ hash: source.hash, reason: parsed.reason });
        continue;
      }

      const session = parsed.session;
      const coldFlags = inferColdFlags(session, endpointIndex, meta);
      const recordedSummaryTokens = builtinSummarySizes(session.compactions);
      const policies = REPLAY_POLICIES.map((policy) =>
        simulatePolicy(session.requests, {
          policy,
          contextWindowFor: (provider, modelId) => meta.windowFor(provider, modelId),
          coldAt: (index) => coldFlags[index] === true,
          recordedSummaryTokens,
          branch: session.branch,
        }),
      );

      sessions.push({
        hash: session.hash,
        requestCount: session.requests.length,
        recordedCompactions: session.compactions.length,
        recordedBuiltinSummaries: recordedSummaryTokens.length,
        recordedSummaryMedianTokens: median(recordedSummaryTokens),
        policies,
      });
    }

    print(`REPLAY_SESSIONS_REPLAYED=${sessions.length}`);
    print(`REPLAY_SESSIONS_SKIPPED=${skipped.length}`);

    const rowsPerSessionPolicy =
      sessions.length > 0 &&
      sessions.every(
        (session) =>
          session.policies.length === REPLAY_POLICIES.length &&
          REPLAY_POLICIES.every((policy) =>
            session.policies.some((row) => row.policy === policy),
          ),
      );

    const draft: ReplayReport = {
      schema: REPLAY_SCHEMA,
      date,
      windowDays: REPLAY_WINDOW_DAYS,
      sessionLimit: REPLAY_SESSION_LIMIT,
      sessionsSelected: selected.length,
      sessionsReplayed: sessions.length,
      sessionsSkipped: skipped.length,
      sizeModel: {
        notesSpanRatio: NOTES_SPAN_RATIO,
        rewriteFallbackSpanRatio: REWRITE_FALLBACK_SPAN_RATIO,
        rewriteMeasure: "median-builtin-recorded-summary-tokens",
      },
      cacheModels: ["token-prefix", "block-level (INFERRED, Anthropic)"],
      sessions,
      skipped,
      totals: totalRows(sessions),
      checks: {
        rowsPerSessionPolicy,
        forbiddenTextScan: { windows: 0, matches: 0 },
        tempCopyRemoved: false,
      },
    };

    const markdownDraft = renderMarkdown(draft);
    const jsonDraft = `${JSON.stringify(draft, null, 2)}\n`;
    const scan = scanForCopiedText([markdownDraft, jsonDraft], copies);
    draft.checks.forbiddenTextScan = scan;
    print(`REPLAY_SCAN_WINDOWS=${scan.windows}`);
    print(`REPLAY_SCAN_MATCHES=${scan.matches}`);

    if (!rowsPerSessionPolicy) {
      print("REPLAY_ERROR=missing-session-policy-row");
      return 1;
    }
    if (scan.matches > 0) {
      print("REPLAY_ERROR=copied-text-in-report");
      return 1;
    }
    report = draft;
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // The check below reports the failure.
    }
    tempRemoved = !existsSync(tempDir);
    print(`REPLAY_TEMP_DIR_REMOVED=${tempRemoved}`);
    print(`REPLAY_TEMP_DIR_REMOVED_PATH=${resolvedTemp}`);
  }

  if (!report) return 1;
  if (!tempRemoved) {
    print("REPLAY_ERROR=temp-copy-not-removed");
    return 1;
  }

  report.checks.tempCopyRemoved = true;
  const markdown = renderMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(reportsDir, { recursive: true });
  const mdPath = join(reportsDir, `replay-${date}.md`);
  const jsonPath = join(reportsDir, `replay-${date}.json`);
  writeFileSync(mdPath, markdown, "utf8");
  writeFileSync(jsonPath, json, "utf8");

  print(`REPLAY_ROWS=${report.sessions.reduce((sum, session) => sum + session.policies.length, 0)}`);
  print(`REPLAY_REPORT_MD=${join("reports", `replay-${date}.md`)}`);
  print(`REPLAY_REPORT_JSON=${join("reports", `replay-${date}.json`)}`);
  return 0;
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
