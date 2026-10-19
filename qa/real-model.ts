/**
 * One isolated real-model run for the early-compaction overlay (todo 16).
 *
 * The run makes exactly two model calls with `ollama/deepseek-v4.1-flash`:
 *
 *   1. `notes` over the synthetic second half, with the first-half summary
 *      prepared offline in the fixture;
 *   2. `rewrite-consolidate` over the notes result.
 *
 * Registry isolation: AG/models.json, AG/auth.json and the model store that
 * sits beside models.json are copied into an `mkdtemp` agent dir; the registry
 * and every store are constructed on that temp dir, never on AG. The temp dir
 * is removed in `finally`, and only hashes are reported.
 *
 * Safety rules:
 *   - `--model` must be exactly `ollama/deepseek-v4.1-flash`; anything else
 *     exits non-zero before a registry read or a call.
 *   - `--dry-run` builds the fixture, prompts and checks, reports token
 *     estimates, and makes zero calls.
 *   - A real run never retries: a failed call is recorded and the script
 *     stops. Each call has a 180 s deadline.
 *   - No message, prompt or summary text is written to the report: ids,
 *     hashes, counts, durations and usage numbers only.
 *
 * Usage:
 *   bun run qa/real-model.ts [--dry-run] [--model <provider/id>]
 *                            [--fixture <path>] [--report <path>]
 *                            [--evidence-out <path>]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
} from "@code-yeongyu/senpi";

import {
  buildNotesPrompt,
  generateCompaction,
  notesHeader,
  outputCap,
  type GenerateContext,
  type GenerateModelRegistry,
  type GenerateOutcome,
} from "../src/generate";
import { buildPrompt, resolvePromptFamily } from "../src/builtin-port/prompts";
import { NOTES_SECTION_TITLES, summaryTokens } from "../src/constants";
import type { PreparedSource } from "../src/prepare";
import type { JobKind } from "../src/policy";
import {
  REAL_MODEL_ID,
  checkModelId,
  checkSectionTitles,
  countRetention,
  extractNotesBlock,
  type PlantedItem,
  type RetentionResult,
  type SectionTitleResult,
} from "./real-model-checks";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const FIXTURE_PATH = path.join(HERE, "fixtures", "real-model-conversation.json");
const OUT_DIR = path.join(REPO, "qa", "out");
const REPORT_PATH = path.join(OUT_DIR, "real-model-report.json");
const DRY_RUN_REPORT_PATH = path.join(OUT_DIR, "real-model-dry-run.json");
const GUARD_FAILED_REPORT_PATH = path.join(OUT_DIR, "real-model-guard-failed.json");
const AG = "C:/Users/USER/.omo-stable-500/home/.omo/agent";
const SENPI_ROOT =
  "C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi";
const MODEL_PROVIDER = "ollama";
const MODEL_NAME = "deepseek-v4.1-flash";
const CALL_TIMEOUT_MS = 180_000;
const RESERVE_TOKENS = 16_384;
const AG_HASH_FILES = ["models.json", "auth.json", "settings.json"];
const REGISTRY_FILES = [
  "models.json",
  "models-store.json",
  "auth.json",
  "credential-pool-state.json",
];
const TOTAL_TOKEN_RANGE = { min: 25_000, max: 35_000 };

/** One fixture message: plain text in a user or assistant turn. */
interface FixtureMessage {
  role: "user" | "assistant";
  text: string;
}

/** The committed fixture document. */
interface Fixture {
  schema: number;
  name: string;
  description: string;
  taskIntent: string;
  firstHalfSummary: string;
  firstHalf: FixtureMessage[];
  secondHalf: FixtureMessage[];
  planted: { firstHalf: PlantedItem[]; secondHalf: PlantedItem[] };
  expected: Record<string, unknown>;
}

interface Args {
  dryRun: boolean;
  model: string;
  fixturePath: string;
  reportPath?: string;
  evidenceOut?: string;
}

