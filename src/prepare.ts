/**
 * Source preparation for early compaction, built only from public senpi
 * pieces.
 *
 * `prepareCompaction` is not exported (SENPI/dist/index.d.ts), so this module
 * reconstructs the same analysis input from:
 *
 *   - `buildSessionProjection` -- the canonical, compaction-aware and
 *     context-edit-aware context,
 *   - `findCutPoint` -- the builtin's keep-recent cut algorithm,
 *   - `estimateTokens` -- the builtin's token measure,
 *   - `computeEffectiveKeepRecentTokens` from `./policy.ts`.
 *
 * The projection is flattened into analysis-only session entries (never
 * persisted) so `findCutPoint` sees the same context-visible messages, the
 * same metadata gaps, and the same tool-result tails the builtin's projected
 * cut point sees. A split turn is not summarized separately here: the whole
 * removed prefix (history + turn prefix) is returned as `spanMessages`, which
 * matches how the builtin feeds `messagesToSummarize` and
 * `turnPrefixMessages` to one summarization call.
 */
import {
  buildSessionProjection,
  calculateContextTokens,
  estimateTokens,
  findCutPoint,
  type SessionEntry,
  type SessionProjection,
} from "@code-yeongyu/senpi";
import {
  dropFailedAssistantTurns,
  getCurrentSystemMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import { computeEffectiveKeepRecentTokens } from "./policy";

type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;

/** Compaction settings consumed here. Other settings are irrelevant to the cut. */
export interface PrepareSettings {
  keepRecentTokens: number;
  reserveTokens: number;
}

export interface PrepareSourceInput {
  /** `ctx.sessionManager.getBranch()`. */
  branchEntries: readonly SessionEntry[];
  /** The session model's context window. */
  contextWindow: number;
  /** The builtin threshold ratio for this window (from `./policy.ts`). */
  thresholdRatio: number;
  settings: PrepareSettings;
}

/**
 * The source snapshot a summarization job renders. `spanMessages` is the
 * entire removed prefix in projection order, including a split turn's prefix.
 */
export interface PreparedSource {
  previousSummary?: string;
  spanMessages: SessionMessageEntry["message"][];
  firstKeptEntryId: string;
  tokensBefore: number;
  firstSpanEntryId: string;
  lastSpanEntryId: string;
  isSplitTurn: boolean;
  keepRecentEff: number;
}

function assistantUsage(message: SessionMessageEntry["message"]): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
  const usage = (message as { usage?: Usage }).usage;
  if (!usage) return undefined;
  return calculateContextTokens(usage) > 0 ? usage : undefined;
}

/**
 * Port of the builtin `estimateProjectedContextTokens`: trust the newest
 * assistant usage unless an edit or compaction happened after it, otherwise
 * estimate the projected messages (excluding failed assistant turns).
 */
function estimateProjectedContextTokens(
  projection: SessionProjection,
  branchEntries: readonly SessionEntry[],
): number {
  const messages = projection.messages;
  const counted = new Set(dropFailedAssistantTurns(messages));

  let lastUsageIndex = -1;
  let usage: Usage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!counted.has(messages[i])) continue;
    const found = assistantUsage(messages[i] as SessionMessageEntry["message"]);
    if (found) {
      usage = found;
      lastUsageIndex = i;
      break;
    }
  }

  if (usage) {
    let projectedMessageIndex = 0;
    let usageEntryId: string | undefined;
    for (const entry of projection.entries) {
      const nextMessageIndex = projectedMessageIndex + entry.messages.length;
      if (lastUsageIndex < nextMessageIndex) {
        usageEntryId = entry.sourceEntry.id;
        break;
      }
      projectedMessageIndex = nextMessageIndex;
    }

    const usageEntryIndex = usageEntryId
      ? branchEntries.findIndex((entry) => entry.id === usageEntryId)
      : -1;
    let latestInvalidatingEntryIndex = -1;
    for (let i = branchEntries.length - 1; i >= 0; i--) {
      const entry = branchEntries[i];
      if (entry.type === "context_edit" || entry.type === "compaction") {
        latestInvalidatingEntryIndex = i;
        break;
      }
    }

    if (usageEntryIndex > latestInvalidatingEntryIndex) {
      let trailingTokens = 0;
      for (let i = lastUsageIndex + 1; i < messages.length; i++) {
        if (counted.has(messages[i])) trailingTokens += estimateTokens(messages[i]);
      }
      return calculateContextTokens(usage) + trailingTokens;
    }
  }

  const system = getCurrentSystemMessage(
    messages as unknown as Parameters<typeof getCurrentSystemMessage>[0],
  );
  let tokens = system ? estimateTokens(system as unknown as Parameters<typeof estimateTokens>[0]) : 0;
  for (const message of counted) {
    if (message.role !== "system") tokens += estimateTokens(message);
  }
  return tokens;
}

