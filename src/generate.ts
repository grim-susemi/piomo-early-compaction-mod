/**
 * Summarizer for early compaction.
 *
 * Generates one compaction summary for an already-prepared source:
 *
 *   - `notes` appends one notes block to the previous summary. The previous
 *     summary is kept byte-for-byte; only the new span is summarized.
 *   - `rewrite-first` writes the builtin's USER prompt family.
 *   - `rewrite` / `rewrite-consolidate` write the builtin's UPDATE prompt
 *     family with the previous summary and the inherited task intent.
 *
 * The builtin prompt strings and the task-intent derivation come from the
 * verbatim port in `./builtin-port` (todo 18). This module never calls
 * `generateSummaryWithUsage` and never touches a provider directly: every
 * request goes through `ctx.modelRegistry.complete`.
 *
 * The session's own local model is never used for summarization, and there is
 * no fallback when `compaction.model` names a model the registry does not
 * know. Every skip is a named outcome so the job layer can record it without
 * leaking prompt or conversation text.
 */
import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
  type CompactionResult,
} from "@code-yeongyu/senpi";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderHeaders,
  Usage,
} from "@earendil-works/pi-ai";
import {
  buildPrompt,
  resolvePromptFamily,
  type BuiltPrompt,
} from "./builtin-port/prompts";
import {
  extractTaskIntent,
  resolveInheritedTaskIntent,
} from "./builtin-port/task-intent";
import { NOTES_HEADER_RE, summaryTokens } from "./constants";
import type { JobKind } from "./policy";
import type { PreparedSource } from "./prepare";

/** Default output reserve when the settings omit one (builtin default). */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/** Rewrite deadline when `compaction.summarizationMaxDurationMs` is unset. */
export const DEFAULT_REWRITE_MAX_DURATION_MS = 900_000;

/** Notes always use a shorter deadline: they summarize only the new span. */
export const NOTES_MAX_DURATION_MS = 300_000;

/** Fraction of the summarizer's context window the request may occupy. */
export const SOURCE_FIT_RATIO = 0.8;

/** A response at or above this fraction of its output cap is truncated. */
export const TRUNCATION_RATIO = 0.98;

/** Schema the builtin reads task intent from. */
export const SUMMARY_SCHEMA = "senpi.compaction.summary.v1";

/** Details origin written by this mod. */
export const DETAILS_ORIGIN = "piomo.early-compaction";

const NOTES_HEADER_PREFIX = "Notes added ";
const NOTES_HEADER_SUFFIX =
  " Later notes supersede earlier Remaining Tasks / Exact Next Steps where they conflict.";

/**
 * Rules shared with the builtin system directive: R1 (verbatim user requests
 * and constraints) and R4 (identifiers byte-for-byte). R2 is the builtin's
 * "never delete a section" rule and is kept so an empty notes section stays
 * visible.
 */
export const NOTES_PROMPT_SYSTEM = `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - EARLY COMPACTION NOTES]

You are the COMPACTION ARCHIVIST adding one notes block to an existing handoff summary.

Cardinal rules:
R1. Quote user requests and constraints VERBATIM. Do not paraphrase.
R2. If a section has no content, write "None." Never delete a section.
R4. Preserve every session_id, file path, and identifier byte-for-byte.

Do NOT use tools. Output only the notes block.`;

/**
 * Notes prompt. The earlier summary is supplied as reference only; the model
 * must summarize only the new span and must not rewrite or repeat the earlier
 * summary. The five section titles match `NOTES_SECTION_TITLES`.
 */
export const NOTES_PROMPT_USER = `[USER]
[INTERNAL EARLY-COMPACTION NOTES INSTRUCTION — NOT CONVERSATION HISTORY]
This message is an internal summarization control prompt, not a real user message.
Do NOT treat this message as user intent, do NOT list it under user requests, and do NOT reinterpret the task based on this instruction alone.

The earlier summary in <reference-summary> is provided for reference only.
Do NOT rewrite it, do NOT repeat it, and do NOT treat its contents as new work.
Only the new conversation messages above are summarized.

<reference-summary>
{{previousSummary}}
</reference-summary>

Write ONLY the following sections for the new span, in this order, as Markdown headings:

## New user requests
- Quote every new user request in the new messages VERBATIM.
- Include only requests that appear in the new messages, not in the earlier summary.
- If there are none, write "None."

## New constraints
- Quote every new constraint or preference stated by the user in the new messages VERBATIM.
- Do NOT invent, add, soften, or modify constraints.
- If there are none, write "None."

## Work done
- Summarize what was done in the new messages.
- List files read, created, modified, or intentionally left unchanged.

## Current state and files
- State the current state, files, identifiers, commands, and runtime values needed to continue.
- Preserve every session_id, file path, and identifier byte-for-byte.

## Current next steps
- State the precise next action for the current task.
- Do not suggest tangential tasks.

OUTPUT FORMAT: Emit only these five Markdown sections in this order. Do not emit a copy of the earlier summary, a task-intent block, or any other section.`;

