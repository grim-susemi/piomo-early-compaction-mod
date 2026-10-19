/**
 * Isolated QA worker: one arm per subprocess.
 *
 * The parent (`qa/isolated.ts`) writes a JSON config and spawns this file with
 * Bun. Each case builds real senpi AgentSessions through `qa/session-kit.ts`,
 * loads the bundled `dist/early-compaction.js` from the session's temporary
 * agent dir, and drives the extension through real prompt/agent/compaction
 * events. Nothing here writes outside a temp dir, and every session is
 * disposed before the process exits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { NOTES_HEADER_RE, NOTES_SECTION_TITLES } from "../src/constants";
import { computeEffectiveThreshold } from "../src/policy";
import { installIsolationClock, type IsolationClock } from "./isolation-clock";
import { startSession, type ScriptedChat, type SessionKit } from "./session-kit";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

export const TASK_INTENT_MARKER = "QA-TASK-INTENT-14";
const QUEUED_MARKER = "QUEUED-FOR-NEXT-TURN-14";

const SUMMARY_RESPONSE = [
  "<task-intent>",
  "ORIGINAL_REQUEST: isolated QA fixture",
  "TASK_TYPE: QA",
  "MUST_PRESERVE: the fixture markers",
  "</task-intent>",
  "<summary>",
  "## 1. User Requests (Verbatim)",
  "- Isolated QA fixture.",
  "## 2. Key Technical Concepts",
  "- early compaction",
  "## 3. Files and Code Sections",
  "- qa/isolated.ts",
  "## 4. Errors and Fixes",
  "- None.",
  "## 5. Problem Solving",
  "- Fixture state.",
  "## 6. Remaining Tasks",
  "- Continue the isolated fixture.",
  "## 7. Exact Next Steps",
  "- Run the next fixture step.",
  "</summary>",
].join("\n");

const NOTES_RESPONSE = [
  "<summary>",
  "## New user requests",
  "- Continue the isolated fixture.",
  "## New constraints",
  "- Keep the fixture markers unchanged.",
  "## Work done",
  "- Added the notes fixture state.",
  "## Current state and files",
  "- qa/isolated.ts holds the fixture.",
  "## Current next steps",
  "- Verify the next fixture step.",
  "</summary>",
].join("\n");

export interface WorkerConfig {
  caseName: string;
  bundlePath: string;
  omoSource: string;
  cmExtensionPath?: string;
  armDir: string;
  qualified: unknown;
  config: { mode: "notes" | "rewrite"; policy: Record<string, unknown>; allowRpcInteractive?: boolean };
  env?: Record<string, string>;
  brokenBundle?: boolean;
}

interface ScenarioResult {
  id: string;
  pass: boolean;
  observable: string;
  details?: Record<string, unknown>;
}

interface WorkerResult {
  caseName: string;
  pass: boolean;
  scenarios: ScenarioResult[];
  artifacts: Record<string, unknown>;
  cleanup: { sessions: number; tempDirsRemoved: number; tempDirs: string[] };
  uncaught: string[];
}

type OrderEntry = "mod" | "omo" | "cm";

interface OpenOptions {
  chat: ScriptedChat[];
  window?: number;
  api?: "openai-completions" | "anthropic-messages";
  provider?: "qa-offline" | "qa-local";
  localBaseUrl?: string;
  ui?: boolean;
  mode?: "tui" | "rpc" | "print";
  sessionKind?: "interactive" | "worker";
  installMod?: boolean;
  copyOmo?: boolean;
  order?: OrderEntry[];
  park?: boolean;
  compaction?: Record<string, unknown>;
  qualified?: unknown;
  failSummaryCalls?: number[];
  deferSummaryCalls?: number[];
  sessionDir?: string;
  sessionFile?: string;
  policy?: Record<string, unknown>;
  modeValue?: "notes" | "rewrite";
  allowRpcInteractive?: boolean;
}

function usage(input: number, output = 10): ScriptedChat["usage"] {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output };
}

function big(tokens: number): string {
  return "fixture word ".repeat(Math.max(1, Math.ceil((tokens * 4) / 13)));
}

function isNotesHeader(line: string): boolean {
  return NOTES_HEADER_RE.test(line);
}

function notesHeaderCount(summary: string): number {
  return summary.split("\n").filter(isNotesHeader).length;
}

function hasAllNotesSections(summary: string): boolean {
  return NOTES_SECTION_TITLES.every((title) => summary.includes(`## ${title}`));
}

function contentOf(result: any): string {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

class Worker {
  readonly cfg: WorkerConfig;
  readonly clock: IsolationClock;
  readonly scenarios: ScenarioResult[] = [];
  readonly artifacts: Record<string, unknown> = {};
  readonly uncaught: string[] = [];
  readonly tempDirs: string[] = [];
  sessions = 0;

  constructor(cfg: WorkerConfig) {
    this.cfg = cfg;
    this.clock = installIsolationClock();
    process.on("uncaughtException", (error) => {
      this.uncaught.push(`uncaughtException: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    });
    process.on("unhandledRejection", (reason) => {
      this.uncaught.push(`unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
    });
  }

  record(id: string, pass: boolean, observable: string, details?: Record<string, unknown>): void {
    this.scenarios.push({ id, pass, observable, ...(details ? { details } : {}) });
  }

  async scenario(id: string, fn: () => Promise<string>, details?: () => Record<string, unknown>): Promise<void> {
    try {
      const observable = await fn();
      this.record(id, true, observable, details?.());
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.record(id, false, message);
    }
  }

  async open(options: OpenOptions): Promise<SessionKit> {
    this.sessions += 1;
    const order = options.order ?? (options.installMod === false ? [] : ["mod"]);
    const installMod = options.installMod ?? order.includes("mod");
    const copyOmo = options.copyOmo ?? order.includes("omo");
    const copyCm = order.includes("cm");
    const policy = { startJitterMaxMs: 0, ...(options.policy ?? {}) };
    const modeValue = options.modeValue ?? this.cfg.config.mode;

    const kit = await startSession({
      cwd: REPO,
      chat: options.chat,
      summaryResponse: SUMMARY_RESPONSE,
      notesResponse: NOTES_RESPONSE,
      contextWindow: options.window,
      maxTokens: 8192,
      mode: options.mode ?? "tui",
      sessionKind: options.sessionKind ?? "interactive",
      ui: options.ui ?? false,
      api: options.api ?? "openai-completions",
      provider: options.provider,
      localBaseUrl: options.localBaseUrl,
      compaction: {
        speculativeEnabled: false,
        idleCompactionEnabled: false,
        keepRecentTokens: 1024,
        model: "qa-summary/offline",
        ...(this.cfg.config.mode === "notes" ? {} : {}),
        ...(options.compaction ?? {}),
      },
      failSummaryCalls: options.failSummaryCalls,
      deferSummaryCalls:
        options.deferSummaryCalls ??
        (installMod && options.failSummaryCalls === undefined && options.policy?.startRatio === undefined
          ? [0]
          : undefined),
      sessionDir: options.sessionDir,
      sessionFile: options.sessionFile,
      agentDirSetup: (agentDir) => {
        const stateDir = path.join(agentDir, "early-compaction");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, "qualified.json"),
          `${JSON.stringify(options.qualified ?? this.cfg.qualified, null, 2)}\n`,
          "utf8",
        );
        fs.writeFileSync(
          path.join(stateDir, "config.json"),
          `${JSON.stringify({
            schema: 1,
            mode: modeValue,
            policy,
            allowRpcInteractive: options.allowRpcInteractive ?? this.cfg.config.allowRpcInteractive ?? false,
          })}\n`,
          "utf8",
        );

        const extensionsDir = path.join(agentDir, "extensions");
        fs.mkdirSync(extensionsDir, { recursive: true });
        if (installMod) {
          fs.copyFileSync(this.cfg.bundlePath, path.join(extensionsDir, "early-compaction.js"));
        }
        if (copyOmo) {
          fs.copyFileSync(this.cfg.omoSource, path.join(extensionsDir, "omo-compaction-model.ts"));
        }
        if (copyCm) {
          if (!this.cfg.cmExtensionPath) throw new Error("CM extension path was not supplied");
          fs.copyFileSync(this.cfg.cmExtensionPath, path.join(extensionsDir, "cm-extension.js"));
        }
        if (options.park) {
          const result = spawnSync(
            process.execPath,
            [path.join(REPO, "scripts/mod.mjs"), "off", "--agent-dir", agentDir],
            { cwd: REPO, encoding: "utf8" },
          );
          if (result.status !== 0) {
            throw new Error(`mod.mjs off failed (${result.status}): ${result.stdout ?? ""}${result.stderr ?? ""}`);
          }
        }
      },
      extensionsFor: (agentDir) => {
        const dir = path.join(agentDir, "extensions");
        const paths: Record<OrderEntry, string> = {
          mod: path.join(dir, "early-compaction.js"),
          omo: path.join(dir, "omo-compaction-model.ts"),
          cm: path.join(dir, "cm-extension.js"),
        };
        return options.park ? [] : order.map((entry) => paths[entry]);
      },
    });
    this.tempDirs.push(kit.tempAgentDir);
    return kit;
  }

  async dispose(kit: SessionKit): Promise<void> {
    try {
      await kit.dispose();
    } catch {
      // Cleanup is best effort; the parent removes arm dirs anyway.
    }
  }

  metrics(kit: SessionKit): any[] {
    return kit.readMetrics();
  }

  async waitForMetric(kit: SessionKit, predicate: (event: any) => boolean, turns = 1200): Promise<boolean> {
    return kit.waitFor(() => this.metrics(kit).some(predicate), turns);
  }

  events(kit: SessionKit, name: string): any[] {
    return this.metrics(kit).filter((event) => event.event === name);
  }

  /** Forwarding counters over the real AgentSession/SessionManager methods. */
  realCalls(kit: SessionKit) {
    return kit.realCallCounts();
  }

  /** Forwarding counters over summary provider calls and their abort signals. */
  generation(kit: SessionKit) {
    return kit.generationCounts();
  }

  async settle(kit: SessionKit): Promise<void> {
    await kit.emit("agent_settled", { type: "agent_settled" });
  }

  /**
   * The first summary is deferred, so the real agent_settled runs while the job
   * is GENERATING (no apply). Release it, wait for READY, and optionally emit
   * the settled event that earns the boundary route.
   */
  async makeReady(kit: SessionKit, id: string, settleAfter = false): Promise<void> {
    await this.settle(kit);
    await kit.waitFor(() => false, 40);
    kit.releaseSummary();
    const ready = await this.waitForMetric(
      kit,
      (event) => event.event === "job_end" && event.outcome === "ready",
    );
    if (!ready) throw new Error(`${id}: the job never became READY`);
    if (settleAfter) await this.settle(kit);
  }

  lastBranchId(kit: SessionKit): string {
    const branch = kit.getBranch();
    const last = branch[branch.length - 1];
    if (!last?.id) throw new Error("branch has no leaf entry");
    return last.id;
  }

  seedCompaction(kit: SessionKit, summary: string, taskIntent?: string): string {
    const id = kit.session.sessionManager.appendCompaction(
      summary,
      this.lastBranchId(kit),
      1000,
      {
        schema: "senpi.compaction.summary.v1",
        ...(taskIntent === undefined ? {} : { taskIntent }),
        origin: "piomo.early-compaction",
      },
      true,
    );
    return id;
  }

  async runS1(kit: SessionKit): Promise<{
    apply: any;
    entry: any;
    summary: string;
    headerCount: number;
    sections: boolean;
    kind: string | undefined;
    applyCompactionCalls: number;
  }> {
    await kit.prompt(`Seed prompt. ${big(200)}`);
    this.seedCompaction(
      kit,
      "BASE SUMMARY\n## 6. Remaining Tasks\n- Base task stays.",
      TASK_INTENT_MARKER,
    );
    await kit.prompt(`Boundary prompt. ${big(12000)}`);
    await this.makeReady(kit, "S1", true);
    const applied = await this.waitForMetric(
      kit,
      (event) => event.event === "apply" && event.result === "ok" && event.route === "boundary",
    );
    if (!applied) throw new Error("S1: no boundary apply was recorded");
    const apply = this.events(kit, "apply").find((event) => event.result === "ok");
    const calls = this.realCalls(kit);
    if (calls.applyCompaction < 1) {
      throw new Error("S1: the real AgentSession.applyCompaction was never called");
    }
    const entry = kit.compactionEvents.find((event) => event.accepted && event.fromExtension);
    if (!entry) throw new Error("S1: no accepted extension compaction event");
    const summary = entry.summary ?? "";
    const headerCount = notesHeaderCount(summary);
    const sections = hasAllNotesSections(summary);
    const kind = (entry.details as any)?.earlyCompaction?.kind;
    return { apply, entry, summary, headerCount, sections, kind, applyCompactionCalls: calls.applyCompaction };
  }

  async finish(): Promise<WorkerResult> {
    this.clock.restore();
    return {
      caseName: this.cfg.caseName,
      pass: this.scenarios.every((scenario) => scenario.pass) && this.uncaught.length === 0,
      scenarios: this.scenarios,
      artifacts: this.artifacts,
      cleanup: {
        sessions: this.sessions,
        tempDirsRemoved: this.tempDirs.filter((dir) => !fs.existsSync(dir)).length,
        tempDirs: this.tempDirs,
      },
      uncaught: this.uncaught,
    };
  }
}