/**
 * Flatten the canonical projection into analysis-only entries.
 *
 * Every non-compaction projected entry keeps its source identity. Entries that
 * contribute no model message (metadata, or a message omitted by a
 * `context_edit`) become context-invisible placeholders, so `findCutPoint`
 * skips over them exactly like the builtin's projected cut walk. The previous
 * compaction is excluded: the builtin starts its cut after it and passes its
 * summary separately.
 */
function buildAnalysisEntries(projection: SessionProjection): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const projected of projection.entries) {
    const sourceEntry = projected.sourceEntry;
    if (sourceEntry.type === "compaction") continue;

    if (projected.messages.length === 0) {
      entries.push({
        id: sourceEntry.id,
        parentId: sourceEntry.parentId,
        timestamp: sourceEntry.timestamp,
        type: "custom",
        customType: "piomo.early-compaction.projected-empty",
      });
      continue;
    }

    for (const message of projected.messages) {
      entries.push({ ...sourceEntry, type: "message", message } as SessionEntry);
    }
  }
  return entries;
}

function isSpanMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message" && entry.message.role !== "system";
}

/**
 * Prepare the summarization source from the branch.
 *
 * Returns `null` when nothing would be summarized (an empty span), including a
 * branch that ends at its own compaction.
 */
export function prepareSource(input: PrepareSourceInput): PreparedSource | null {
  const { branchEntries, contextWindow, thresholdRatio, settings } = input;
  const keepRecentEff = computeEffectiveKeepRecentTokens(
    settings.keepRecentTokens,
    contextWindow,
    thresholdRatio,
  );

  const projection = buildSessionProjection([...branchEntries]);
  const analysisEntries = buildAnalysisEntries(projection);
  if (analysisEntries.length === 0) return null;

  const cut = findCutPoint(analysisEntries, 0, analysisEntries.length, keepRecentEff);
  const firstKeptEntry = analysisEntries[cut.firstKeptEntryIndex];
  if (!firstKeptEntry) return null;

  const spanEntries = analysisEntries.slice(0, cut.firstKeptEntryIndex);
  const spanEntryMessages = spanEntries.filter(isSpanMessageEntry);
  const spanMessages = spanEntryMessages.map((entry) => entry.message);
  if (spanMessages.length === 0) return null;

  const previousCompaction = projection.entries.find(
    (entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
  )?.sourceEntry;
  const previousSummary =
    previousCompaction?.type === "compaction" ? previousCompaction.summary : undefined;

  return {
    previousSummary,
    spanMessages,
    firstKeptEntryId: firstKeptEntry.id,
    tokensBefore: estimateProjectedContextTokens(projection, branchEntries),
    firstSpanEntryId: spanEntryMessages[0].id,
    lastSpanEntryId: spanEntryMessages[spanEntryMessages.length - 1].id,
    isSplitTurn: cut.isSplitTurn,
    keepRecentEff,
  };
}