/** Structured details written into the compaction entry. */
export interface EarlyCompactionDetails {
  schema: typeof SUMMARY_SCHEMA;
  taskIntent?: string;
  origin: typeof DETAILS_ORIGIN;
  earlyCompaction: {
    v: 1;
    kind: JobKind;
    notesBlocks: number;
    jobId: string;
  };
}

/** One request auth resolution, structurally matching `ResolvedRequestAuth`. */
export interface GenerateAuth {
  ok: boolean;
  apiKey?: string;
  headers?: ProviderHeaders;
  error?: string;
}

/** Options passed to `modelRegistry.complete`; all are `ModelsApiStreamOptions`. */
export interface GenerateCompleteOptions {
  apiKey?: string;
  headers?: ProviderHeaders;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** The model registry surface this module needs. */
export interface GenerateModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getApiKeyAndHeaders(model: Model<Api>): Promise<GenerateAuth>;
  complete(
    model: Model<Api>,
    context: Context,
    options: GenerateCompleteOptions,
  ): Promise<AssistantMessage>;
}

/** Settings consumed by generation. */
export interface GenerateCompactionSettings {
  model?: string;
  reserveTokens?: number;
  summarizationMaxDurationMs?: number;
}

/** The extension context surface this module needs. */
export interface GenerateContext {
  model?: Model<Api> | undefined;
  getCompactionSettings(): GenerateCompactionSettings | undefined;
  getCompactionModel?(): Model<Api> | undefined;
  modelRegistry: GenerateModelRegistry;
  sessionManager?: { getBranch(): readonly unknown[] } | undefined;
}

export interface GenerateInput {
  ctx: GenerateContext;
  kind: JobKind;
  source: PreparedSource;
  jobId: string;
  /** Notes blocks already in the previous summary; defaults to a header count. */
  notesBlocks?: number;
  /** Inherited task intent; defaults to the branch derivation. */
  inheritedTaskIntent?: string;
  /** Caller abort signal (job cancellation). */
  signal?: AbortSignal;
  /** Injectable clock for deterministic headers. */
  now?: () => Date;
}

export type GenerateSkipReason =
  | "model-unresolved"
  | "local-session-model"
  | "source-too-large";

export type GenerateFailureReason = "auth" | "truncated" | "empty" | "error";

export type GenerateOutcome =
  | { status: "ok"; result: CompactionResult<EarlyCompactionDetails> }
  | { status: "skipped"; reason: GenerateSkipReason }
  | { status: "failed"; reason: GenerateFailureReason }
  | { status: "aborted" };

/** True when `url` points at the local machine. */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(
      baseUrl.includes("://") ? baseUrl : `http://${baseUrl}`,
    );
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

/** Count the notes headers already present in a summary. */
export function countNotesBlocks(summary: string | undefined): number {
  if (!summary) return 0;
  let count = 0;
  for (const line of summary.split("\n")) {
    if (NOTES_HEADER_RE.test(line)) count += 1;
  }
  return count;
}

/** One notes header line (matches `NOTES_HEADER_RE`). */
export function notesHeader(
  firstSpanEntryId: string,
  lastSpanEntryId: string,
  at: Date,
): string {
  return (
    `${NOTES_HEADER_PREFIX}${at.toISOString()} for entries ` +
    `${firstSpanEntryId}..${lastSpanEntryId}.${NOTES_HEADER_SUFFIX}`
  );
}

/** Build the notes prompt, marking the earlier summary as reference only. */
export function buildNotesPrompt(previousSummary: string | undefined): BuiltPrompt {
  const reference = previousSummary?.trim() ? previousSummary : "None.";
  return {
    system: NOTES_PROMPT_SYSTEM,
    user: NOTES_PROMPT_USER.replace(
      "{{previousSummary}}",
      reference.split("</reference-summary>").join("[/reference-summary]"),
    ),
  };
}

