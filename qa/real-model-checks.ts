/**
 * Pure checks for the one isolated real-model run (todo 16).
 *
 * Nothing here performs I/O or a model call. The runner uses these functions
 * for its --dry-run self-checks and for the two retention checks after the
 * paid attempt; the unit test exercises the same boundaries.
 */
import { NOTES_HEADER_RE, NOTES_SECTION_TITLES } from "../src/constants";

/** The only model the real-model run may call. */
export const REAL_MODEL_ID = "ollama/deepseek-v4.1-flash";

/** One planted verbatim instruction or file path. */
export interface PlantedItem {
  readonly id: string;
  readonly text: string;
}

/** Counts of planted items kept verbatim. */
export interface RetentionResult {
  readonly total: number;
  readonly matched: number;
  readonly matchedIds: string[];
  readonly missingIds: string[];
}

/** Result of the five-title check. */
export interface SectionTitleResult {
  readonly ok: boolean;
  readonly found: string[];
  readonly missing: string[];
}

/** Guard used before any registry read or model call. */
export function checkModelId(
  modelId: string | undefined | null,
): { ok: boolean; reason?: "missing-model" | "other-model" } {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  if (trimmed === "") return { ok: false, reason: "missing-model" };
  if (trimmed !== REAL_MODEL_ID) return { ok: false, reason: "other-model" };
  return { ok: true };
}

/**
 * The notes block is everything after the last notes header line. A summary
 * with no header yields null; an earlier summary is never part of the block.
 */
export function extractNotesBlock(summary: string): string | null {
  const lines = summary.split("\n");
  let header = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (NOTES_HEADER_RE.test(lines[index] ?? "")) header = index;
  }
  if (header < 0) return null;
  return lines.slice(header + 1).join("\n");
}

/** Exact-substring retention count (verbatim means includes()). */
export function countRetention(
  text: string | null | undefined,
  items: readonly PlantedItem[],
): RetentionResult {
  const haystack = text ?? "";
  const matchedIds: string[] = [];
  const missingIds: string[] = [];
  for (const item of items) {
    (haystack.includes(item.text) ? matchedIds : missingIds).push(item.id);
  }
  return {
    total: items.length,
    matched: matchedIds.length,
    matchedIds,
    missingIds,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A title counts only as a Markdown heading line (1-6 hashes, optional
 * trailing colon). Mentioning the title in prose does not satisfy the check.
 */
export function checkSectionTitles(
  text: string | null | undefined,
  titles: readonly string[] = NOTES_SECTION_TITLES,
): SectionTitleResult {
  const haystack = text ?? "";
  const found: string[] = [];
  const missing: string[] = [];
  for (const title of titles) {
    const pattern = new RegExp(
      `^#{1,6}\\s*${escapeRegExp(title)}\\s*:?\\s*$`,
      "mi",
    );
    (pattern.test(haystack) ? found : missing).push(title);
  }
  return { ok: missing.length === 0, found, missing };
}