interface CallRecord {
  seq: number;
  kind: JobKind;
  status: "ok" | "failed" | "skipped" | "aborted";
  reason?: string;
  durationMs: number;
  timedOut: boolean;
  providerError?: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  } | null;
  outputChars?: number;
  outputSha256?: string;
}

interface Json {
  [key: string]: unknown;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    model: REAL_MODEL_ID,
    fixturePath: FIXTURE_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--model": {
        index += 1;
        args.model = argv[index] ?? "";
        break;
      }
      case "--fixture": {
        index += 1;
        args.fixturePath = argv[index] ?? "";
        break;
      }
      case "--report": {
        index += 1;
        args.reportPath = argv[index] ?? "";
        break;
      }
      case "--evidence-out": {
        index += 1;
        args.evidenceOut = argv[index] ?? "";
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function agentHashes(): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const name of AG_HASH_FILES) result[name] = sha256File(path.join(AG, name));
  return result;
}

function loadFixture(fixturePath: string): { fixture: Fixture; rawSha256: string } {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as Fixture;
  if (
    !parsed ||
    parsed.schema !== 1 ||
    !Array.isArray(parsed.firstHalf) ||
    !Array.isArray(parsed.secondHalf) ||
    !parsed.planted ||
    !Array.isArray(parsed.planted.firstHalf) ||
    !Array.isArray(parsed.planted.secondHalf) ||
    typeof parsed.firstHalfSummary !== "string" ||
    typeof parsed.taskIntent !== "string"
  ) {
    throw new Error("fixture schema mismatch");
  }
  return { fixture: parsed, rawSha256: sha256(raw) };
}

function toMessages(
  messages: readonly FixtureMessage[],
): PreparedSource["spanMessages"] {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.text }],
    timestamp: 0,
  })) as unknown as PreparedSource["spanMessages"];
}

function textTokens(text: string): number {
  return estimateTokens({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  });
}

function messageTokens(message: PreparedSource["spanMessages"][number]): number {
  return estimateTokens(message);
}

function halfTokens(messages: readonly FixtureMessage[]): number {
  return toMessages(messages).reduce((total, message) => total + messageTokens(message), 0);
}

function userText(messages: readonly FixtureMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.text)
    .join("\n");
}

function fixtureInvariants(fixture: Fixture): {
  ok: boolean;
  failures: string[];
  tokens: { firstHalf: number; secondHalf: number; total: number };
  counts: { messages: number; firstHalfItems: number; secondHalfItems: number };
  items: {
    firstHalf: Array<{ id: string; inHalf: boolean; inSummary: boolean }>;
    secondHalf: Array<{ id: string; inHalf: boolean }>;
  };
} {
  const failures: string[] = [];
  const firstTokens = halfTokens(fixture.firstHalf);
  const secondTokens = halfTokens(fixture.secondHalf);
  const total = firstTokens + secondTokens;
  const firstUser = userText(fixture.firstHalf);
  const secondUser = userText(fixture.secondHalf);

  if (fixture.planted.firstHalf.length !== 5) failures.push("first-half-item-count");
  if (fixture.planted.secondHalf.length !== 5) failures.push("second-half-item-count");
  if (fixture.firstHalf.length !== 10) failures.push("first-half-message-count");
  if (fixture.secondHalf.length !== 10) failures.push("second-half-message-count");
  if (total < TOTAL_TOKEN_RANGE.min || total > TOTAL_TOKEN_RANGE.max) {
    failures.push("total-token-range");
  }

  const firstItems = fixture.planted.firstHalf.map((item) => {
    const inHalf = firstUser.includes(item.text);
    const inSummary = fixture.firstHalfSummary.includes(item.text);
    if (!inHalf) failures.push(`first-half-missing:${item.id}`);
    if (!inSummary) failures.push(`summary-missing:${item.id}`);
    return { id: item.id, inHalf, inSummary };
  });
  const secondItems = fixture.planted.secondHalf.map((item) => {
    const inHalf = secondUser.includes(item.text);
    if (!inHalf) failures.push(`second-half-missing:${item.id}`);
    return { id: item.id, inHalf };
  });

  return {
    ok: failures.length === 0,
    failures,
    tokens: { firstHalf: firstTokens, secondHalf: secondTokens, total },
    counts: {
      messages: fixture.firstHalf.length + fixture.secondHalf.length,
      firstHalfItems: fixture.planted.firstHalf.length,
      secondHalfItems: fixture.planted.secondHalf.length,
    },
    items: { firstHalf: firstItems, secondHalf: secondItems },
  };
}