async function armBroken(worker: Worker): Promise<void> {
  await worker.scenario("broken-gate", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({ chat: [{ text: "seed", usage: usage(1_000) }] });
      await kit.prompt("Broken bundle prompt.");
      const gate = worker.events(kit, "gate").at(-1);
      worker.artifacts.brokenGate = gate ?? null;
      if (gate?.state !== "dormant" || gate?.reason !== "capability") {
        throw new Error(`broken bundle gate ${JSON.stringify(gate)}`);
      }
      return `broken bundle dormant(capability)`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S1", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        chat: [
          { text: "seed answer", usage: usage(1_000) },
          { text: big(7000), usage: usage(50_000) },
        ],
      });
      const result = await worker.runS1(kit);
      return `unexpected S1 pass with a broken bundle: ${JSON.stringify(result.apply)}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

async function armA(worker: Worker): Promise<void> {
  await worker.scenario("S6-arm-A", async () => {
    const kit = await worker.open({
      installMod: false,
      ui: true,
      chat: [
        { text: big(12000), usage: usage(56_000) },
        { text: "second answer", usage: usage(56_010) },
      ],
      compaction: { speculativeEnabled: true, idleCompactionEnabled: true },
    });
    try {
      await kit.prompt(`Stock first prompt. ${big(3000)}`);
      await kit.prompt("Stock second prompt.");
      const log = await kit.readCompactionLog();
      const count = log.filter((event) => event.event === "speculative_started").length;
      worker.artifacts.s6a = { speculativeStarted: count, chatRequests: kit.requests.filter((request) => request.kind === "chat").length };
      if (count < 1) throw new Error(`arm A had ${count} speculative_started events`);
      return `stock builtin speculative_started=${count}`;
    } finally {
      await worker.dispose(kit);
    }
  });

  await worker.scenario("S7-arm-A", async () => {
    const kit = await worker.open({
      installMod: false,
      ui: true,
      chat: [
        { text: big(1000), usage: usage(20_000) },
        { text: "second answer", usage: usage(20_010) },
      ],
    });
    try {
      await kit.prompt("Stock S7 first prompt.");
      await kit.prompt("Stock S7 second prompt.");
      const snapshot = {
        entryTypes: kit.getEntries().map((entry) => entry.type),
        compactionCount: kit.getEntries().filter((entry) => entry.type === "compaction").length,
        uiStatuses: kit.ui.statuses.filter((entry) => entry.key === "early-compaction").length,
        uiNotices: kit.ui.notices.filter((notice) => notice.message.includes("early-compaction")).length,
      };
      worker.artifacts.s7a = snapshot;
      return `stock entries=${snapshot.entryTypes.join(",")} compactions=${snapshot.compactionCount} footer=${snapshot.uiStatuses}`;
    } finally {
      await worker.dispose(kit);
    }
  });
}

async function armG(worker: Worker): Promise<void> {
  await worker.scenario("S7-arm-G", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        installMod: true,
        park: true,
        ui: true,
        chat: [
          { text: big(1000), usage: usage(20_000) },
          { text: "second answer", usage: usage(20_010) },
        ],
      });
      const parked = fs.existsSync(path.join(kit.tempAgentDir, "early-compaction", "parked", "early-compaction.js"));
      const active = fs.existsSync(path.join(kit.tempAgentDir, "extensions", "early-compaction.js"));
      if (!parked || active) throw new Error(`parking failed: parked=${parked} active=${active}`);
      const modLoaded = kit.loadedExtensions.some((file) => path.basename(file).startsWith("early-compaction"));
      if (modLoaded) throw new Error(`G: the parked mod is still loaded: ${JSON.stringify(kit.loadedExtensions)}`);
      await kit.prompt("Parked S7 first prompt.");
      await kit.prompt("Parked S7 second prompt.");
      const snapshot = {
        entryTypes: kit.getEntries().map((entry) => entry.type),
        compactionCount: kit.getEntries().filter((entry) => entry.type === "compaction").length,
        uiStatuses: kit.ui.statuses.filter((entry) => entry.key === "early-compaction").length,
        uiNotices: kit.ui.notices.filter((notice) => notice.message.includes("early-compaction")).length,
        parked,
        active,
        modLoaded,
      };
      worker.artifacts.s7g = snapshot;
      return `parked entries=${snapshot.entryTypes.join(",")} compactions=${snapshot.compactionCount} footer=${snapshot.uiStatuses} realOffParked=true`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

async function armB(worker: Worker): Promise<void> {
  await worker.scenario("S1", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        chat: [
          { text: "seed answer", usage: usage(1_000) },
          { text: big(7000), usage: usage(50_000) },
        ],
      });
      const result = await worker.runS1(kit);
      if (result.apply.result !== "ok") throw new Error(`S1 apply result ${result.apply.result}`);
      if (result.kind !== "notes") throw new Error(`S1 kind ${String(result.kind)}`);
      if (result.headerCount !== 1) throw new Error(`S1 notes headers ${result.headerCount}`);
      if (!result.sections) throw new Error("S1 notes sections missing");
      if (!result.summary.startsWith("BASE SUMMARY")) throw new Error("S1 previous summary was not kept verbatim");
      worker.artifacts.s1 = {
        apply: result.apply,
        kind: result.kind,
        headerCount: result.headerCount,
        sections: result.sections,
        summaryPrefixKept: result.summary.startsWith("BASE SUMMARY"),
        details: (result.entry as any).details,
        applyCompactionCalls: result.applyCompactionCalls,
        gate: worker.events(kit, "gate").at(-1) ?? null,
      };
      return `boundary apply={applied:true,reason:ok} kind=${result.kind} headers=${result.headerCount} sections=5 realApplyCompaction=${result.applyCompactionCalls}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S2", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        chat: [
          { text: big(6000), usage: usage(50_000) },
          { text: big(6000), usage: usage(52_000), defer: true },
          { text: "done", usage: usage(53_000) },
        ],
      });
      await kit.prompt(`Streaming first prompt. ${big(12000)}`);
      await worker.makeReady(kit, "S2");
      const streaming = kit.prompt("Streaming second prompt.");
      await kit.waitForChatStart();
      const isStreaming = kit.isStreaming();
      const beforeStream = worker.realCalls(kit);
      worker.clock.fireIntervals();
      await kit.waitFor(() => false, 40);
      const calls = worker.realCalls(kit);
      const applies = worker.events(kit, "apply").length;
      const discards = worker.events(kit, "discard").length;
      const applyCompactionDelta = calls.applyCompaction - beforeStream.applyCompaction;
      const idleFalseReads = calls.isIdleFalseReads - beforeStream.isIdleFalseReads;
      const streamingTrueReads = calls.isStreamingTrueReads - beforeStream.isStreamingTrueReads;
      kit.releaseChat();
      await streaming;
      if (!isStreaming) throw new Error("S2: session was not streaming");
      if (applies !== 0 || discards !== 0) {
        throw new Error(`S2: applies=${applies} discards=${discards} during the stream`);
      }
      if (applyCompactionDelta !== 0) {
        throw new Error(`S2: real applyCompaction calls=${applyCompactionDelta} during the stream`);
      }
      if (idleFalseReads < 1) {
        throw new Error(
          `S2: real gating state was not observed (isIdle=false reads=${idleFalseReads})`,
        );
      }
      worker.artifacts.s2 = {
        isStreaming,
        appliesDuringStream: applies,
        discardsDuringStream: discards,
        applyCompactionDelta,
        idleFalseReads,
        streamingTrueReads,
      };
      return `streaming=true applies=0 while the run was open; real isIdle=false reads=${idleFalseReads}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S3", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        api: "anthropic-messages",
        chat: [
          { text: big(6000), usage: usage(50_000) },
        ],
      });
      await kit.prompt(`Cold first prompt. ${big(12000)}`);
      await worker.makeReady(kit, "S3");
      worker.clock.advance(331_000);
      worker.clock.fireIntervals();
      const applied = await worker.waitForMetric(
        kit,
        (event) => event.event === "apply" && event.result === "ok",
      );
      if (!applied) throw new Error("S3: idle timer did not apply");
      const apply = worker.events(kit, "apply").find((event) => event.result === "ok");
      if (apply.route !== "cold" || apply.site !== "timer") {
        throw new Error(`S3: route=${apply.route} site=${apply.site}`);
      }
      const calls = worker.realCalls(kit);
      if (calls.applyCompaction < 1) {
        throw new Error("S3: the real AgentSession.applyCompaction was never called");
      }
      worker.artifacts.s3 = { ...apply, applyCompactionCalls: calls.applyCompaction };
      return `idle timer apply route=cold site=timer after TTL+grace; realApplyCompaction=${calls.applyCompaction}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S4", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        chat: [
          { text: big(6000), usage: usage(50_000) },
        ],
      });
      await kit.prompt(`Context edit first prompt. ${big(12000)}`);
      await worker.makeReady(kit, "S4");
      const firstUser = kit.getBranch().find((entry) => entry.type === "message" && entry.message?.role === "user");
      if (!firstUser) throw new Error("S4: no user entry");
      kit.session.sessionManager.appendContextEdit(firstUser.id, null);
      await worker.settle(kit);
      const discarded = await worker.waitForMetric(
        kit,
        (event) => event.event === "discard" && event.reason === "context-edit",
      );
      const calls = worker.realCalls(kit);
      const applies = worker.events(kit, "apply").length;
      if (!discarded) throw new Error("S4: no context-edit discard");
      if (calls.appendContextEdit < 1) {
        throw new Error("S4: the real SessionManager.appendContextEdit was never called");
      }
      if (applies !== 0 || calls.applyCompaction !== 0) {
        throw new Error(`S4: applies=${applies} realApplyCompaction=${calls.applyCompaction} followed the edit`);
      }
      worker.artifacts.s4 = {
        discard: "context-edit",
        applies,
        appendContextEditCalls: calls.appendContextEdit,
        applyCompactionCalls: calls.applyCompaction,
      };
      return `READY job discarded (context-edit); applies=0; realAppendContextEdit=${calls.appendContextEdit}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S5", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        failSummaryCalls: [0],
        chat: [
          { text: big(6000), usage: usage(75_000) },
          { text: "after builtin compaction", usage: usage(40_000) },
        ],
      });
      await kit.prompt(`Failing generation first prompt. ${big(12000)}`);
      const failed = await worker.waitForMetric(
        kit,
        (event) => event.event === "job_end" && event.outcome === "failed",
      );
      if (!failed) throw new Error("S5: forced generation failure was not recorded");
      await kit.prompt("Threshold prompt after the failure.");
      const compacted = await worker.waitForMetric(
        kit,
        (event) => event.event === "builtin_compact",
      );
      if (!compacted) throw new Error("S5: the builtin did not compact");
      const requested = await kit.waitFor(
        () => kit.requests.filter((request) => request.kind === "summary").length >= 2 &&
          kit.requests.filter((request) => request.kind === "chat").length >= 2,
      );
      if (!requested) throw new Error("S5: the next prompt did not run after the builtin compaction");
      const summaryIndex = kit.requests.findIndex((request, index) => index > 1 && request.kind === "summary");
      const chatIndex = kit.requests.findIndex((request, index) => index > summaryIndex && request.kind === "chat");
      const applies = worker.events(kit, "apply").length;
      const calls = worker.realCalls(kit);
      if (chatIndex < 0) throw new Error("S5: no chat request after the builtin summary");
      if (applies !== 0) throw new Error(`S5: mod applied ${applies} times`);
      if (calls.executeCompaction < 1) {
        throw new Error("S5: the real AgentSession._executeCompaction never ran");
      }
      worker.artifacts.s5 = {
        failed: true,
        builtinCompacted: true,
        chatIndex,
        summaryIndex,
        applies,
        executeCompactionCalls: calls.executeCompaction,
      };
      return `generation failed; builtin compacted before the next prompt; mod applies=0; realExecuteCompaction=${calls.executeCompaction}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S6-arm-B", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        ui: true,
        chat: [
          { text: big(12000), usage: usage(56_000) },
          { text: "second answer", usage: usage(56_010) },
        ],
        compaction: { speculativeEnabled: true, idleCompactionEnabled: true },
      });
      await kit.prompt(`Mod first prompt. ${big(3000)}`);
      await kit.prompt("Mod second prompt.");
      const flags = kit.getCompactionSettings();
      const log = await kit.readCompactionLog();
      const count = log.filter((event) => event.event === "speculative_started").length;
      const calls = worker.realCalls(kit);
      if (flags?.speculativeEnabled !== false || flags?.idleCompactionEnabled !== false) {
        throw new Error(`S6: active flags ${JSON.stringify(flags)}`);
      }
      if (calls.getCompactionSettings < 1) {
        throw new Error("S6: the real AgentSession._getCompactionSettings was never read");
      }
      if (count !== 0) throw new Error(`S6: arm B had ${count} speculative_started events`);
      worker.artifacts.s6b = {
        speculativeStarted: count,
        flags,
        getCompactionSettingsCalls: calls.getCompactionSettings,
      };
      return `active flags false; builtin speculative_started=0; realSettingsReads=${calls.getCompactionSettings}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S8-produce", async () => {
    const sessionDir = path.join(worker.cfg.armDir, "sessions-b");
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        sessionDir,
        chat: [
          { text: "seed answer", usage: usage(1_000) },
          { text: big(7000), usage: usage(50_000) },
        ],
      });
      const result = await worker.runS1(kit);
      const file = kit.sessionFile();
      if (!file || !fs.existsSync(file)) throw new Error("S8: session file was not persisted");
      const bytes = fs.readFileSync(file, "utf8");
      if (!bytes.includes("BASE SUMMARY") || !notesHeaderCount(result.summary)) {
        throw new Error("S8: persisted file lacks the notes compaction");
      }
      worker.artifacts.s8 = { sessionFile: file };
      return `session file persisted with the notes entry`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S13", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        chat: [
          { text: big(6000), usage: usage(68_500) },
          { text: "prompt ran", usage: usage(70_500) },
        ],
      });
      await kit.prompt(`Input first prompt. ${big(12000)}`);
      await worker.makeReady(kit, "S13");
      const promptText = `Threshold handoff prompt. ${big(2000)}`;
      await kit.prompt(promptText);
      const applied = await worker.waitForMetric(
        kit,
        (event) => event.event === "apply" && event.result === "ok" && event.route === "threshold",
      );
      if (!applied) throw new Error("S13: input seam did not apply the threshold route");
      const apply = worker.events(kit, "apply").find((event) => event.result === "ok");
      const ran = kit.requests.some((request) => request.kind === "chat" && request.messages.some((message) => message.text.includes("Threshold handoff prompt")));
      const calls = worker.realCalls(kit);
      if (apply.site !== "input") throw new Error(`S13: site ${apply.site}`);
      if (calls.applyCompaction < 1) {
        throw new Error("S13: the real AgentSession.applyCompaction was never called");
      }
      if (!ran) throw new Error("S13: the prompt did not run");
      worker.artifacts.s13 = { apply, promptRan: ran, applyCompactionCalls: calls.applyCompaction };
      return `threshold apply at input; prompt ran; realApplyCompaction=${calls.applyCompaction}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S14", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        deferSummaryCalls: [0],
        chat: [
          { text: big(6000), usage: usage(75_000) },
          { text: "after builtin", usage: usage(30_000) },
        ],
      });
      await kit.prompt(`Generating first prompt. ${big(12000)}`);
      const generating = await worker.waitForMetric(kit, (event) => event.event === "job_start");
      if (!generating) throw new Error("S14: job did not start");
      await kit.prompt("Builtin blocking compaction prompt.");
      const compacted = await worker.waitForMetric(kit, (event) => event.event === "builtin_compact");
      if (!compacted) throw new Error("S14: builtin compaction did not run");
      const aborted = worker.events(kit, "job_end").find((event) => event.outcome === "aborted");
      const appliesBeforeRelease = worker.events(kit, "apply").length;
      const generationAfterCompaction = worker.generation(kit);
      const executeCompactionCalls = worker.realCalls(kit).executeCompaction;
      kit.releaseSummary();
      await kit.waitFor(() => false, 60);
      const compactions = kit.getEntries().filter((entry) => entry.type === "compaction").length;
      const appliesAfterRelease = worker.events(kit, "apply").length;
      const callsAfterRelease = worker.realCalls(kit);
      if (!aborted) throw new Error("S14: GENERATING job was not aborted");
      if (generationAfterCompaction.summaryAborts < 1) {
        throw new Error("S14: the real deferred summary abort signal never fired");
      }
      if (executeCompactionCalls < 1) {
        throw new Error("S14: the real AgentSession._executeCompaction never ran");
      }
      if (callsAfterRelease.applyCompaction < 1) {
        throw new Error("S14: the builtin's real AgentSession.applyCompaction was never called");
      }
      if (appliesBeforeRelease !== 0 || appliesAfterRelease !== 0) {
        throw new Error(`S14: mod applies ${appliesBeforeRelease}/${appliesAfterRelease}`);
      }
      if (compactions !== 1) throw new Error(`S14: compactions=${compactions}`);
      worker.artifacts.s14 = {
        aborted,
        applies: appliesAfterRelease,
        compactions,
        summaryAborts: generationAfterCompaction.summaryAborts,
        executeCompactionCalls,
        builtinApplyCompactionCalls: callsAfterRelease.applyCompaction,
      };
      return `job aborted by the builtin compaction; compactions=1 modApplies=0; realAbortSignals=${generationAfterCompaction.summaryAborts}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S15", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        deferSummaryCalls: [0],
        ui: true,
        chat: [{ text: big(6000), usage: usage(50_000) }],
      });
      await kit.prompt(`Reload first prompt. ${big(12000)}`);
      const generating = await worker.waitForMetric(kit, (event) => event.event === "job_start");
      if (!generating) throw new Error("S15: job did not start");

      const beforeReload = worker.realCalls(kit);
      await kit.reload();
      const afterReload = worker.realCalls(kit);
      const reloadCalls = afterReload.reload - beforeReload.reload;
      if (reloadCalls < 1) {
        throw new Error("S15: the real AgentSession.reload was never called");
      }

      const discard = worker
        .events(kit, "discard")
        .find((event) => event.reason === "session-shutdown");
      const aborted = worker
        .events(kit, "job_end")
        .find((event) => event.outcome === "aborted" && event.reason === "aborted");
      if (!discard) throw new Error("S15: the old generation was not discarded on reload");
      if (!aborted) throw new Error("S15: the old generation's job was not recorded aborted");

      const generationAtReload = worker.generation(kit);
      if (generationAtReload.summaryAborts < 1) {
        throw new Error("S15: the real deferred summary abort signal never fired");
      }

      kit.releaseSummary();
      await kit.waitFor(() => false, 80);
      const afterRelease = worker.realCalls(kit);
      if (afterRelease.applyCompaction !== 0) {
        throw new Error(`S15: ${afterRelease.applyCompaction} real applyCompaction calls followed the reload`);
      }
      if (kit.compactionEvents.some((event) => event.accepted)) {
        throw new Error("S15: an accepted compaction followed the reload");
      }

      const activeGates = worker.events(kit, "gate").filter((event) => event.state === "active");
      if (activeGates.length < 2) {
        throw new Error(
          `S15: the reloaded generation did not re-gate active (gates=${JSON.stringify(
            worker.events(kit, "gate"),
          )} metrics=${JSON.stringify(worker.metrics(kit).map((event) => event.event + ":" + (event.state ?? event.outcome ?? event.reason ?? event.result ?? "")))} flags=${JSON.stringify(
            kit.getCompactionSettings(),
          )} loaded=${JSON.stringify(kit.loadedExtensions)} ctxAgentDir=${String(kit.ctx?.agentDir)})`,
        );
      }
      const flags = kit.getCompactionSettings();
      if (flags?.speculativeEnabled !== false || flags?.idleCompactionEnabled !== false) {
        throw new Error(`S15: reloaded generation flags ${JSON.stringify(flags)}`);
      }
      if (worker.uncaught.length > 0) throw new Error(`S15: ${worker.uncaught.join("\n")}`);
      worker.artifacts.s15 = {
        uncaught: worker.uncaught.length,
        reloadedActive: true,
        reloadCalls,
        summaryAborts: generationAtReload.summaryAborts,
        discard: discard.reason,
        aborted: aborted.outcome,
        activeGates: activeGates.length,
        flags,
        applyCompactionCalls: afterRelease.applyCompaction,
      };
      return `real reload=${reloadCalls} during GENERATING; old generation aborted (summaryAborts=${generationAtReload.summaryAborts}, discard=${discard.reason}); no apply; reloaded generation active`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S16", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        deferSummaryCalls: [0, 1],
        chat: [
          { text: "seed answer", usage: usage(1_000) },
          { text: big(7000), usage: usage(50_000) },
          { text: big(30_000), usage: usage(75_000) },
          { text: "after builtin", usage: usage(40_000) },
        ],
      });
      const result = await worker.runS1(kit);
      const notesEntry = kit.compactionEvents.find((event) => event.accepted && event.fromExtension);
      const inherited = (notesEntry?.details as any)?.taskIntent;
      if (inherited !== TASK_INTENT_MARKER) {
        throw new Error(`S16: notes taskIntent=${String(inherited)}`);
      }
      await kit.prompt(`Post-notes growth prompt. ${big(40_000)}`);
      await kit.prompt("Builtin safety prompt.");
      const compacted = await worker.waitForMetric(
        kit,
        (event) => event.event === "builtin_compact",
      );
      if (!compacted) throw new Error("S16: the builtin did not compact the notes summary");
      const summaryRequest = kit.requests.find(
        (request) => request.kind === "summary" && request.messages.some((message) => message.text.includes(TASK_INTENT_MARKER)),
      );
      if (!summaryRequest) throw new Error("S16: the builtin summary request did not inherit the task intent");
      const builtinEvent = kit.compactionEvents.find(
        (event) => event.accepted && (event.details as any)?.structuralYield !== undefined,
      );
      if (!builtinEvent) {
        throw new Error(
          `S16: no builtin compaction event; events=${JSON.stringify(kit.compactionEvents)} metrics=${JSON.stringify(
            worker.metrics(kit).map((event) => `${event.event}:${event.reason ?? ""}:${event.result ?? ""}`),
          )}`,
        );
      }
      worker.artifacts.s16 = {
        notesKind: result.kind,
        inherited,
        builtinReason: builtinEvent.reason,
        markerInBuiltinPrompt: true,
        applyCompactionCalls: result.applyCompactionCalls,
        executeCompactionCalls: worker.realCalls(kit).executeCompaction,
      };
      if (worker.realCalls(kit).executeCompaction < 1) {
        throw new Error("S16: the real AgentSession._executeCompaction never ran");
      }
      return `builtin compacted the notes summary; taskIntent inherited into the prompt; realExecuteCompaction=${worker.realCalls(kit).executeCompaction}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S17", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        api: "anthropic-messages",
        chat: [{ text: big(6000), usage: usage(50_000) }],
      });
      await kit.prompt(`Todo restore first prompt. ${big(12000)}`);
      await worker.makeReady(kit, "S17");
      kit.session.sessionManager.appendCustomEntry("compaction.todo-snapshot", {
        schema: "senpi.compaction.todo-snapshot.v1",
        todos: [{ id: "t1", content: "restore me", status: "pending" }],
      });
      const beforeTimer = worker.realCalls(kit);
      worker.clock.advance(331_000);
      worker.clock.fireIntervals();
      await kit.waitFor(() => false, 60);
      const calls = worker.realCalls(kit);
      const applies = worker.events(kit, "apply").length;
      const discards = worker.events(kit, "discard").length;
      if (applies !== 0 || discards !== 0) {
        throw new Error(`S17: applies=${applies} discards=${discards}`);
      }
      if (calls.applyCompaction !== 0) {
        throw new Error(`S17: ${calls.applyCompaction} real applyCompaction calls`);
      }
      if (calls.getBranch - beforeTimer.getBranch < 1) {
        throw new Error("S17: the idle timer did not consult the real SessionManager.getBranch");
      }
      worker.artifacts.s17 = {
        applies,
        discards,
        todoRestoreSkipped: true,
        getBranchReadsDuringTimer: calls.getBranch - beforeTimer.getBranch,
      };
      return `cold idle timer skipped the apply in the todo-restore state; realGetBranch reads=${calls.getBranch - beforeTimer.getBranch}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S18", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        window: 262_144,
        api: "anthropic-messages",
        chat: [
          { text: big(7000), usage: usage(173_000) },
          { text: "threshold run", usage: usage(183_600) },
        ],
      });
      await kit.prompt(`Fresh 262k first prompt. ${big(25000)}`);
      await worker.makeReady(kit, "S18");
      const before066 = worker.realCalls(kit);
      worker.clock.advance(10_000);
      worker.clock.fireIntervals();
      await kit.waitFor(() => false, 40);
      const after066 = worker.realCalls(kit);
      const appliesAt066 = worker.events(kit, "apply").length;
      const applyCallsAt066 = after066.applyCompaction - before066.applyCompaction;
      await kit.prompt("Threshold prompt at 0.70W.");
      const applied = await worker.waitForMetric(
        kit,
        (event) => event.event === "apply" && event.result === "ok" && event.route === "threshold",
      );
      if (!applied) throw new Error("S18: no threshold apply at 0.70W");
      const apply = worker.events(kit, "apply").find((event) => event.result === "ok");
      const applyCalls = worker.realCalls(kit).applyCompaction;
      if (appliesAt066 !== 0 || applyCallsAt066 !== 0) {
        throw new Error(`S18: ${appliesAt066} applies/${applyCallsAt066} real calls at 0.66W`);
      }
      if (applyCalls < 1) throw new Error("S18: the real AgentSession.applyCompaction was never called");
      if (apply.site !== "agent_settled") throw new Error(`S18: site ${apply.site}`);
      worker.artifacts.s18 = { appliesAt066, applyCallsAt066, apply, applyCompactionCalls: applyCalls };
      return `no apply at 0.66W; threshold apply at 0.70W; realApplyCompaction=${applyCalls}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S19", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        window: 64_000,
        api: "anthropic-messages",
        chat: [
          { text: big(5000), usage: usage(34_560) },
          { text: "threshold run", usage: usage(35_200) },
        ],
      });
      await kit.prompt(`64k first prompt. ${big(12000)}`);
      await worker.makeReady(kit, "S19");
      await kit.prompt("Threshold prompt at 0.55W.");
      const applied = await worker.waitForMetric(
        kit,
        (event) => event.event === "apply" && event.result === "ok" && event.route === "threshold",
      );
      if (!applied) throw new Error("S19: no threshold apply at 0.55W");
      const reference = computeEffectiveThreshold(64_000);
      const crossing = worker.events(kit, "threshold_cross").find((event) => event.U === 35_200);
      if (reference !== 0.55) throw new Error(`S19: reference threshold ${reference}`);
      if (crossing && crossing.T !== 35_200) throw new Error(`S19: mod T=${crossing.T}`);
      const calls = worker.realCalls(kit);
      if (calls.applyCompaction < 1) {
        throw new Error("S19: the real AgentSession.applyCompaction was never called");
      }
      worker.artifacts.s19 = {
        apply: worker.events(kit, "apply")[0],
        reference,
        crossing,
        applyCompactionCalls: calls.applyCompaction,
      };
      return `threshold apply at 0.55W; stock T=35200; realApplyCompaction=${calls.applyCompaction}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario("S20", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        window: 262_144,
        api: "anthropic-messages",
        policy: { startRatio: 2 },
        chat: [
          { text: big(40_000), usage: usage(40_000) },
          { text: big(40_000), usage: usage(184_000) },
          { text: "after builtin", usage: usage(173_006) },
        ],
      });
      await kit.prompt(`High yield first prompt. ${big(40_000)}`);
      await kit.prompt(`High yield second prompt. ${big(40_000)}`);
      await kit.prompt("Builtin threshold prompt.");
      const compacted = await worker.waitForMetric(
        kit,
        (event) => event.event === "builtin_compact",
      );
      if (!compacted) throw new Error("S20: builtin threshold compaction did not run");
      const entry = kit.getEntries().find((candidate) => candidate.type === "compaction");
      const sy = (entry?.details as any)?.structuralYield;
      if (!sy || typeof sy.savedTokens !== "number" || typeof sy.savingsRatio !== "number") {
        throw new Error("S20: the builtin compaction carried no structuralYield");
      }
      if (sy.savingsRatio <= 0.5) throw new Error(`S20: savingsRatio=${sy.savingsRatio}`);
      const expected = Math.round(262_144 * computeEffectiveThreshold(262_144, {
        savedTokens: sy.savedTokens,
        tokensBefore: entry.tokensBefore,
      }));
      const crossing = await kit.waitFor(
        () => worker.events(kit, "threshold_cross").some((event) => event.U === 173_016),
      );
      if (!crossing) throw new Error("S20: no threshold_cross after the high-yield compaction");
      const observed = worker.events(kit, "threshold_cross").find((event) => event.U === 173_016);
      if (observed.T !== expected) throw new Error(`S20: mod T=${observed.T} expected=${expected}`);
      const calls = worker.realCalls(kit);
      if (calls.executeCompaction < 1) {
        throw new Error("S20: the real AgentSession._executeCompaction never ran");
      }
      worker.artifacts.s20 = {
        structuralYield: sy,
        expected,
        observed,
        executeCompactionCalls: calls.executeCompaction,
      };
      return `high-yield builtin yield lowered the mod T to ${observed.T} (stock ${expected}); realExecuteCompaction=${calls.executeCompaction}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

