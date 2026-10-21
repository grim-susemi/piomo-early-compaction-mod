import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { buildPrompt, resolvePromptFamily } from "../src/builtin-port/prompts";
import { NOTES_HEADER_RE, NOTES_SECTION_TITLES } from "../src/constants";
import {
  NOTES_PROMPT_SYSTEM,
  buildNotesPrompt,
  countNotesBlocks,
  generateCompaction,
  notesHeader,
  outputCap,
  REWRITE_SUMMARY_CAP_RATIO,
  type GenerateAuth,
  type GenerateCompactionSettings,
  type GenerateCompleteOptions,
  type GenerateContext,
} from "../src/generate";
import type { PreparedSource } from "../src/prepare";

const SUMMARY_MODEL = "summarizer";
const SUMMARY_PROVIDER = "test-provider";

// Compile-time proof that todo 11 can pass the live extension context to
// `generateCompaction` without a cast.
const liveContext: GenerateContext = {} as unknown as ExtensionContext;
void liveContext;

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: SUMMARY_MODEL,
    name: SUMMARY_MODEL,
    api: "openai-completions",
    provider: SUMMARY_PROVIDER,
    baseUrl: "https://api.example.test/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    reasoning: false,
    ...overrides,
  };
}

function usage(output: number, input = 10): AssistantMessage["usage"] {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(
  text: string,
  options: { outputTokens?: number; stopReason?: AssistantMessage["stopReason"] } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: SUMMARY_PROVIDER,
    model: SUMMARY_MODEL,
    usage: usage(options.outputTokens ?? 100),
    stopReason: options.stopReason ?? "stop",
    timestamp: 0,
  };
}