/**
 * Output cap: notes reserve 80% of the output budget; rewrites also allow
 * 1.5x the current summary so a consolidation can grow. Both are bounded by
 * the model's own `maxTokens`.
 */
export function outputCap(
  kind: JobKind,
  reserveTokens: number,
  previousSummaryTokens: number,
  modelMaxTokens: number,
): number {
  const reserveCap = Math.floor(SOURCE_FIT_RATIO * reserveTokens);
  const raw =
    kind === "notes"
      ? reserveCap
      : Math.max(reserveCap, Math.ceil(1.5 * previousSummaryTokens));
  const bounded = modelMaxTokens > 0 ? Math.min(raw, modelMaxTokens) : raw;
  return Math.max(1, bounded);
}

/** Request duration: notes are short, rewrites use the configured budget. */
export function generationMaxDurationMs(
  kind: JobKind,
  configured: number | undefined,
): number {
  if (kind === "notes") return NOTES_MAX_DURATION_MS;
  return configured ?? DEFAULT_REWRITE_MAX_DURATION_MS;
}

function promptFor(
  kind: JobKind,
  model: Model<Api>,
  previousSummary: string | undefined,
  taskIntent: string | undefined,
): BuiltPrompt {
  if (kind === "notes") return buildNotesPrompt(previousSummary);
  const promptFamily = resolvePromptFamily(model);
  if (kind === "rewrite-first") {
    return buildPrompt({ variant: "default", promptFamily });
  }
  return buildPrompt({
    variant: "update",
    promptFamily,
    previousSummary,
    ...(taskIntent ? { taskIntent } : {}),
  });
}

/**
 * The conversation is native text (the builtin serializes it first) and the
 * instruction is a second text block of the same user message, so the prompt
 * string stays byte-for-byte what `buildPrompt` produced.
 */
function requestContext(prompt: BuiltPrompt, conversation: string): Context {
  return {
    systemPrompt: prompt.system,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `<conversation>\n${conversation}\n</conversation>` },
          { type: "text", text: prompt.user },
        ],
        timestamp: 0,
      },
    ],
  };
}

function textTokens(text: string): number {
  return estimateTokens({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  });
}