async function armC(worker: Worker, order: OrderEntry[]): Promise<void> {
  await worker.scenario(`C-${order.join("-")}`, async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        order,
        copyOmo: true,
        chat: [
          { text: big(6000), usage: usage(50_000) },
        ],
      });
      await kit.prompt(`OMO order ${order.join(">")} prompt. ${big(12000)}`);
      await worker.makeReady(kit, "C");
      await worker.settle(kit);
      const applied = await worker.waitForMetric(
        kit,
        (event) => event.event === "apply" && event.result === "ok",
      );
      if (!applied) throw new Error("C: no apply with OMO loaded");
      const flags = kit.getCompactionSettings();
      if (flags?.speculativeEnabled !== false) throw new Error(`C: flags ${JSON.stringify(flags)}`);
      const receipt = process.env.OMO_COMPACTION_MODEL_RECEIPT;
      let installed = false;
      if (receipt && fs.existsSync(receipt)) {
        installed = fs.readFileSync(receipt, "utf8").split(/\r?\n/).some((line) => {
          try {
            return JSON.parse(line).patch === "installed";
          } catch {
            return false;
          }
        });
      }
      if (!installed) throw new Error("C: OMO receipt has no installed patch");
      const calls = worker.realCalls(kit);
      if (calls.applyCompaction < 1) {
        throw new Error("C: the real AgentSession.applyCompaction was never called");
      }
      if (calls.getCompactionSettings < 1) {
        throw new Error("C: the real AgentSession._getCompactionSettings was never read");
      }
      worker.artifacts.c = {
        order,
        flags,
        omoInstalled: installed,
        applyCompactionCalls: calls.applyCompaction,
        getCompactionSettingsCalls: calls.getCompactionSettings,
      };
      return `OMO order ${order.join(">")}: mod active and apply ok; realApplyCompaction=${calls.applyCompaction}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

async function armD(worker: Worker): Promise<void> {
  await worker.scenario("D-env", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        ui: true,
        chat: [
          { text: big(12000), usage: usage(56_000) },
          { text: "second answer", usage: usage(56_010) },
        ],
        compaction: { speculativeEnabled: true, idleCompactionEnabled: true },
      });
      await kit.prompt(`Env dormant prompt. ${big(3000)}`);
      await kit.prompt("Env dormant second prompt.");
      const gate = worker.events(kit, "gate").at(-1);
      const flags = kit.getCompactionSettings();
      const log = await kit.readCompactionLog();
      const speculative = log.filter((event) => event.event === "speculative_started").length;
      const warnings = kit.ui.notices.filter(
        (notice) => notice.type === "warning" && notice.message.includes("early-compaction"),
      ).length;
      if (gate?.state !== "dormant" || gate?.reason !== "env") throw new Error(`D: gate ${JSON.stringify(gate)}`);
      if (warnings !== 0) throw new Error(`D: warnings=${warnings}`);
      if (flags?.speculativeEnabled !== true) throw new Error(`D: flags ${JSON.stringify(flags)}`);
      if (speculative < 1) throw new Error("D: stock speculative did not start");
      const calls = worker.realCalls(kit);
      if (calls.getCompactionSettings < 1) {
        throw new Error("D: the real AgentSession._getCompactionSettings was never read");
      }
      worker.artifacts.d = { gate, warnings, speculative, getCompactionSettingsCalls: calls.getCompactionSettings };
      return `dormant(env), warnings=0, stock speculative_started=${speculative}; realSettingsReads=${calls.getCompactionSettings}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

