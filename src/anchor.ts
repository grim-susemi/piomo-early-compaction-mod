import { createHash } from "node:crypto";

/**
 * The warm-summary anchor shape accepted by `ApplyCompactionOptions.expectedWarmAnchor`
 * (senpi `extensions/types.d.ts`). Only the three fields below are read.
 */
export interface WarmAnchorSnapshot {
  firstKeptEntryId: string;
  prefixEntryIds: readonly string[];
  latestCompactionEntryId: string | null;
}

/**
 * The minimum structural shape of a session-branch entry: every entry has an id and
 * a type, and only those two fields are needed by the anchor logic.
 */
export interface AnchorEntry {
  readonly id: string;
  readonly type: string;
}

/**
 * Exact port of senpi's internal `createWarmAnchorSnapshot`
 * (`dist/core/compaction/warm-anchor.js`). Keep the body identical in behaviour:
 * find the entry by id, return undefined when it is absent, otherwise record the
 * ids before it and the last compaction entry id in the whole branch.
 */
export function createWarmAnchorSnapshot(
  firstKeptEntryId: string,
  branchEntries: readonly AnchorEntry[],
): WarmAnchorSnapshot | undefined {
  const anchorIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (anchorIndex === -1) return undefined;
  return {
    firstKeptEntryId,
    prefixEntryIds: branchEntries.slice(0, anchorIndex).map((entry) => entry.id),
    latestCompactionEntryId: latestCompactionEntryId(branchEntries),
  };
}

function latestCompactionEntryId(entries: readonly AnchorEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "compaction") return entry.id;
  }
  return null;
}

/**
 * Pure validity check with the same shape as senpi's internal
 * `isWarmSummaryAnchorValid`: the cut entry must still exist at the same position,
 * the prefix ids must be unchanged, and the branch's last compaction entry must be
 * the one the snapshot saw. Growth after the cut is allowed.
 */
export function anchorMatches(
  snapshot: WarmAnchorSnapshot | undefined,
  branchEntries: readonly AnchorEntry[],
): boolean {
  if (snapshot === undefined) return false;
  const anchorIndex = branchEntries.findIndex((entry) => entry.id === snapshot.firstKeptEntryId);
  if (anchorIndex === -1) return false;
  if (latestCompactionEntryId(branchEntries) !== snapshot.latestCompactionEntryId) return false;
  if (anchorIndex !== snapshot.prefixEntryIds.length) return false;
  for (let index = 0; index < anchorIndex; index++) {
    if (branchEntries[index]?.id !== snapshot.prefixEntryIds[index]) return false;
  }
  return true;
}

/**
 * Semantic fingerprint of the summarized prefix.
 *
 * Byte layout hashed (UTF-8, lowercase hex sha256):
 *
 *   "piomo.early-compaction.anchor-fingerprint.v1\n"
 *   "summary:absent\n"                                  if previousSummary is undefined
 *   "summary:<utf8 byte length>:<previousSummary>\n"     otherwise
 *   "prefix:" + canonicalJson(prefixEntries)            no trailing newline
 *
 * `canonicalJson` is JSON with no insignificant whitespace, object keys sorted at
 * every depth by UTF-16 code-unit order, array order preserved, and `undefined`
 * object properties dropped exactly as `JSON.stringify` drops them. Because the
 * prefix JSON is the final segment and the summary is length-prefixed, the layout
 * is unambiguous for any JSON-shaped entry data.
 */
export function fingerprint(
  previousSummary: string | undefined,
  prefixEntries: readonly unknown[],
): string {
  const summaryPart =
    previousSummary === undefined
      ? "summary:absent\n"
      : `summary:${Buffer.byteLength(previousSummary, "utf8")}:${previousSummary}\n`;
  const bytes =
    "piomo.early-compaction.anchor-fingerprint.v1\n" +
    summaryPart +
    "prefix:" +
    canonicalJson(prefixEntries);
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) result[key] = canonicalize(item);
    }
    return result;
  }
  return value;
}