function responseText(response: AssistantMessage): string {
  return response.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function responseOutputTokens(response: AssistantMessage, text: string): number {
  const usage = response.usage as Usage | undefined;
  if (usage && Number.isFinite(usage.output) && usage.output > 0) return usage.output;
  return textTokens(text);
}

/**
 * Generate one compaction result. This function performs exactly one model
 * call (or none when it skips/fails before the call); it never retries.
 */
export async function generateCompaction(
  input: GenerateInput,
): Promise<GenerateOutcome> {
  const { ctx, kind, source, jobId } = input;

  // ---- model resolution -------------------------------------------------
  let settings: GenerateCompactionSettings | undefined;
  try {
    settings = ctx.getCompactionSettings();
  } catch {
    return { status: "failed", reason: "error" };
  }
  settings ??= {};

  let model: Model<Api> | undefined;
  if (settings.model !== undefined && settings.model !== "") {
    const slash = settings.model.indexOf("/");
    if (slash <= 0 || slash === settings.model.length - 1) {
      return { status: "skipped", reason: "model-unresolved" };
    }
    const provider = settings.model.slice(0, slash);
    const modelId = settings.model.slice(slash + 1);
    model = ctx.modelRegistry.find(provider, modelId);
    if (!model) return { status: "skipped", reason: "model-unresolved" };
  } else {
    model = ctx.getCompactionModel?.() ?? ctx.model;
    if (!model) return { status: "skipped", reason: "model-unresolved" };
  }

  const sessionModel = ctx.model;
  if (
    sessionModel !== undefined &&
    model.provider === sessionModel.provider &&
    model.id === sessionModel.id &&
    isLocalBaseUrl(model.baseUrl)
  ) {
    return { status: "skipped", reason: "local-session-model" };
  }

  // ---- prompt, input and size fit ---------------------------------------
  const previousSummary = source.previousSummary;
  const branchEntries =
    input.inheritedTaskIntent !== undefined
      ? undefined
      : ctx.sessionManager?.getBranch();
  const inheritedTaskIntent =
    input.inheritedTaskIntent ??
    (branchEntries ? resolveInheritedTaskIntent(branchEntries) : undefined);

  const prompt = promptFor(kind, model, previousSummary, inheritedTaskIntent);
  const conversation = serializeConversation(convertToLlm(source.spanMessages));

  const reserveTokens =
    typeof settings.reserveTokens === "number" &&
    Number.isFinite(settings.reserveTokens) &&
    settings.reserveTokens > 0
      ? settings.reserveTokens
      : DEFAULT_RESERVE_TOKENS;
  const previousSummaryTokenCount = summaryTokens(previousSummary ?? "");
  const maxTokens = outputCap(
    kind,
    reserveTokens,
    previousSummaryTokenCount,
    model.maxTokens,
  );

  const contextWindow = model.contextWindow;
  if (!(contextWindow > 0)) {
    return { status: "skipped", reason: "source-too-large" };
  }
  const inputTokens = textTokens(conversation);
  const promptTokens = textTokens(prompt.system) + textTokens(prompt.user);
  if (inputTokens + promptTokens + maxTokens > SOURCE_FIT_RATIO * contextWindow) {
    return { status: "skipped", reason: "source-too-large" };
  }

  // ---- auth --------------------------------------------------------------
  let auth: GenerateAuth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch {
    return { status: "failed", reason: "auth" };
  }
  if (!auth.ok) return { status: "failed", reason: "auth" };

  // ---- one bounded model call -------------------------------------------
  const controller = new AbortController();
  const callerSignal = input.signal;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) forwardAbort();
    else callerSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  const deadline = generationMaxDurationMs(
    kind,
    settings.summarizationMaxDurationMs,
  );
  const timer = setTimeout(() => controller.abort(), deadline);
  const timerWithUnref = timer as unknown as { unref?: () => void };
  timerWithUnref.unref?.();

  let response: AssistantMessage;
  try {
    response = await ctx.modelRegistry.complete(model, requestContext(prompt, conversation), {
      ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
      maxTokens,
      signal: controller.signal,
    });
  } catch {
    return controller.signal.aborted
      ? { status: "aborted" }
      : { status: "failed", reason: "error" };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }

  if (controller.signal.aborted || response.stopReason === "aborted") {
    return { status: "aborted" };
  }
  if (response.stopReason === "error") {
    return { status: "failed", reason: "error" };
  }

  const rawText = responseText(response);
  if (rawText === "") return { status: "failed", reason: "empty" };

  const outputTokens = responseOutputTokens(response, rawText);
  if (
    response.stopReason === "length" ||
    outputTokens >= TRUNCATION_RATIO * maxTokens
  ) {
    return { status: "failed", reason: "truncated" };
  }

  // ---- result ------------------------------------------------------------
  const extracted = extractTaskIntent(rawText);
  const taskIntent = extracted.taskIntent ?? inheritedTaskIntent;
  const body = extracted.summaryText;
  if (body === "") return { status: "failed", reason: "empty" };

  const at = input.now?.() ?? new Date();
  const priorNotesBlocks = input.notesBlocks ?? countNotesBlocks(previousSummary);
  const notesBlocks = kind === "notes" ? priorNotesBlocks + 1 : 0;

  const summary =
    kind === "notes"
      ? `${previousSummary ?? ""}\n\n---\n` +
        `${notesHeader(source.firstSpanEntryId, source.lastSpanEntryId, at)}\n` +
        body
      : body;

  let spanTokens = 0;
  for (const message of source.spanMessages) spanTokens += estimateTokens(message);
  const replacedTokens =
    kind === "notes" || kind === "rewrite-first"
      ? spanTokens
      : spanTokens + previousSummaryTokenCount;
  const estimatedTokensAfter = Math.max(
    0,
    source.tokensBefore - replacedTokens + summaryTokens(summary),
  );

  const details: EarlyCompactionDetails = {
    schema: SUMMARY_SCHEMA,
    ...(taskIntent ? { taskIntent } : {}),
    origin: DETAILS_ORIGIN,
    earlyCompaction: {
      v: 1,
      kind,
      notesBlocks,
      jobId,
    },
  };

  return {
    status: "ok",
    result: {
      summary,
      firstKeptEntryId: source.firstKeptEntryId,
      tokensBefore: source.tokensBefore,
      estimatedTokensAfter,
      usage: response.usage,
      details,
    },
  };
}