function checkSelfTests(fixture: Fixture): {
  ok: boolean;
  failures: string[];
  retention: RetentionResult;
  sectionTitles: SectionTitleResult;
  modelGuard: { accepted: boolean; rejectedOther: boolean; rejectedMissing: boolean };
  extraction: boolean;
} {
  const failures: string[] = [];
  const header = notesHeader(
    "self-test-first",
    "self-test-last",
    new Date("2026-01-01T00:00:00.000Z"),
  );
  const sample =
    NOTES_SECTION_TITLES.map((title) => `## ${title}`).join("\n") +
    `\n- ${fixture.planted.secondHalf[0]?.text ?? "none"}`;
  const retention = countRetention(sample, fixture.planted.secondHalf.slice(0, 1));
  const sectionTitles = checkSectionTitles(sample);
  const extraction =
    extractNotesBlock(`prior summary\n${header}\n${sample}`) === sample;
  const accepted = checkModelId(REAL_MODEL_ID).ok;
  const rejectedOther = !checkModelId("ollama/does-not-exist").ok;
  const rejectedMissing = !checkModelId(undefined).ok;

  if (retention.matched !== 1) failures.push("retention-self-test");
  if (!sectionTitles.ok) failures.push("section-title-self-test");
  if (!extraction) failures.push("extraction-self-test");
  if (!accepted) failures.push("model-guard-accept-self-test");
  if (!rejectedOther) failures.push("model-guard-other-self-test");
  if (!rejectedMissing) failures.push("model-guard-missing-self-test");

  return {
    ok: failures.length === 0,
    failures,
    retention,
    sectionTitles,
    modelGuard: { accepted, rejectedOther, rejectedMissing },
    extraction,
  };
}

function copyRegistryStores(tempAgentDir: string): string[] {
  const copied: string[] = [];
  for (const name of REGISTRY_FILES) {
    const source = path.join(AG, name);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(tempAgentDir, name));
    copied.push(name);
  }
  return copied;
}

interface RegistryLike {
  find(provider: string, modelId: string): unknown;
  refresh(): Promise<unknown>;
  getApiKeyAndHeaders(model: unknown): Promise<{
    ok: boolean;
    error?: string;
    apiKey?: string;
    headers?: unknown;
    baseUrl?: string;
  }>;
  complete(
    model: unknown,
    context: unknown,
    options: unknown,
  ): Promise<unknown>;
}

async function createRegistry(tempAgentDir: string): Promise<RegistryLike> {
  const load = (absolute: string) => import(pathToFileURL(absolute).href);
  const [{ AuthStorage }, { ModelRegistry }] = await Promise.all([
    load(path.join(SENPI_ROOT, "dist/core/auth-storage.js")),
    load(path.join(SENPI_ROOT, "dist/core/model-registry.js")),
  ]);
  const authStorage = (AuthStorage as { create(path?: string): unknown }).create(
    path.join(tempAgentDir, "auth.json"),
  );
  const registry = (
    ModelRegistry as {
      create(auth: unknown, modelsJsonPath?: string): RegistryLike;
    }
  ).create(authStorage, path.join(tempAgentDir, "models.json"));
  await registry.refresh();
  return registry;
}