async function armE(worker: Worker): Promise<void> {
  const cases: Array<{ id: string; mode: "tui" | "print" | "rpc"; sessionKind: "interactive" | "worker" }> = [
    { id: "E-worker", mode: "tui", sessionKind: "worker" },
    { id: "E-print", mode: "print", sessionKind: "interactive" },
    { id: "E-rpc", mode: "rpc", sessionKind: "interactive" },
  ];
  for (const entry of cases) {
    await worker.scenario(entry.id, async () => {
      let kit: SessionKit | undefined;
      try {
        kit = await worker.open({
          mode: entry.mode,
          sessionKind: entry.sessionKind,
          ui: true,
          compaction: { speculativeEnabled: true, idleCompactionEnabled: true },
          chat: [{ text: "mode answer", usage: usage(10_000) }],
        });
        await kit.prompt(`${entry.id} prompt.`);
        const gate = worker.events(kit, "gate").at(-1);
        const flags = kit.getCompactionSettings();
        const warnings = kit.ui.notices.filter(
          (notice) => notice.type === "warning" && notice.message.includes("early-compaction"),
        ).length;
        const statuses = kit.ui.statuses.filter((status) => status.key === "early-compaction").length;
        if (gate?.state !== "dormant" || gate?.reason !== "mode") throw new Error(`${entry.id}: gate ${JSON.stringify(gate)}`);
        if (warnings !== 0 || statuses !== 0) throw new Error(`${entry.id}: UI output appeared`);
        if (flags?.speculativeEnabled !== true) throw new Error(`${entry.id}: flags ${JSON.stringify(flags)}`);
        const calls = worker.realCalls(kit);
        if (calls.getCompactionSettings < 1) {
          throw new Error(`${entry.id}: the real AgentSession._getCompactionSettings was never read`);
        }
        worker.artifacts[entry.id] = { gate, warnings, flags, getCompactionSettingsCalls: calls.getCompactionSettings };
        return `${entry.id}: dormant(mode), warnings=0; realSettingsReads=${calls.getCompactionSettings}`;
      } finally {
        if (kit) await worker.dispose(kit);
      }
    });
  }
}

