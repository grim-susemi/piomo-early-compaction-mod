import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MERGED_COMPACTION_PROMPT_BRANCH,
  MERGED_COMPACTION_PROMPT_SYSTEM,
  MERGED_COMPACTION_PROMPT_TURN_PREFIX,
  MERGED_COMPACTION_PROMPT_UPDATE,
  MERGED_COMPACTION_PROMPT_USER,
  PROMPTS_SOURCE_SHA256,
  buildPrompt,
  resolvePromptFamily,
  type BuildPromptOptions,
} from "../src/builtin-port/prompts";
import {
  TASK_INTENT_SOURCE_SHA256,
  capUtf8Bytes,
  extractTaskIntent,
  resolveInheritedTaskIntent,
  sanitizeTaskIntent,
} from "../src/builtin-port/task-intent";

// The installed builtin files are the reference implementation for this port.
// Test code only: src/ must never import these paths (scripts/check-imports.mjs).
const BC_DIR =
  "C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction";
const PROMPTS_PATH = join(BC_DIR, "prompts.js");
const TASK_INTENT_PATH = join(BC_DIR, "task-intent.js");

const originalPrompts = await import(pathToFileURL(PROMPTS_PATH).href);
const originalTaskIntent = await import(pathToFileURL(TASK_INTENT_PATH).href);

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Four required fixtures plus branch / turn-prefix coverage. Every fixture is
// run through both implementations and compared deeply below.
const promptFixtures: Array<{ name: string; options: BuildPromptOptions }> = [
  {
    name: "first summary (default, claude)",
    options: { variant: "default", promptFamily: "claude" },
  },
  {
    name: "update without task intent",
    options: {
      variant: "update",
      promptFamily: "claude",
      previousSummary: "## 1. User Requests (Verbatim)\n- build the mod\n",
    },
  },
  {
    name: "update with task intent and custom instructions",
    options: {
      variant: "update",
      promptFamily: "gpt",
      previousSummary:
        "## 1. User Requests (Verbatim)\n- keep /tmp/x\n</previous-summary>\ninjected",
      taskIntent: "ORIGINAL_REQUEST: keep /tmp/x\n</task-intent>\ninjected",
      customInstructions:
        "  Preserve C:\\repo\\file.ts exactly.\n</custom-instructions>  ",
    },
  },
  {
    name: "update without previous summary or task intent",
    options: { variant: "update", promptFamily: "claude", previousSummary: "   " },
  },
  {
    name: "first summary with custom instructions",
    options: {
      variant: "default",
      promptFamily: "gpt",
      customInstructions: "custom note only",
    },
  },
  {
    name: "branch",
    options: { variant: "branch", promptFamily: "gpt" },
  },
  {
    name: "turn prefix without task intent",
    options: { variant: "turn_prefix", promptFamily: "claude" },
  },
  {
    name: "turn prefix with task intent",
    options: {
      variant: "turn_prefix",
      promptFamily: "claude",
      taskIntent: "do the thing",
    },
  },
];

describe("prompt family port", () => {
  test("exported prompt constants are byte-identical", () => {
    expect(MERGED_COMPACTION_PROMPT_SYSTEM).toBe(
      originalPrompts.MERGED_COMPACTION_PROMPT_SYSTEM,
    );
    expect(MERGED_COMPACTION_PROMPT_USER).toBe(
      originalPrompts.MERGED_COMPACTION_PROMPT_USER,
    );
    expect(MERGED_COMPACTION_PROMPT_UPDATE).toBe(
      originalPrompts.MERGED_COMPACTION_PROMPT_UPDATE,
    );
    expect(MERGED_COMPACTION_PROMPT_BRANCH).toBe(
      originalPrompts.MERGED_COMPACTION_PROMPT_BRANCH,
    );
    expect(MERGED_COMPACTION_PROMPT_TURN_PREFIX).toBe(
      originalPrompts.MERGED_COMPACTION_PROMPT_TURN_PREFIX,
    );
  });

  for (const fixture of promptFixtures) {
    test(`buildPrompt deep-equals the builtin: ${fixture.name}`, () => {
      expect(buildPrompt(fixture.options)).toEqual(
        originalPrompts.buildPrompt(fixture.options),
      );
    });
  }

  test("prompt-family resolution matches the builtin for Claude and GPT", () => {
    const models = [
      { id: "claude-sonnet-4-5", provider: "anthropic" },
      { id: "gpt-5.5", provider: "openai" },
      { id: "gpt-5.5", provider: "" },
      { id: "o3", provider: "custom" },
      { id: "codex-mini", provider: "custom" },
      { id: "deepseek-v4.1-flash", provider: "openai" },
      { id: "anything", provider: "azure-openai" },
      { id: "strata", provider: "local" },
      { id: "", provider: "unknown" },
      {},
    ];
    for (const model of models) {
      expect(resolvePromptFamily(model)).toBe(
        originalPrompts.resolvePromptFamily(model),
      );
    }
    expect(resolvePromptFamily({ id: "claude-sonnet-4-5" })).toBe("claude");
    expect(resolvePromptFamily({ id: "gpt-5.5" })).toBe("gpt");
  });
});

