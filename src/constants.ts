/**
 * Shared constants for the early-compaction mod.
 *
 * A notes summary is the previous summary followed by one header line and the
 * five fixed sections. Todo 7 writes the header; todos 7 and 15 read it back.
 */
import { estimateTokens } from "@code-yeongyu/senpi";

/**
 * One notes header line, exactly as written by todo 7:
 *
 *   Notes added <ISO-8601 UTC> for entries <firstSpanEntryId>..<lastSpanEntryId>. Later notes supersede earlier Remaining Tasks / Exact Next Steps where they conflict.
 *
 * `m` makes `^`/`$` line anchors; there is intentionally no `g`, so `test()`
 * is stateless. The ISO timestamp accepts seconds with optional milliseconds,
 * matching `Date.prototype.toISOString()`.
 */
export const NOTES_HEADER_RE =
  /^Notes added \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z for entries [^\s.]+\.\.[^\s.]+\. Later notes supersede earlier Remaining Tasks \/ Exact Next Steps where they conflict\.$/m;

/** The five section titles of a notes block, in write order (todo 7). */
export const NOTES_SECTION_TITLES = [
  "New user requests",
  "New constraints",
  "Work done",
  "Current state and files",
  "Current next steps",
] as const;

export type NotesSectionTitle = (typeof NOTES_SECTION_TITLES)[number];

/**
 * Token measure of a compaction summary: `estimateTokens` of the
 * `compactionSummary` message the model actually receives. The builtin
 * estimator counts `summary.length / 4` for that role; building the message
 * keeps this measure identical if the estimator changes.
 */
export function summaryTokens(summary: string): number {
  const message = {
    role: "compactionSummary" as const,
    summary,
    tokensBefore: 0,
    timestamp: 0,
  };
  return estimateTokens(message as unknown as Parameters<typeof estimateTokens>[0]);
}
