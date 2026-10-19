/**
 * In-process senpi session kit for the early-compaction QA.
 *
 * Every arm runs in its own subprocess because a mod (and OMO) patch process-wide
 * prototypes. The kit builds a real AgentSession with:
 *   - an isolated temporary agent dir (mkdtemp, removed by dispose()),
 *   - an in-memory session log (no live agent-dir writes),
 *   - the stock builtin compaction extension loaded by DefaultResourceLoader,
 *   - one inline probe extension (written into the temp dir) that exposes the
 *     extension context, so the arm can call ctx.applyCompaction directly,
 *   - an offline provider whose chat and summary responses are scripted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SENPI_ROOT = "C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi";
const PIAI_ROOT = "C:/Users/USER/.bun/install/global/node_modules/@earendil-works/pi-ai";
const CONTROL = Symbol.for("piomo.early-compaction.qa.control.v1");
export const DEFAULT_CONTEXT_WINDOW = 100_000;
export const DEFAULT_MAX_TOKENS = 8_192;
export const TODO_MARKER = "TODO-CONTINUITY-42";

export interface UsageNumbers {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface ScriptedChat {
  text: string;
  usage: UsageNumbers;
}

export interface ProviderRequestRecord {
  call: number;
  kind: "chat" | "summary";
  systemPrompt: string;
  messages: Array<{ role: string; text: string }>;
}

export interface CompactionEventRecord {
  accepted: boolean;
  reason: string;
  fromExtension: boolean;
  entryId?: string;
  firstKeptEntryId?: string;
  summary?: string;
  tokensBefore?: number;
  details?: unknown;
}

export interface BeforeCompactEventRecord {
  reason: string;
  requestId?: string;
}

export interface SessionKitOptions {
  cwd: string;
  chat: ScriptedChat[];
  summaryResponse: string;
  summaryUsage?: UsageNumbers;
  contextWindow?: number;
  maxTokens?: number;
  /** Extension session mode; idle warm-up requires tui or rpc. */
  mode?: "tui" | "rpc" | "print";
  compaction?: Record<string, unknown>;
}

export interface ApplyOptions {
  reason: "extension";
  expectedRevision?: number;
}

export interface ApplyResult {
  applied: boolean;
  reason: "ok" | "stale" | "rejected";
}

export interface SessionKit {
  readonly tempAgentDir: string;
  readonly requests: ProviderRequestRecord[];
  readonly compactionEvents: CompactionEventRecord[];
  readonly beforeCompactEvents: BeforeCompactEventRecord[];
  readonly loadedExtensions: string[];
  readonly session: any;
  prompt(text: string): Promise<void>;
  /** Append scripted chat responses (text + usage) for subsequent prompts. */
  scriptChat(entries: ScriptedChat[]): void;
  /** The most recent chat request the provider received. */
  lastChatRequest(): ProviderRequestRecord | undefined;
  applyCompaction(result: Record<string, unknown>, options: ApplyOptions): Promise<ApplyResult>;
  getMessageRevision(): number;
  getEntries(): any[];
  getBranch(): any[];
  getContextUsage(): unknown;
  dispose(): Promise<{ tempDirRemoved: boolean; tempDir: string }>;
}

interface Engine {
  createAgentSession: (options: Record<string, unknown>) => Promise<{ session: any }>;
  AuthStorage: { inMemory(): unknown };
  ModelRegistry: { inMemory(auth: unknown): any };
  SettingsManager: { inMemory(settings: Record<string, unknown>): unknown };
  DefaultResourceLoader: new (options: Record<string, unknown>) => any;
  SessionManager: { inMemory(cwd?: string): unknown };
  AssistantMessageEventStream: new () => any;
}

let enginePromise: Promise<Engine> | undefined;