function source(overrides: Partial<PreparedSource> = {}): PreparedSource {
  return {
    previousSummary: "## 6. Remaining Tasks\n- finish todo 7",
    spanMessages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Keep C:\\repo\\file.ts exactly.\n${"u".repeat(20_000)}` },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Todo 7 implemented." }],
        timestamp: 2,
      },
    ] as unknown as PreparedSource["spanMessages"],
    firstKeptEntryId: "keep-1",
    tokensBefore: 10_000,
    firstSpanEntryId: "entry-1",
    lastSpanEntryId: "entry-2",
    isSplitTurn: false,
    keepRecentEff: 20_000,
    ...overrides,
  };
}

const NOTES_OUTPUT = `## New user requests
- Keep C:\\repo\\file.ts exactly.

## New constraints
- Do not edit settings.json.

## Work done
- Implemented todo 7.

## Current state and files
- C:\\repo\\file.ts is unchanged.

## Current next steps
- Run bun test test/generate.test.ts.`;

interface FakeRegistryOptions {
  settings?: GenerateCompactionSettings;
  sessionModel?: Model<Api>;
  summarizer?: Model<Api>;
  findModel?: (provider: string, modelId: string) => Model<Api> | undefined;
  auth?: GenerateAuth;
  branch?: unknown[];
  complete?: (
    model: Model<Api>,
    context: Context,
    options: GenerateCompleteOptions,
  ) => Promise<AssistantMessage>;
}

interface MockCall {
  model: Model<Api>;
  context: Context;
  options: GenerateCompleteOptions;
}

function makeContext(options: FakeRegistryOptions = {}) {
  const calls: MockCall[] = [];
  const summarizer = options.summarizer ?? makeModel();
  const sessionModel =
    options.sessionModel ?? makeModel({ id: "session-model", provider: "local", baseUrl: "https://api.example.test/v1" });
  const auth: GenerateAuth = options.auth ?? {
    ok: true,
    apiKey: "test-key",
    headers: { "x-test": "1" } as ProviderHeaders,
  };

  const ctx: GenerateContext = {
    model: sessionModel,
    getCompactionSettings: () => options.settings ?? { reserveTokens: 10_000 },
    getCompactionModel: () => summarizer,
    modelRegistry: {
      find: (provider, modelId) => {
        if (options.findModel) return options.findModel(provider, modelId);
        return provider === summarizer.provider && modelId === summarizer.id ? summarizer : undefined;
      },
      getApiKeyAndHeaders: async () => auth,
      complete: async (model, context, requestOptions) => {
        calls.push({ model, context, options: requestOptions });
        return options.complete
          ? options.complete(model, context, requestOptions)
          : assistant(NOTES_OUTPUT, { outputTokens: 120 });
      },
    },
    sessionManager: { getBranch: () => options.branch ?? [] },
  };
  return { ctx, calls };
}

function promptText(context: Context): string {
  const message = context.messages[0];
  if (!message || message.role !== "user" || typeof message.content === "string") {
    throw new Error("expected one user message with text blocks");
  }
  const texts = message.content.filter(
    (block): block is Extract<typeof block, { type: "text" }> => block.type === "text",
  );
  const last = texts[texts.length - 1];
  if (!last) throw new Error("expected a prompt text block");
  return last.text;
}

function conversationText(context: Context): string {
  const message = context.messages[0];
  if (!message || message.role !== "user" || typeof message.content === "string") {
    throw new Error("expected one user message with text blocks");
  }
  const first = message.content[0];
  if (!first || first.type !== "text") throw new Error("expected a conversation block");
  return first.text;
}

describe("notes generation", () => {
  test("appends one header and keeps the earlier summary byte-for-byte", async () => {
    const previous = source().previousSummary!;
    const summarizer = makeModel();
    const { ctx, calls } = makeContext({ summarizer });
    const outcome = await generateCompaction({
      ctx,
      kind: "notes",
      source: source(),
      jobId: "job-notes-1",
      inheritedTaskIntent: "ORIGINAL_REQUEST: build the early-compaction mod",
      now: () => new Date("2026-10-19T12:34:56.789Z"),
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.model).toBe(summarizer);
    expect(call.options.apiKey).toBe("test-key");
    expect(call.options.maxTokens).toBe(8_000);
    expect(call.options.signal).toBeInstanceOf(AbortSignal);

    // The notes request carries the notes prompt and marks the earlier
    // summary as reference only.
    expect(call.context.systemPrompt).toBe(NOTES_PROMPT_SYSTEM);
    expect(promptText(call.context)).toBe(buildNotesPrompt(previous).user);
    expect(promptText(call.context)).toContain("<reference-summary>");
    expect(promptText(call.context)).toContain(previous);
    expect(promptText(call.context)).toContain("provided for reference only");
    expect(promptText(call.context)).not.toContain("{{previousSummary}}");
    expect(conversationText(call.context)).toContain("Keep C:\\repo\\file.ts exactly.");

    const { summary } = outcome.result;
    expect(summary.startsWith(previous)).toBe(true);
    expect(summary.slice(previous.length)).toStartWith("\n\n---\n");

    const headerLines = summary.split("\n").filter((line) => NOTES_HEADER_RE.test(line));
    expect(headerLines).toHaveLength(1);
    expect(headerLines[0]).toBe(
      notesHeader("entry-1", "entry-2", new Date("2026-10-19T12:34:56.789Z")),
    );
    expect(summary).toEndWith(NOTES_OUTPUT);
    for (const title of NOTES_SECTION_TITLES) {
      expect(summary).toContain(title);
    }

    expect(outcome.result.firstKeptEntryId).toBe("keep-1");
    expect(outcome.result.tokensBefore).toBe(10_000);
    expect(outcome.result.estimatedTokensAfter).toBeLessThan(10_000);
    expect(outcome.result.usage?.output).toBe(120);
    expect(outcome.result.details?.schema).toBe("senpi.compaction.summary.v1");
    expect(outcome.result.details?.taskIntent).toBe(
      "ORIGINAL_REQUEST: build the early-compaction mod",
    );
    expect(outcome.result.details?.origin).toBe("piomo.early-compaction");
    expect(outcome.result.details?.earlyCompaction).toEqual({
      v: 1,
      kind: "notes",
      notesBlocks: 1,
      jobId: "job-notes-1",
    });
  });

  test("notes prompt uses the builtin R1 and R4 rules", () => {
    expect(NOTES_PROMPT_SYSTEM).toContain(
      "R1. Quote user requests and constraints VERBATIM. Do not paraphrase.",
    );
    expect(NOTES_PROMPT_SYSTEM).toContain(
      "R4. Preserve every session_id, file path, and identifier byte-for-byte.",
    );
  });

  test("countNotesBlocks counts existing headers", () => {
    const previous = [
      "old summary",
      "---",
      notesHeader("a", "b", new Date("2026-01-01T00:00:00.000Z")),
      "block",
      notesHeader("c", "d", new Date("2026-01-02T00:00:00.000Z")),
    ].join("\n");
    expect(countNotesBlocks(previous)).toBe(2);
    expect(countNotesBlocks(undefined)).toBe(0);
  });
});

describe("rewrite generation", () => {
  for (const kind of ["rewrite", "rewrite-consolidate"] as const) {
    test(`${kind} uses the ported UPDATE variant byte-for-byte`, async () => {
      const previous = "## 1. User Requests (Verbatim)\n- ship it";
      const inherited = "ORIGINAL_REQUEST: ship the mod";
      const summarizer = makeModel();
      const { ctx, calls } = makeContext({
        summarizer,
        complete: async () =>
          assistant("<summary>\n## 1. User Requests (Verbatim)\n- ship it\n</summary>"),
      });

      const outcome = await generateCompaction({
        ctx,
        kind,
        source: source({ previousSummary: previous }),
        jobId: `job-${kind}`,
        inheritedTaskIntent: inherited,
      });

      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;

      const expected = buildPrompt({
        variant: "update",
        promptFamily: resolvePromptFamily(summarizer),
        previousSummary: previous,
        taskIntent: inherited,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.context.systemPrompt).toBe(expected.system);
      expect(promptText(calls[0]!.context)).toBe(expected.user);
      expect(outcome.result.details?.taskIntent).toBe(inherited);
      expect(outcome.result.details?.earlyCompaction.notesBlocks).toBe(0);
      expect(outcome.result.summary).toBe("## 1. User Requests (Verbatim)\n- ship it");
    });
  }

  test("rewrite-first uses the USER variant and extracts task intent", async () => {
    const summarizer = makeModel();
    const text =
      "<task-intent>\nORIGINAL_REQUEST: build the mod\n</task-intent>\n" +
      "<summary>\n## 1. User Requests (Verbatim)\n- build the mod\n</summary>";
    const { ctx, calls } = makeContext({
      summarizer,
      complete: async () => assistant(text),
    });

    const outcome = await generateCompaction({
      ctx,
      kind: "rewrite-first",
      source: source({ previousSummary: undefined }),
      jobId: "job-first",
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    const expected = buildPrompt({
      variant: "default",
      promptFamily: resolvePromptFamily(summarizer),
    });
    expect(promptText(calls[0]!.context)).toBe(expected.user);
    expect(outcome.result.summary).toBe("## 1. User Requests (Verbatim)\n- build the mod");
    expect(outcome.result.details?.taskIntent).toBe(
      "ORIGINAL_REQUEST: build the mod",
    );
    expect(outcome.result.details?.earlyCompaction.kind).toBe("rewrite-first");
  });
});

describe("output cap", () => {
  test("rewrites allow 2.5x the estimated summary; notes keep 80% of the reserve", () => {
    expect(REWRITE_SUMMARY_CAP_RATIO).toBe(2.5);
    expect(outputCap("notes", 16_384, 20_000, 0)).toBe(13_107);
    // A small summary keeps the reserve cap.
    expect(outputCap("rewrite-consolidate", 16_384, 4_000, 0)).toBe(13_107);
    expect(outputCap("rewrite-consolidate", 16_384, 8_726, 0)).toBe(21_815);
    expect(outputCap("rewrite", 16_384, 10_000, 0)).toBe(25_000);
  });

  test("the highest measured output ratio (2.38x) stays below the truncation line", () => {
    const estimated = 10_000;
    const cap = outputCap("rewrite-consolidate", 16_384, estimated, 0);
    expect(Math.ceil(2.38 * estimated)).toBeLessThan(0.98 * cap);
  });

  test("the model's own maxTokens bounds every cap", () => {
    expect(outputCap("rewrite-consolidate", 16_384, 10_000, 20_000)).toBe(20_000);
    expect(outputCap("notes", 16_384, 0, 8_000)).toBe(8_000);
  });
});

describe("skip and failure paths", () => {
  test("model-unresolved makes no model call", async () => {
    const { ctx, calls } = makeContext({
      settings: { model: "unknown/model", reserveTokens: 10_000 },
      findModel: () => undefined,
    });
    const outcome = await generateCompaction({
      ctx,
      kind: "notes",
      source: source(),
      jobId: "job-unresolved",
    });
    expect(outcome).toEqual({ status: "skipped", reason: "model-unresolved" });
    expect(calls).toHaveLength(0);
  });

  test("local-session-model makes no model call", async () => {
    const local = makeModel({ id: "strata", provider: "local", baseUrl: "http://127.0.0.1:8080" });
    const { ctx, calls } = makeContext({
      sessionModel: local,
      summarizer: local,
      settings: { reserveTokens: 10_000 },
    });
    const outcome = await generateCompaction({
      ctx,
      kind: "notes",
      source: source(),
      jobId: "job-local",
    });
    expect(outcome).toEqual({ status: "skipped", reason: "local-session-model" });
    expect(calls).toHaveLength(0);
  });

  test("auth failure makes no model call", async () => {
    const { ctx, calls } = makeContext({ auth: { ok: false, error: "no key" } });
    const outcome = await generateCompaction({
      ctx,
      kind: "notes",
      source: source(),
      jobId: "job-auth",
    });
    expect(outcome).toEqual({ status: "failed", reason: "auth" });
    expect(calls).toHaveLength(0);
  });

  test("source-too-large makes no model call", async () => {
    const tiny = makeModel({ contextWindow: 1_000, maxTokens: 8_192 });
    const { ctx, calls } = makeContext({
      summarizer: tiny,
      settings: { reserveTokens: 10_000 },
    });
    const outcome = await generateCompaction({
      ctx,
      kind: "notes",
      source: source(),
      jobId: "job-large",
    });
    expect(outcome).toEqual({ status: "skipped", reason: "source-too-large" });
    expect(calls).toHaveLength(0);
  });

  test("an output at 98% of its cap is rejected as truncated", async () => {
    // reserveTokens 1,000 -> notes cap 800; 98% is exactly 784 tokens.
    const { ctx } = makeContext({
      settings: { reserveTokens: 1_000 },
      complete: async () => assistant(NOTES_OUTPUT, { outputTokens: 784 }),
    });
    const outcome = await generateCompaction({
      ctx,
      kind: "notes",
      source: source(),
      jobId: "job-truncated",
    });
    expect(outcome).toEqual({ status: "failed", reason: "truncated" });
    expect("result" in outcome).toBe(false);
  });

  test("aborting the caller signal mid-call returns aborted with no result", async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const { ctx } = makeContext({
      complete: async (_model, _context, options) => {
        signalStarted();
        return await new Promise<AssistantMessage>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();
    const pending = generateCompaction({
      ctx,
      kind: "notes",
      source: source(),
      jobId: "job-abort",
      signal: controller.signal,
    });

    await started;
    controller.abort();

    const outcome = await pending;
    expect(outcome).toEqual({ status: "aborted" });
    expect("result" in outcome).toBe(false);
  });
});
