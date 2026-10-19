import { describe, expect, test } from "bun:test";
import { NOTES_SECTION_TITLES } from "../src/constants";
import {
  REAL_MODEL_ID,
  checkModelId,
  checkSectionTitles,
  countRetention,
  extractNotesBlock,
} from "../qa/real-model-checks";

const HEADER =
  "Notes added 2026-10-19T12:00:00.000Z for entries entry-a..entry-b. " +
  "Later notes supersede earlier Remaining Tasks / Exact Next Steps where they conflict.";

const ITEMS = [
  { id: "S1", text: "Keep the fallback port at 43117." },
  { id: "S2", text: "Do not rename qa/fixtures/synthetic-catalog.csv." },
  { id: "S3", text: "The retention threshold must stay at 0.72." },
  { id: "S4", text: "C:\\Users\\USER\\orca\\projects\\synthetic-demo\\src\\widget.ts" },
  { id: "S5", text: "Report the digest as SHA-256 in the handoff." },
];

describe("notes block extraction", () => {
  test("returns only the text after the last notes header", () => {
    const summary = [
      "## 1. User Requests (Verbatim)",
      "- earlier item",
      "",
      "---",
      HEADER,
      "## New user requests",
      "- new item",
    ].join("\n");
    const block = extractNotesBlock(summary);
    expect(block).toBe("## New user requests\n- new item");
    expect(block).not.toContain("earlier item");
  });

  test("returns null without a header", () => {
    expect(extractNotesBlock("## 1. User Requests (Verbatim)\n- none")).toBeNull();
  });

  test("uses the last header when a summary already has notes", () => {
    const first = "Notes added 2026-10-18T00:00:00.000Z for entries a..b. Later notes supersede earlier Remaining Tasks / Exact Next Steps where they conflict.";
    const second = "Notes added 2026-10-19T00:00:00.000Z for entries c..d. Later notes supersede earlier Remaining Tasks / Exact Next Steps where they conflict.";
    const block = extractNotesBlock([first, "old block", second, "new block"].join("\n"));
    expect(block).toBe("new block");
  });
});

describe("retention counting", () => {
  test("counts exactly the items present verbatim", () => {
    const text = [
      "- Keep the fallback port at 43117.",
      "- Do not rename qa/fixtures/synthetic-catalog.csv.",
      "- The retention threshold must stay at 0.72.",
      "- Report the digest as SHA-256 in the handoff.",
    ].join("\n");
    const result = countRetention(text, ITEMS);
    expect(result.total).toBe(5);
    expect(result.matched).toBe(4);
    expect(result.matchedIds).toEqual(["S1", "S2", "S3", "S5"]);
    expect(result.missingIds).toEqual(["S4"]);
  });

  test("a paraphrase does not count", () => {
    const result = countRetention("Keep the fallback port at 43118.", ITEMS);
    expect(result.matched).toBe(0);
    expect(result.missingIds).toEqual(["S1", "S2", "S3", "S4", "S5"]);
  });

  test("null text matches nothing", () => {
    const result = countRetention(null, ITEMS);
    expect(result.matched).toBe(0);
    expect(result.total).toBe(5);
  });
});

describe("section titles", () => {
  const complete = NOTES_SECTION_TITLES.map((title) => `## ${title}`).join("\n");
  const withColon = NOTES_SECTION_TITLES.map((title) => `### ${title}:`).join("\n");

  test("all five headings pass", () => {
    for (const text of [complete, withColon]) {
      const result = checkSectionTitles(text);
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.found).toHaveLength(5);
    }
  });

  test("a missing heading is named", () => {
    const text = complete.replace("## Current next steps", "Current next steps");
    const result = checkSectionTitles(text);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["Current next steps"]);
  });

  test("prose mentions are not headings", () => {
    const text = "The model writes New user requests and New constraints.";
    const result = checkSectionTitles(text);
    expect(result.found).toEqual([]);
    expect(result.missing).toHaveLength(5);
  });
});

describe("model id guard", () => {
  test("accepts only the exact allowed id", () => {
    expect(checkModelId(REAL_MODEL_ID)).toEqual({ ok: true });
    expect(checkModelId("  ollama/deepseek-v4.1-flash  ")).toEqual({ ok: true });
  });

  test("rejects other models and missing ids", () => {
    expect(checkModelId("ollama/deepseek-v4.1-flash:1017")).toEqual({
      ok: false,
      reason: "other-model",
    });
    expect(checkModelId("ollama/does-not-exist")).toEqual({
      ok: false,
      reason: "other-model",
    });
    expect(checkModelId("")).toEqual({ ok: false, reason: "missing-model" });
    expect(checkModelId(undefined)).toEqual({ ok: false, reason: "missing-model" });
  });
});