function loadEngine(): Promise<Engine> {
  enginePromise ??= (async () => {
    const load = (absolute: string) => import(pathToFileURL(absolute).href);
    const [sdk, auth, registry, settings, loader, sessions, piAi] = await Promise.all([
      load(path.join(SENPI_ROOT, "dist/core/sdk.js")),
      load(path.join(SENPI_ROOT, "dist/core/auth-storage.js")),
      load(path.join(SENPI_ROOT, "dist/core/model-registry.js")),
      load(path.join(SENPI_ROOT, "dist/core/settings-manager.js")),
      load(path.join(SENPI_ROOT, "dist/core/resource-loader.js")),
      load(path.join(SENPI_ROOT, "dist/core/session-manager.js")),
      load(path.join(PIAI_ROOT, "dist/index.js")),
    ]);
    return {
      createAgentSession: sdk.createAgentSession as Engine["createAgentSession"],
      AuthStorage: auth.AuthStorage as Engine["AuthStorage"],
      ModelRegistry: registry.ModelRegistry as Engine["ModelRegistry"],
      SettingsManager: settings.SettingsManager as Engine["SettingsManager"],
      DefaultResourceLoader: loader.DefaultResourceLoader as Engine["DefaultResourceLoader"],
      SessionManager: sessions.SessionManager as Engine["SessionManager"],
      AssistantMessageEventStream: piAi.AssistantMessageEventStream as Engine["AssistantMessageEventStream"],
    };
  })();
  return enginePromise;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function isSummaryRequest(messages: Array<{ role?: string; content?: unknown }>): boolean {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const text = textOf(lastUser?.content);
  return (
    text.includes("SUMMARY INSTRUCTION") ||
    text.includes("COMPACTION ARCHIVIST") ||
    text.includes("Create a structured handoff summary") ||
    text.includes("Create a compact prefix summary")
  );
}

/**
 * The probe is written into the temp agent dir as an inline extension. It only
 * observes: it captures the extension ctx and records compaction hook events.
 * It never appends entries.
 */
const INLINE_PROBE_SOURCE = `const CONTROL = Symbol.for("piomo.early-compaction.qa.control.v1");
export default function continuityProbe(pi) {
  pi.on("session_start", async (_event, ctx) => {
    const control = globalThis[CONTROL];
    if (control) control.ctx = ctx;
  });
  pi.on("session_before_compact", async (event) => {
    const control = globalThis[CONTROL];
    if (!control) return;
    control.beforeCompact.push({ reason: event.reason, requestId: event.requestId });
  });
  pi.on("session_compact", async (event) => {
    const control = globalThis[CONTROL];
    if (!control) return;
    const record = {
      accepted: event.accepted === true,
      reason: event.reason,
      fromExtension: event.fromExtension === true,
      entryId: event.compactionEntry?.id,
      firstKeptEntryId: event.compactionEntry?.firstKeptEntryId,
      summary: event.compactionEntry?.summary,
      tokensBefore: event.compactionEntry?.tokensBefore,
      details: event.compactionEntry?.details,
    };
    control.compactions.push(record);
  });
}
`;

interface ControlState {
  ctx?: any;
  compactions: CompactionEventRecord[];
  beforeCompact: BeforeCompactEventRecord[];
}

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export async function startSession(options: SessionKitOptions): Promise<SessionKit> {
  const engine = await loadEngine();
  const tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "piomo-continuity-agent-"));
  const control: ControlState = { compactions: [], beforeCompact: [] };
  (globalThis as Record<symbol, unknown>)[CONTROL] = control;
  const extensionPath = path.join(tempAgentDir, "continuity-probe.mjs");
  fs.writeFileSync(extensionPath, INLINE_PROBE_SOURCE, "utf8");

  const requests: ProviderRequestRecord[] = [];
  const chatScript = [...options.chat];
  let chatIndex = 0;
  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const makeStream = (text: string, usage: UsageNumbers) => {
    const message = {
      role: "assistant",
      api: "openai-completions",
      provider: "qa-offline",
      model: "offline",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: { ...usage, cost: zeroCost() },
    };
    const stream = new engine.AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };

  try {
    const settingsManager = engine.SettingsManager.inMemory({
      compaction: {
        enabled: true,
        speculativeEnabled: false,
        idleCompactionEnabled: false,
        restorationEnabled: true,
        ...(options.compaction ?? {}),
      },
      extensions: [extensionPath],
    });
    const loader = new engine.DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: tempAgentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    if (loaded.errors?.length) {
      throw new Error(`session kit: extension load errors: ${JSON.stringify(loaded.errors)}`);
    }
    const loadedExtensions = (loaded.extensions ?? []).map((extension: any) =>
      typeof extension?.path === "string" ? extension.path : String(extension?.resolvedPath ?? "unknown"),
    );

    const authStorage = engine.AuthStorage.inMemory();
    const registry = engine.ModelRegistry.inMemory(authStorage);
    registry.registerProvider("qa-offline", {
      api: "openai-completions",
      apiKey: "offline-not-a-credential",
      baseUrl: "http://offline.invalid",
      models: [
        {
          id: "offline",
          name: "Offline continuity provider",
          reasoning: false,
          input: ["text"],
          cost: zeroCost(),
          contextWindow,
          maxTokens,
        },
      ],
      streamSimple: (_model: unknown, context: any) => {
        const rawMessages = Array.isArray(context?.messages) ? context.messages : [];
        const kind: "chat" | "summary" = isSummaryRequest(rawMessages) ? "summary" : "chat";
        const record: ProviderRequestRecord = {
          call: requests.length,
          kind,
          systemPrompt: typeof context?.systemPrompt === "string" ? context.systemPrompt : "",
          messages: rawMessages.map((message: any) => ({
            role: typeof message?.role === "string" ? message.role : "unknown",
            text: textOf(message?.content),
          })),
        };
        requests.push(record);
        if (kind === "summary") {
          return makeStream(
            options.summaryResponse,
            options.summaryUsage ?? { input: 32, output: 16, cacheRead: 0, cacheWrite: 0, totalTokens: 48 },
          );
        }
        const scripted = chatScript[chatIndex++];
        if (!scripted) {
          throw new Error(`session kit: no scripted chat response for provider call ${record.call}`);
        }
        return makeStream(scripted.text, scripted.usage);
      },
    });

    const model = registry.find("qa-offline", "offline");
    if (!model) throw new Error("session kit: offline model was not registered");

    const { session } = await engine.createAgentSession({
      cwd: options.cwd,
      agentDir: tempAgentDir,
      model,
      modelRegistry: registry,
      settingsManager,
      resourceLoader: loader,
      sessionManager: engine.SessionManager.inMemory(options.cwd),
      noTools: "all",
    });
    await session.bindExtensions({ mode: options.mode ?? "print" });
    if (!control.ctx) {
      throw new Error("session kit: probe extension did not capture a session context");
    }

    let disposed: { tempDirRemoved: boolean; tempDir: string } | undefined;
    return {
      tempAgentDir,
      requests,
      compactionEvents: control.compactions,
      beforeCompactEvents: control.beforeCompact,
      loadedExtensions,
      session,
      async prompt(text: string) {
        await session.prompt(text);
      },
      scriptChat(entries: ScriptedChat[]) {
        chatScript.push(...entries);
      },
      lastChatRequest() {
        return requests.filter((request) => request.kind === "chat").at(-1);
      },
      async applyCompaction(result: Record<string, unknown>, applyOptions: ApplyOptions) {
        const ctx = control.ctx;
        if (!ctx) throw new Error("session kit: extension ctx is not captured");
        return (await ctx.applyCompaction(result, applyOptions)) as ApplyResult;
      },
      getMessageRevision() {
        const ctx = control.ctx;
        if (!ctx) throw new Error("session kit: extension ctx is not captured");
        return ctx.getMessageRevision() as number;
      },
      getEntries() {
        return session.sessionManager.getEntries() as any[];
      },
      getBranch() {
        return session.sessionManager.getBranch() as any[];
      },
      getContextUsage() {
        return session.getContextUsage();
      },
      async dispose() {
        if (disposed) return disposed;
        try {
          const runner = session.extensionRunner;
          if (typeof runner?.hasHandlers === "function" && runner.hasHandlers("session_shutdown")) {
            await runner.emit({ type: "session_shutdown", reason: "quit" });
          }
        } finally {
          try {
            session.dispose();
          } finally {
            fs.rmSync(tempAgentDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
            if ((globalThis as Record<symbol, unknown>)[CONTROL] === control) {
              delete (globalThis as Record<symbol, unknown>)[CONTROL];
            }
            disposed = { tempDirRemoved: !fs.existsSync(tempAgentDir), tempDir: tempAgentDir };
          }
        }
        return disposed;
      },
    };
  } catch (error) {
    fs.rmSync(tempAgentDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    throw error;
  }
}

export type ArmName = "builtin" | "mod" | "core";

export interface ArmConfig {
  arm: ArmName;
  cwd: string;
  prompt1: string;
  prompt2: string;
  chat: ScriptedChat[];
  summaryResponse: string;
  summaryUsage?: UsageNumbers;
  contextWindow?: number;
  maxTokens?: number;
  mode?: "tui" | "rpc" | "print";
  compaction?: Record<string, unknown>;
  mod?: {
    summary: string;
    cutIndex: number;
    tokensBefore: number;
    details?: unknown;
  };
}

export interface ArmResult {
  arm: ArmName;
  ok: boolean;
  cleanup: { tempDirRemoved: boolean; tempDir: string };
  loadedExtensions: string[];
  afterPrompt1: {
    usage: unknown;
    revision: number;
    entries: number;
    branch: number;
    model: { contextWindow?: number; maxTokens?: number; provider?: string; id?: string } | null;
  } | null;
  requests: ProviderRequestRecord[];
  nextRequest: ProviderRequestRecord | null;
  entries: any[];
  branch: any[];
  compactionEvents: CompactionEventRecord[];
  beforeCompactEvents: BeforeCompactEventRecord[];
  compactionEntry: any | null;
  extracted: {
    summary: string;
    cutIndex: number;
    tokensBefore: number;
    details: unknown;
    fromExtension: boolean;
  } | null;
  apply: {
    result: ApplyResult;
    stale?: { result: ApplyResult; entriesDelta: number };
  } | null;
}

/** Run one arm end to end. Intended to be the subprocess entry point. */
export async function runArm(config: ArmConfig): Promise<ArmResult> {
  const kit = await startSession({
    cwd: config.cwd,
    chat: config.chat,
    summaryResponse: config.summaryResponse,
    summaryUsage: config.summaryUsage,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    mode: config.mode,
    compaction: config.compaction,
  });
  let apply: ArmResult["apply"] = null;
  let afterPrompt1: ArmResult["afterPrompt1"] = null;
  let cleanup = { tempDirRemoved: false, tempDir: kit.tempAgentDir };
  let result: Omit<ArmResult, "cleanup"> | undefined;
  try {
    await kit.prompt(config.prompt1);
    afterPrompt1 = {
      usage: kit.getContextUsage(),
      revision: kit.getMessageRevision(),
      entries: kit.getEntries().length,
      branch: kit.getBranch().length,
      model: kit.session.model
        ? {
            contextWindow: kit.session.model.contextWindow,
            maxTokens: kit.session.model.maxTokens,
            provider: kit.session.model.provider,
            id: kit.session.model.id,
          }
        : null,
    };

    if (config.arm === "mod") {
      if (!config.mod) throw new Error("mod arm requires mod result data");
      const branch = kit.getBranch();
      const kept = branch[config.mod.cutIndex];
      if (!kept?.id) {
        throw new Error(`mod arm: no branch entry at cut index ${config.mod.cutIndex}`);
      }
      const entriesBefore = kit.getEntries().length;
      const revision = kit.getMessageRevision();
      const result = {
        summary: config.mod.summary,
        firstKeptEntryId: kept.id,
        tokensBefore: config.mod.tokensBefore,
        ...(config.mod.details === undefined ? {} : { details: config.mod.details }),
      };
      const stale = await kit.applyCompaction(result, {
        reason: "extension",
        expectedRevision: revision - 1,
      });
      const entriesAfterStale = kit.getEntries().length;
      const applied = await kit.applyCompaction(result, {
        reason: "extension",
        expectedRevision: revision,
      });
      apply = {
        result: applied,
        stale: { result: stale, entriesDelta: entriesAfterStale - entriesBefore },
      };
    } else if (config.arm === "core") {
      await kit.session.compact();
      apply = { result: { applied: true, reason: "ok" } };
    }

    await kit.prompt(config.prompt2);

    const entries = kit.getEntries();
    const branch = kit.getBranch();
    const compactionEntry = entries.find((entry) => entry.type === "compaction") ?? null;
    const cutIndex =
      compactionEntry === null
        ? -1
        : entries.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId);
    const extracted =
      compactionEntry === null
        ? null
        : {
            summary: compactionEntry.summary,
            cutIndex,
            tokensBefore: compactionEntry.tokensBefore,
            details: compactionEntry.details,
            fromExtension: compactionEntry.fromExtension === true,
          };
    result = {
      arm: config.arm,
      ok: true,
      loadedExtensions: kit.loadedExtensions,
      afterPrompt1,
      requests: kit.requests,
      nextRequest: kit.lastChatRequest() ?? null,
      entries,
      branch,
      compactionEvents: kit.compactionEvents,
      beforeCompactEvents: kit.beforeCompactEvents,
      compactionEntry,
      extracted,
      apply,
    };
  } finally {
    cleanup = await kit.dispose();
  }
  if (!result) throw new Error("arm produced no result");
  return { ...result, cleanup };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const configPath = argument("--config");
  if (!configPath) {
    console.error("usage: bun qa/session-kit.ts --config <arm-config.json> [--out <result.json>]");
    process.exitCode = 2;
  } else {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as ArmConfig;
    try {
      const result = await runArm(config);
      const outPath = argument("--out");
      if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
      console.log(
        JSON.stringify({
          arm: result.arm,
          ok: result.ok,
          compactionEvents: result.compactionEvents.length,
          beforeCompactEvents: result.beforeCompactEvents.length,
          tempDirRemoved: result.cleanup.tempDirRemoved,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const outPath = argument("--out");
      if (outPath) {
        fs.writeFileSync(outPath, JSON.stringify({ arm: config.arm, ok: false, error: message }, null, 2) + "\n", "utf8");
      }
      console.error(message);
      process.exitCode = 1;
    }
  }
}