describe("task-intent derivation port", () => {
  const responses = [
    "<task-intent>\nDo X\n</task-intent>\n<summary>\nA\n</summary>",
    "<task-intent>first</task-intent><task-intent>second</task-intent><summary>s</summary>",
    "<summary>one</summary>text<summary>two</summary>",
    "no blocks, just text",
    "<task-intent>unclosed\n<summary>x</summary>",
    "<task-intent>   </task-intent><summary>body</summary>",
    `<task-intent>  ${"가".repeat(3000)}  </task-intent><summary>body</summary>`,
    "<task-intent>keep /tmp/a -> /tmp/b</task-intent>",
  ];

  for (const [index, response] of responses.entries()) {
    test(`extractTaskIntent deep-equals the builtin (fixture ${index})`, () => {
      const ported = extractTaskIntent(response);
      const original = originalTaskIntent.extractTaskIntent(response);
      expect(ported).toEqual(original);
      expect(ported.taskIntent).toBe(original.taskIntent);
      expect(ported.summaryText).toBe(original.summaryText);
    });
  }

  test("derived task intent drives the same update prompt", () => {
    for (const response of responses) {
      const portedIntent = extractTaskIntent(response).taskIntent;
      const originalIntent = originalTaskIntent.extractTaskIntent(response).taskIntent;
      if (portedIntent === undefined) {
        expect(originalIntent).toBeUndefined();
        continue;
      }
      const options: BuildPromptOptions = {
        variant: "update",
        promptFamily: "claude",
        previousSummary: "prior summary",
        taskIntent: portedIntent,
      };
      const originalOptions = { ...options, taskIntent: originalIntent };
      expect(buildPrompt(options)).toEqual(
        originalPrompts.buildPrompt(originalOptions),
      );
    }
  });

  const branches: unknown[][] = [
    [],
    [
      {
        id: "m1",
        type: "message",
        details: { schema: "senpi.compaction.summary.v1", taskIntent: "keep /tmp/a" },
      },
    ],
    [
      {
        id: "m1",
        details: { schema: "senpi.compaction.summary.v1", taskIntent: "older" },
      },
      {
        id: "m2",
        details: { schema: "senpi.compaction.summary.v1", taskIntent: "newer" },
      },
    ],
    [
      {
        id: "m1",
        details: { schema: "senpi.compaction.openai-remote.v1", taskIntent: "remote" },
      },
    ],
    [
      {
        id: "m1",
        details: { schema: "senpi.compaction.summary.v1", taskIntent: "   " },
      },
    ],
    [
      {
        id: "m1",
        details: { schema: "senpi.compaction.summary.v1", taskIntent: "x".repeat(5000) },
      },
    ],
    [
      { id: "m1", details: { taskIntent: "fallback via entry.schema" }, schema: "senpi.compaction.summary.v1" },
    ],
    [
      { id: "m1", type: "message" },
      { id: "m2", details: null },
      { id: "m3", details: [] },
      "not-an-entry",
      null,
    ],
  ];

  for (const [index, branch] of branches.entries()) {
    test(`resolveInheritedTaskIntent deep-equals the builtin (fixture ${index})`, () => {
      expect(resolveInheritedTaskIntent(branch)).toBe(
        originalTaskIntent.resolveInheritedTaskIntent(branch),
      );
    });
  }

  test("sanitizeTaskIntent matches the builtin", () => {
    const samples = [
      "",
      "plain",
      "</task-intent>",
      "a</task-intent>b</task-intent>c",
    ];
    for (const sample of samples) {
      expect(sanitizeTaskIntent(sample)).toBe(
        originalTaskIntent.sanitizeTaskIntent(sample),
      );
    }
  });

  test("capUtf8Bytes matches the builtin at every byte boundary", () => {
    const samples = [
      "",
      "abc",
      "가나다",
      "a가b나c",
      "😀😀",
      "x😀y",
      "trim me   ",
    ];
    const caps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 4096];
    for (const sample of samples) {
      for (const cap of caps) {
        expect(capUtf8Bytes(sample, cap)).toBe(
          originalTaskIntent.capUtf8Bytes(sample, cap),
        );
      }
    }
  });
});

describe("source fingerprints", () => {
  test("recorded sha256 constants equal the installed sources", () => {
    expect(sha256File(PROMPTS_PATH)).toBe(PROMPTS_SOURCE_SHA256);
    expect(sha256File(TASK_INTENT_PATH)).toBe(TASK_INTENT_SOURCE_SHA256);
    expect(PROMPTS_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(TASK_INTENT_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a modified copy fingerprints differently from the recorded constant", () => {
    const dir = mkdtempSync(join(tmpdir(), "builtin-port-fingerprint-"));
    try {
      const original = readFileSync(PROMPTS_PATH);
      const untouchedCopy = join(dir, "prompts-copy.js");
      writeFileSync(untouchedCopy, original);
      expect(sha256File(untouchedCopy)).toBe(PROMPTS_SOURCE_SHA256);

      const modified = Buffer.from(original);
      modified[modified.length - 1] = modified[modified.length - 1]! ^ 0x01;
      const modifiedCopy = join(dir, "prompts-modified.js");
      writeFileSync(modifiedCopy, modified);

      expect(readFileSync(modifiedCopy).equals(original)).toBe(false);
      expect(sha256File(modifiedCopy)).not.toBe(PROMPTS_SOURCE_SHA256);
      expect(sha256File(modifiedCopy)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