function usageNumbers(usage: unknown): CallRecord["usage"] {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const number = (key: string): number =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? (record[key] as number)
      : 0;
  return {
    input: number("input"),
    output: number("output"),
    cacheRead: number("cacheRead"),
    cacheWrite: number("cacheWrite"),
    totalTokens: number("totalTokens"),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}

interface OneCall {
  record: CallRecord;
  outcome: GenerateOutcome;
}

async function oneCall(
  ctx: GenerateContext,
  kind: JobKind,
  source: PreparedSource,
  jobId: string,
  inheritedTaskIntent: string,
  seq: number,
  takeProviderError: () => string | undefined,
): Promise<OneCall> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`call timeout after ${CALL_TIMEOUT_MS} ms`));
  }, CALL_TIMEOUT_MS);
  const started = Date.now();
  let outcome: GenerateOutcome;
  try {
    outcome = await generateCompaction({
      ctx,
      kind,
      source,
      jobId,
      inheritedTaskIntent,
      signal: controller.signal,
    });
  } catch (error) {
    outcome = { status: "failed", reason: "error" };
    return {
      outcome,
      record: {
        seq,
        kind,
        status: "failed",
        reason: "error",
        durationMs: Date.now() - started,
        timedOut,
        providerError: takeProviderError() ?? errorText(error),
        usage: null,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  const providerError = takeProviderError();
  if (outcome.status !== "ok") {
    const record: CallRecord = {
      seq,
      kind,
      status: outcome.status === "aborted" ? "aborted" : outcome.status,
      ...(outcome.status === "skipped" || outcome.status === "failed"
        ? { reason: outcome.reason }
        : {}),
      durationMs: Date.now() - started,
      timedOut,
      ...(providerError ? { providerError } : {}),
      usage: null,
    };
    return { outcome, record };
  }

  return {
    outcome,
    record: {
      seq,
      kind,
      status: "ok",
      durationMs: Date.now() - started,
      timedOut,
      usage: usageNumbers(outcome.result.usage),
      outputChars: outcome.result.summary.length,
      outputSha256: sha256(outcome.result.summary),
    },
  };
}

function guardCheck(): {
  ok: boolean;
  reasons: string[];
  reported: string[];
  exitCode: number | null;
} {
  const result = spawnSync("node", ["qa/ag-guard.mjs", "check"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  let parsed: { ok?: unknown; reasons?: unknown; reported?: unknown } = {};
  try {
    parsed = JSON.parse((result.stdout ?? "").trim()) as typeof parsed;
  } catch {
    parsed = {};
  }
  return {
    ok: result.status === 0 && parsed.ok === true,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
    reported: Array.isArray(parsed.reported) ? parsed.reported.map(String) : [],
    exitCode: result.status,
  };
}

function writeJson(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// Module-level cleanup state: `finish` runs before `process.exit`, which skips
// a surrounding finally, so every exit path cleans the temp dir here.
let activeTempAgentDir: string | undefined;
let activeRegistryFiles: string[] = [];
let agentHashesBefore: Record<string, string | null> = {};

function cleanupNow(): Json {
  let tempAgentDirRemoved = false;
  if (activeTempAgentDir) {
    fs.rmSync(activeTempAgentDir, { recursive: true, force: true });
    tempAgentDirRemoved = !fs.existsSync(activeTempAgentDir);
  }
  const after = agentHashes();
  return {
    registryFilesCopied: activeRegistryFiles,
    tempAgentDirRemoved,
    liveAgentDir: {
      before: agentHashesBefore,
      after,
      unchanged: JSON.stringify(agentHashesBefore) === JSON.stringify(after),
    },
  };
}

function finish(report: Json, args: Args, exitCode: number, guardFailure = false): never {
  const target = guardFailure
    ? GUARD_FAILED_REPORT_PATH
    : (args.reportPath ?? (args.dryRun ? DRY_RUN_REPORT_PATH : REPORT_PATH));
  const finalReport: Json = { ...report, cleanup: cleanupNow() };
  writeJson(target, finalReport);
  if (!args.dryRun && !guardFailure && args.evidenceOut) {
    writeJson(args.evidenceOut, finalReport);
  }
  console.log(JSON.stringify(finalReport));
  process.exit(exitCode);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ schema: 1, task: 16, calls: 0, error: errorText(error) }));
    process.exit(2);
  }

  const guard = checkModelId(args.model);
  agentHashesBefore = agentHashes();
  if (!guard.ok) {
    finish(
      {
        schema: 1,
        task: 16,
        mode: "guard-failed",
        calls: 0,
        model: args.model,
        error: { stage: "model-id", reason: guard.reason ?? "rejected" },
      },
      args,
      1,
      true,
    );
  }

  let loaded: { fixture: Fixture; rawSha256: string };
  try {
    loaded = loadFixture(args.fixturePath);
  } catch (error) {
    finish(
      {
        schema: 1,
        task: 16,
        mode: args.dryRun ? "dry-run" : "real",
        calls: 0,
        model: args.model,
        error: { stage: "fixture", message: errorText(error) },
      },
      args,
      1,
    );
  }
  const { fixture, rawSha256 } = loaded;

  const invariants = fixtureInvariants(fixture);
  const selfTests = checkSelfTests(fixture);
  activeTempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "piomo-real-model-agent-"));
  const tempAgentDir = activeTempAgentDir;
  let report: Json;

  try {
    const missingRequired = ["models.json", "auth.json"].filter(
      (name) => !fs.existsSync(path.join(AG, name)),
    );
    if (missingRequired.length > 0) {
      report = {
        schema: 1,
        task: 16,
        mode: args.dryRun ? "dry-run" : "real",
        generatedAt: new Date().toISOString(),
        model: args.model,
        calls: 0,
        fixture: {
          path: "qa/fixtures/real-model-conversation.json",
          sha256: rawSha256,
          invariants,
        },
        error: { stage: "agent-dir", message: `missing ${missingRequired.join(", ")}` },
      };
      return finish(report, args, 1);
    }

    activeRegistryFiles = copyRegistryStores(tempAgentDir);
    const registry = await createRegistry(tempAgentDir);
    const model = registry.find(MODEL_PROVIDER, MODEL_NAME) as
      | { provider?: string; id?: string; maxTokens?: number; contextWindow?: number }
      | undefined;

    if (!model) {
      report = {
        schema: 1,
        task: 16,
        mode: args.dryRun ? "dry-run" : "real",
        generatedAt: new Date().toISOString(),
        model: args.model,
        calls: 0,
        fixture: {
          path: "qa/fixtures/real-model-conversation.json",
          sha256: rawSha256,
          invariants,
        },
        error: { stage: "model-resolution", message: "registry.find returned undefined" },
      };
      return finish(report, args, 1);
    }

    const summaryModel = model;
    const promptFamily = resolvePromptFamily(summaryModel as never);
    const spanMessages = toMessages(fixture.secondHalf);
    const conversation = serializeConversation(convertToLlm(spanMessages));
    const previousSummaryTokens = summaryTokens(fixture.firstHalfSummary);
    const notesPrompt = buildNotesPrompt(fixture.firstHalfSummary);
    const consolidationPrompt = buildPrompt({
      variant: "update",
      promptFamily,
      previousSummary: fixture.firstHalfSummary,
      taskIntent: fixture.taskIntent,
    });
    const notesConversationTokens = textTokens(conversation);
    const notesSystemTokens = textTokens(notesPrompt.system);
    const notesUserTokens = textTokens(notesPrompt.user);
    const consolidationSystemTokens = textTokens(consolidationPrompt.system);
    const consolidationUserTokens = textTokens(consolidationPrompt.user);
    const notesOutputCap = outputCap(
      "notes",
      RESERVE_TOKENS,
      previousSummaryTokens,
      model.maxTokens ?? 0,
    );
    const consolidationOutputCap = outputCap(
      "rewrite-consolidate",
      RESERVE_TOKENS,
      previousSummaryTokens,
      model.maxTokens ?? 0,
    );
    const contextWindow = model.contextWindow ?? 0;
    const fitRatio = (tokens: number): number =>
      contextWindow > 0 ? Math.round((tokens / contextWindow) * 10_000) / 10_000 : 0;

    const baseFixtureReport = {
      path: "qa/fixtures/real-model-conversation.json",
      sha256: rawSha256,
      invariants,
      firstHalfSummarySha256: sha256(fixture.firstHalfSummary),
      firstHalfSummaryTokens: previousSummaryTokens,
    };

    if (args.dryRun) {
      report = {
        schema: 1,
        task: 16,
        mode: "dry-run",
        generatedAt: new Date().toISOString(),
        model: args.model,
        calls: 0,
        fixture: baseFixtureReport,
        estimates: {
          notes: {
            conversationTokens: notesConversationTokens,
            systemPromptTokens: notesSystemTokens,
            userPromptTokens: notesUserTokens,
            promptTokens: notesSystemTokens + notesUserTokens,
            outputCapTokens: notesOutputCap,
            totalRequestTokens:
              notesConversationTokens + notesSystemTokens + notesUserTokens + notesOutputCap,
            fitRatio: fitRatio(
              notesConversationTokens + notesSystemTokens + notesUserTokens + notesOutputCap,
            ),
          },
          consolidation: {
            basis: "offline first-half summary; the notes output does not exist in a dry run",
            systemPromptTokens: consolidationSystemTokens,
            userPromptTokens: consolidationUserTokens,
            promptTokens: consolidationSystemTokens + consolidationUserTokens,
            outputCapTokens: consolidationOutputCap,
            totalRequestTokens:
              notesConversationTokens +
              consolidationSystemTokens +
              consolidationUserTokens +
              consolidationOutputCap,
            fitRatio: fitRatio(
              notesConversationTokens +
                consolidationSystemTokens +
                consolidationUserTokens +
                consolidationOutputCap,
            ),
          },
        },
        checks: {
          fixtureInvariants: invariants,
          selfTests,
          bothPass: invariants.ok && selfTests.ok,
        },
        cleanup: { registryFilesCopied: activeRegistryFiles },
      };
    } else {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        report = {
          schema: 1,
          task: 16,
          mode: "real",
          generatedAt: new Date().toISOString(),
          model: args.model,
          calls: 0,
          fixture: baseFixtureReport,
          checks: { fixtureInvariants: invariants, selfTests },
          error: { stage: "auth", message: auth.error ?? "auth resolution failed" },
        };
        return finish(report, args, 1);
      }

      let calls = 0;
      let lastProviderError: string | undefined;
      const wrappedRegistry: GenerateModelRegistry = {
        find: (provider, modelId) =>
          registry.find(provider, modelId) as never,
        getApiKeyAndHeaders: (targetModel) =>
          registry.getApiKeyAndHeaders(targetModel) as never,
        complete: async (targetModel, context, options) => {
          const typed = targetModel as { provider?: string; id?: string };
          if (typed.provider !== MODEL_PROVIDER || typed.id !== MODEL_NAME) {
            throw new Error("real-model guard: unexpected model");
          }
          if (calls >= 2) throw new Error("real-model guard: more than two calls");
          calls += 1;
          try {
            return (await registry.complete(targetModel, context, options)) as never;
          } catch (error) {
            lastProviderError = errorText(error);
            throw error;
          }
        },
      };
      const ctx: GenerateContext = {
        model: undefined,
        getCompactionSettings: () => ({
          model: REAL_MODEL_ID,
          reserveTokens: RESERVE_TOKENS,
        }),
        modelRegistry: wrappedRegistry,
        sessionManager: { getBranch: () => [] },
      };
      const source: PreparedSource = {
        previousSummary: fixture.firstHalfSummary,
        spanMessages,
        firstKeptEntryId: "fixture-keep-entry",
        tokensBefore: invariants.tokens.total,
        firstSpanEntryId: "fixture-second-half-first",
        lastSpanEntryId: "fixture-second-half-last",
        isSplitTurn: false,
        keepRecentEff: 20_000,
      };
      const takeProviderError = (): string | undefined => {
        const value = lastProviderError;
        lastProviderError = undefined;
        return value;
      };

      const notesCall = await oneCall(
        ctx,
        "notes",
        source,
        "real-notes-1",
        fixture.taskIntent,
        1,
        takeProviderError,
      );
      const callRecords: CallRecord[] = [notesCall.record];

      let notesCheck: Json | null = null;
      let consolidationCheck: Json | null = null;
      let consolidationCall: OneCall | null = null;

      if (notesCall.outcome.status === "ok") {
        const notesResult = notesCall.outcome.result;
        const notesBlock = extractNotesBlock(notesResult.summary);
        const notesRetention = countRetention(notesBlock, fixture.planted.secondHalf);
        const notesTitles = checkSectionTitles(notesBlock);
        notesCheck = {
          pass: notesRetention.matched >= 4 && notesTitles.ok,
          retention: notesRetention,
          sectionTitles: notesTitles,
          notesBlocks: notesResult.details?.earlyCompaction?.notesBlocks ?? null,
        };

        const consolidationSource: PreparedSource = {
          ...source,
          previousSummary: notesResult.summary,
        };
        const inheritedTaskIntent =
          notesResult.details?.taskIntent ?? fixture.taskIntent;
        consolidationCall = await oneCall(
          ctx,
          "rewrite-consolidate",
          consolidationSource,
          "real-consolidate-1",
          inheritedTaskIntent,
          2,
          takeProviderError,
        );
        callRecords.push(consolidationCall.record);

        const allItems = [
          ...fixture.planted.firstHalf,
          ...fixture.planted.secondHalf,
        ];
        const consolidationRetention = countRetention(
          consolidationCall.outcome.status === "ok"
            ? consolidationCall.outcome.result.summary
            : null,
          allItems,
        );
        consolidationCheck = {
          pass: consolidationRetention.matched >= 9,
          retention: consolidationRetention,
        };
      }

      const guardResult = guardCheck();
      const notesPass = notesCheck?.pass === true;
      const consolidationPass = consolidationCheck?.pass === true;
      const bothPass =
        notesCall.outcome.status === "ok" &&
        consolidationCall?.outcome.status === "ok" &&
        notesPass &&
        consolidationPass;
      const success =
        calls === 2 &&
        bothPass &&
        guardResult.ok &&
        invariants.ok &&
        selfTests.ok;

      report = {
        schema: 1,
        task: 16,
        mode: "real",
        generatedAt: new Date().toISOString(),
        model: args.model,
        calls,
        success,
        fixture: baseFixtureReport,
        checks: {
          fixtureInvariants: invariants,
          selfTests,
          notes: notesCheck,
          consolidation: consolidationCheck,
          bothRetentionChecksPass: notesPass && consolidationPass,
        },
        callsDetail: callRecords,
        guard: guardResult,
        cleanup: { registryFilesCopied: activeRegistryFiles },
      };
      if (!success) {
        report.error = {
          stage:
            notesCall.outcome.status !== "ok"
              ? "notes-call"
              : consolidationCall?.outcome.status !== "ok"
                ? "consolidation-call"
                : !notesPass
                  ? "notes-retention"
                  : !consolidationPass
                    ? "consolidation-retention"
                    : !guardResult.ok
                      ? "ag-guard"
                      : "preconditions",
        };
      }
      return finish(report, args, success ? 0 : 1);
    }
  } finally {
    if (activeTempAgentDir) {
      fs.rmSync(activeTempAgentDir, { recursive: true, force: true });
    }
  }

  // Dry-run path reaches here; `finish` records the cleanup state.
  finish(report, args, invariants.ok && selfTests.ok ? 0 : 1);
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      schema: 1,
      task: 16,
      calls: 0,
      error: { stage: "unhandled", message: errorText(error) },
    }),
  );
  process.exit(1);
});