async function armF(worker: Worker, variant: "version" | "fingerprint"): Promise<void> {
  await worker.scenario("F-" + variant, async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        ui: true,
        qualified: worker.cfg.qualified,
        chat: [{ text: "gate answer", usage: usage(10_000) }],
      });
      await kit.prompt(`F ${variant} prompt.`);
      const gate = worker.events(kit, "gate").at(-1);
      const warnings = kit.ui.notices.filter(
        (notice) => notice.type === "warning" && notice.message.includes("early-compaction"),
      ).length;
      const footer = kit.ui.statuses.filter((status) => status.key === "early-compaction").at(-1)?.text;
      if (gate?.state !== "dormant" || gate?.reason !== "unqualified") throw new Error(`F: gate ${JSON.stringify(gate)}`);
      if (warnings !== 1) throw new Error(`F: warnings=${warnings}`);
      if (footer !== "EC 꺼짐(unqualified)") {
        throw new Error(
          `F: footer=${String(footer)} hasUI=${String(kit.ctx?.hasUI)} mode=${String(kit.ctx?.mode)} statuses=${JSON.stringify(
            kit.ui.statuses,
          )} notices=${JSON.stringify(kit.ui.notices)} metrics=${JSON.stringify(worker.metrics(kit))}`,
        );
      }
      const calls = worker.realCalls(kit);
      if (calls.getCompactionSettings < 1) {
        throw new Error("F: the real AgentSession._getCompactionSettings was never read");
      }
      worker.artifacts.f = {
        variant,
        gate,
        warnings,
        footer,
        getCompactionSettingsCalls: calls.getCompactionSettings,
      };
      return `dormant(unqualified), warnings=1, footer=${footer}; realSettingsReads=${calls.getCompactionSettings}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

async function armH(worker: Worker, order: OrderEntry[]): Promise<void> {
  await worker.scenario(`H-${order.join("-")}-S1`, async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        order,
        chat: [
          { text: "seed answer", usage: usage(1_000) },
          { text: big(7000), usage: usage(50_000) },
        ],
      });
      const result = await worker.runS1(kit);
      if (result.apply.result !== "ok" || result.kind !== "notes") {
        throw new Error(`H S1: apply=${JSON.stringify(result.apply)} kind=${String(result.kind)}`);
      }
      if (result.headerCount !== 1 || !result.sections) throw new Error("H S1: notes shape failed");
      worker.artifacts.hS1 = { order, apply: result.apply, kind: result.kind };
      return `CM order ${order.join(">")}: S1 still passes`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario(`H-${order.join("-")}-queued`, async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        order,
        chat: [
          { text: big(6000), usage: usage(50_000) },
          { text: big(12000), usage: usage(55_000), defer: true },
          { text: "follow-up answer", usage: usage(56_000) },
        ],
      });
      await kit.prompt(`Queued first prompt. ${big(12000)}`);
      await worker.makeReady(kit, "H queued");
      const streaming = kit.prompt("Streaming turn before the queued message.");
      await kit.waitForChatStart();
      const queuedText = `${QUEUED_MARKER} keep this text unchanged.`;
      const beforeQueue = worker.realCalls(kit);
      await kit.session.followUp(queuedText);
      const pending = await kit.waitFor(() => kit.hasPendingMessages() === true, 200);
      if (!pending) throw new Error("H queued: hasPendingMessages never became true");
      worker.clock.fireIntervals();
      await kit.waitFor(() => false, 30);
      const whileQueued = worker.realCalls(kit);
      const appliesWhileQueued = worker.events(kit, "apply").length;
      const applyCallsWhileQueued = whileQueued.applyCompaction - beforeQueue.applyCompaction;
      const pendingPositiveReads =
        whileQueued.pendingMessagesPositiveReads - beforeQueue.pendingMessagesPositiveReads;
      kit.releaseChat();
      await streaming;
      const delivered = await kit.waitFor(
        () => kit.requests.some((request) => request.kind === "chat" && request.messages.some((message) => message.text === queuedText)),
        400,
      );
      if (!delivered) throw new Error("H queued: the queued message was not delivered unchanged");
      const appliedAfter = await worker.waitForMetric(
        kit,
        (event) => event.event === "apply" && event.result === "ok",
      );
      if (appliesWhileQueued !== 0 || applyCallsWhileQueued !== 0) {
        throw new Error(
          `H queued: ${appliesWhileQueued} applies/${applyCallsWhileQueued} real calls while queued`,
        );
      }
      if (pendingPositiveReads < 1) {
        throw new Error("H queued: the real pending-message state was never observed");
      }
      if (!appliedAfter) throw new Error("H queued: no apply after the delivery");
      const afterApply = worker.realCalls(kit);
      if (afterApply.applyCompaction - beforeQueue.applyCompaction < 1) {
        throw new Error("H queued: the real AgentSession.applyCompaction was never called after delivery");
      }
      worker.artifacts.hQueued = {
        pending,
        appliesWhileQueued,
        applyCallsWhileQueued,
        pendingPositiveReads,
        delivered,
        appliedAfter: true,
        applyCompactionCalls: afterApply.applyCompaction - beforeQueue.applyCompaction,
      };
      return `pending blocked the apply; queued text delivered unchanged; apply followed; realPendingReads=${pendingPositiveReads}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });

  await worker.scenario(`H-${order.join("-")}-reload`, async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        order,
        ui: true,
        chat: [{ text: "reload answer", usage: usage(10_000) }],
      });
      await kit.prompt("Reload prompt before the in-process reload.");
      const before = kit.getCompactionSettings();
      if (before?.speculativeEnabled !== false) throw new Error("H reload: mod was not active before reload");
      const beforeReload = worker.realCalls(kit);
      await kit.reload();
      const reloadCalls = worker.realCalls(kit).reload - beforeReload.reload;
      if (reloadCalls < 1) throw new Error("H reload: the real AgentSession.reload was never called");
      const after = kit.getCompactionSettings();
      if (after?.speculativeEnabled !== false) throw new Error("H reload: mod did not re-gate active");
      const tools = kit.session.extensionRunner.getAllRegisteredTools();
      const inspect = tools.find((tool: any) => tool.definition?.name === "coordination_inspect");
      if (!inspect) throw new Error("H reload: coordination_inspect is missing");
      const result = await inspect.definition.execute(
        "qa-cm-inspect",
        {},
        undefined,
        undefined,
        { sessionManager: kit.session.sessionManager, agentDir: kit.tempAgentDir },
      );
      const text = contentOf(result);
      if (text.length === 0) throw new Error("H reload: coordination_inspect returned no content");
      if (worker.uncaught.length > 0) throw new Error(`H reload: ${worker.uncaught.join("\n")}`);
      worker.artifacts.hReload = { before, after, coordination: result.details ?? null, reloadCalls };
      return `realReload=${reloadCalls}; reload raised no uncaught exception; mod active; coordination_inspect answered`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

async function armReloadParked(worker: Worker): Promise<void> {
  await worker.scenario("S11", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        installMod: true,
        ui: true,
        compaction: { speculativeEnabled: true, idleCompactionEnabled: true },
        chat: [
          { text: big(4000), usage: usage(20_000) },
          { text: big(4000), usage: usage(56_000) },
          { text: "speculation trigger", usage: usage(56_010) },
        ],
      });
      await kit.prompt(`Before reload prompt. ${big(4000)}`);
      const before = kit.getCompactionSettings();
      if (before?.speculativeEnabled !== false) throw new Error("S11: mod was not active before reload");
      const parked = spawnSync(
        process.execPath,
        [path.join(REPO, "scripts/mod.mjs"), "off", "--agent-dir", kit.tempAgentDir],
        { cwd: REPO, encoding: "utf8" },
      );
      if (parked.status !== 0) throw new Error(`S11: mod off failed: ${parked.stderr ?? ""}`);
      kit.setExtensionPaths(
        kit.loadedExtensions.filter((file) => !path.basename(file).startsWith("early-compaction")),
      );
      const beforeReloadCalls = worker.realCalls(kit);
      await kit.reload();
      const reloadCalls = worker.realCalls(kit).reload - beforeReloadCalls.reload;
      if (reloadCalls < 1) {
        throw new Error("S11: the real AgentSession.reload was never called");
      }
      const after = kit.getCompactionSettings();
      if (after?.speculativeEnabled !== true) throw new Error(`S11: flags after reload ${JSON.stringify(after)}`);
      await kit.prompt(`After reload prompt. ${big(4000)}`);
      await kit.prompt("Speculation trigger prompt.");
      const log = await kit.readCompactionLog();
      const count = log.filter((event) => event.event === "speculative_started").length;
      if (count < 1) {
        throw new Error(
          `S11: builtin speculation did not return log=${JSON.stringify(log)} requests=${JSON.stringify(
            kit.requests.map((request) => request.kind),
          )} branch=${kit.getBranch().length} usage=${JSON.stringify(kit.getContextUsage())} extensions=${JSON.stringify(
            kit.session.extensionRunner?.getExtensionPaths?.(),
          )}`,
        );
      }
      if (worker.uncaught.length > 0) throw new Error(`S11: ${worker.uncaught.join("\n")}`);
      worker.artifacts.s11 = { before, after, speculativeStarted: count, reloadCalls };
      return `reload with the mod parked restored stock flags; realReload=${reloadCalls}; speculative_started=${count}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

async function armTwoSessions(worker: Worker): Promise<void> {
  await worker.scenario("S12", async () => {
    let active: SessionKit | undefined;
    let inactive: SessionKit | undefined;
    try {
      active = await worker.open({
        mode: "tui",
        compaction: { speculativeEnabled: true, idleCompactionEnabled: true },
        chat: [{ text: "active answer", usage: usage(10_000) }],
      });
      await active.prompt("Active session prompt.");
      inactive = await worker.open({
        mode: "print",
        ui: true,
        compaction: { speculativeEnabled: true, idleCompactionEnabled: true },
        chat: [{ text: "inactive answer", usage: usage(10_000) }],
      });
      await inactive.prompt("Inactive session prompt.");
      const activeFlags = active.getCompactionSettings();
      const inactiveFlags = inactive.getCompactionSettings();
      const activeCalls = worker.realCalls(active);
      const inactiveCalls = worker.realCalls(inactive);
      const gate = worker.events(inactive, "gate").at(-1);
      if (activeCalls.getCompactionSettings < 1 || inactiveCalls.getCompactionSettings < 1) {
        throw new Error(
          `S12: real settings reads active=${activeCalls.getCompactionSettings} inactive=${inactiveCalls.getCompactionSettings}`,
        );
      }
      if (activeFlags?.speculativeEnabled !== false) throw new Error("S12: active session is not suppressed");
      if (inactiveFlags?.speculativeEnabled !== true) {
        throw new Error(
          `S12: inactive flags ${JSON.stringify(inactiveFlags)} mode=${String(inactive.ctx?.mode)} sessionKind=${String(inactive.ctx?.sessionKind)} gate=${JSON.stringify(
            worker.metrics(inactive),
          )}`,
        );
      }
      if (gate?.state !== "dormant" || gate?.reason !== "mode") throw new Error(`S12: inactive gate ${JSON.stringify(gate)}`);
      if (
        inactive.ui.statuses.filter((status) => status.key === "early-compaction").length !== 0 ||
        inactive.ui.notices.filter((notice) => notice.message.includes("early-compaction")).length !== 0
      ) {
        throw new Error("S12: inactive session produced UI output");
      }
      worker.artifacts.s12 = {
        activeFlags,
        inactiveFlags,
        gate,
        activeSettingsReads: activeCalls.getCompactionSettings,
        inactiveSettingsReads: inactiveCalls.getCompactionSettings,
      };
      return `active flags false; inactive session stock flags true; no UI output; realSettingsReads=${activeCalls.getCompactionSettings}/${inactiveCalls.getCompactionSettings}`;
    } finally {
      if (active) await worker.dispose(active);
      if (inactive) await worker.dispose(inactive);
    }
  });
}

async function armSlots(worker: Worker): Promise<void> {
  await worker.scenario("S10", async () => {
    let kit: SessionKit | undefined;
    let server: any;
    const originalFetch = globalThis.fetch;
    const slots: Array<{ id: number; is_processing: boolean; n_prompt_tokens: number }> = [
      { id: 0, is_processing: true, n_prompt_tokens: 1000 },
    ];
    let requests = 0;
    let baselineParsed = false;
    try {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname !== "/slots") return new Response("not found", { status: 404 });
          return Response.json(slots);
        },
      });
      globalThis.fetch = (async (input: any, init?: any) => {
        const response = await originalFetch(input, init);
        if (String(input).endsWith("/slots")) {
          requests += 1;
          const originalJson = response.json.bind(response);
          response.json = async () => {
            const value = await originalJson();
            baselineParsed = true;
            return value;
          };
        }
        return response;
      }) as typeof globalThis.fetch;
      const baseUrl = `http://127.0.0.1:${server.port}`;
      kit = await worker.open({
        provider: "qa-local",
        localBaseUrl: baseUrl,
        chat: [{ text: big(6000), usage: usage(50_000) }],
      });
      await kit.prompt(`Slots first prompt. ${big(12000)}`);
      const parsed = await kit.waitFor(() => baselineParsed, 2000);
      if (!parsed) throw new Error("S10: no /slots baseline response was parsed");
      // Let the baseline promise chain run its apply decision while the job is
      // still GENERATING, so the only possible route is the idle-timer cold one.
      await kit.waitFor(() => false, 40);
      kit.releaseSummary();
      const ready = await worker.waitForMetric(
        kit,
        (event) => event.event === "job_end" && event.outcome === "ready",
      );
      if (!ready) throw new Error("S10: job never became READY");
      const appliesBefore = worker.events(kit, "apply").length;
      if (appliesBefore !== 0) throw new Error(`S10: ${appliesBefore} applies before the eviction probe`);
      slots[0] = { id: 0, is_processing: false, n_prompt_tokens: 2000 };
      worker.clock.advance(31_000);
      worker.clock.fireIntervals();
      const applied = await worker.waitForMetric(
        kit,
        (event) => event.event === "apply" && event.result === "ok",
      );
      if (!applied) throw new Error("S10: /slots eviction did not produce an apply");
      const apply = worker.events(kit, "apply").find((event) => event.result === "ok");
      if (apply.route !== "cold" || apply.site !== "timer") {
        throw new Error(`S10: route=${apply.route} site=${apply.site}`);
      }
      if (requests < 2) throw new Error(`S10: only ${requests} /slots requests`);
      const calls = worker.realCalls(kit);
      if (calls.applyCompaction < 1) {
        throw new Error("S10: the real AgentSession.applyCompaction was never called");
      }
      worker.artifacts.s10 = { requests, apply, applyCompactionCalls: calls.applyCompaction };
      return `fake /slots: ${requests} GETs, eviction -> cold timer apply; realApplyCompaction=${calls.applyCompaction}`;
    } finally {
      globalThis.fetch = originalFetch;
      if (kit) await worker.dispose(kit);
      server?.stop?.(true);
    }
  });
}

async function openStockSessionFile(worker: Worker, file: string): Promise<void> {
  await worker.scenario("S8-open", async () => {
    let kit: SessionKit | undefined;
    try {
      kit = await worker.open({
        installMod: false,
        sessionFile: file,
        chat: [{ text: "reopened", usage: usage(10_000) }],
      });
      const context = kit.session.sessionManager.buildSessionContext();
      const messages = Array.isArray(context?.messages) ? context.messages : [];
      if (messages.length === 0) throw new Error("S8-open: buildSessionContext returned no messages");
      const calls = worker.realCalls(kit);
      if (calls.buildSessionContext < 1) {
        throw new Error("S8-open: the real SessionManager.buildSessionContext was never called");
      }
      const text = JSON.stringify(context);
      if (!text.includes("BASE SUMMARY")) throw new Error("S8-open: the notes summary is missing");
      await kit.prompt("Continue the reopened stock session.");
      worker.artifacts.s8open = { messages: messages.length, sessionFile: file, buildSessionContextCalls: calls.buildSessionContext };
      return `stock session opened the mod session file; buildSessionContext messages=${messages.length}; realBuildSessionContext=${calls.buildSessionContext}`;
    } finally {
      if (kit) await worker.dispose(kit);
    }
  });
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const configPath = argument("--config");
  const outPath = argument("--out");
  if (!configPath || !outPath) {
    console.error("usage: bun qa/isolated-worker.ts --config <config.json> --out <result.json>");
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as WorkerConfig & {
    s8SessionFile?: string;
    order?: OrderEntry[];
    variant?: "version" | "fingerprint";
  };
  const worker = new Worker(cfg);
  try {
    switch (cfg.caseName) {
      case "BROKEN":
        await armBroken(worker);
        break;
      case "A":
        await armA(worker);
        break;
      case "B":
        await armB(worker);
        break;
      case "C":
        await armC(worker, cfg.order ?? ["omo", "mod"]);
        break;
      case "D":
        await armD(worker);
        break;
      case "E":
        await armE(worker);
        break;
      case "F":
        await armF(worker, cfg.variant ?? "version");
        break;
      case "G":
        await armG(worker);
        break;
      case "H":
        await armH(worker, cfg.order ?? ["cm", "mod"]);
        break;
      case "RELOAD-PARKED":
        await armReloadParked(worker);
        break;
      case "TWO-SESSIONS":
        await armTwoSessions(worker);
        break;
      case "SLOTS":
        await armSlots(worker);
        break;
      case "S8-OPEN":
        if (!cfg.s8SessionFile) throw new Error("S8-OPEN needs s8SessionFile");
        await openStockSessionFile(worker, cfg.s8SessionFile);
        break;
      default:
        throw new Error(`unknown worker case ${cfg.caseName}`);
    }
  } catch (error) {
    worker.record("worker", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  const result = await worker.finish();
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ case: cfg.caseName, pass: result.pass, scenarios: result.scenarios.length }));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
