/**
 * Continuity parity: builtin threshold route vs a mod-style precomputed apply.
 *
 * Each arm runs in its own subprocess because the mod (and OMO) patch
 * process-wide prototypes. The arms share one scripted conversation:
 *
 *   1. a first prompt whose todo marker must survive the summary,
 *   2. a provider response large enough to cross the builtin threshold,
 *   3. a second prompt whose provider request is the "next request" we compare.
 *
 * The builtin arm lets the stock compaction extension apply its own generated
 * result through ctx.applyCompaction during before_agent_start. The mod arm
 * applies the exact same CompactionResult directly through ctx.applyCompaction
 * at the same conversation state. A third core arm (/compact) shows the
 * restoration directive that only core-route compactions receive.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import type { ArmConfig, ArmResult, ProviderRequestRecord } from "./session-kit";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const KIT = path.join(HERE, "session-kit.ts");

const TODO_MARKER = "TODO-CONTINUITY-42";
const RESTORE_MARKER = "[restore checkpointed session agent configuration after compaction]";
const ENVIRONMENT_CONTEXT = /^<environment_context>[\s\S]*?<\/environment_context>/;

const FILLER_USER =
  "Archive note: the owner asked for a careful continuity fixture with no live writes and no network calls. ";
const FILLER_ASSISTANT =
  "The archived note records the earlier conversation state, the pending todo item, and the next action for continuity. ";
const PROMPT_1 = `${TODO_MARKER}: verify that the todo list survives compaction.\n\n${FILLER_USER.repeat(500)}`;
const PROMPT_2 = "Continue the parity fixture. Reply with the current state.";

const SUMMARY_RESPONSE = [
  "<task-intent>",
  "ORIGINAL_REQUEST: verify continuity parity",
  "TASK_TYPE: QA",
  "MUST_PRESERVE: TODO-CONTINUITY-42",
  "MUST_NOT_LOSE: the todo list text",
  "</task-intent>",
  "<summary>",
  "## 1. User Requests (Verbatim)",
  "- Verify continuity parity.",
  "## 6. Remaining Tasks",
  `- ${TODO_MARKER}: verify that the todo list survives compaction.`,
  "## 7. Exact Next Steps",
  "- Continue the parity fixture.",
  "</summary>",
].join("\n");

const COMMON: Omit<ArmConfig, "arm"> = {
  cwd: ROOT,
  prompt1: PROMPT_1,
  prompt2: PROMPT_2,
  chat: [
    {
      text: FILLER_ASSISTANT.repeat(1300),
      usage: { input: 64_000, output: 1_000, cacheRead: 0, cacheWrite: 0, totalTokens: 65_000 },
    },
    {
      text: "Continuity request received.",
      usage: { input: 30_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30_010 },
    },
  ],
  summaryResponse: SUMMARY_RESPONSE,
  contextWindow: 100_000,
  maxTokens: 8_192,
};

function runArm(directory: string, label: string, config: ArmConfig): ArmResult {
  const configPath = path.join(directory, `${label}-config.json`);
  const resultPath = path.join(directory, `${label}-result.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  const child = spawnSync(process.execPath, [KIT, "--config", configPath, "--out", resultPath], {
    cwd: ROOT,
    env: { ...process.env, PIOMO_EARLY_COMPACTION: "0" },
    timeout: 55_000,
    encoding: "utf8",
    windowsHide: true,
  });
  if (child.error) {
    throw new Error(`${label} arm spawn failed: ${child.error.message}\n${child.stderr ?? ""}`);
  }
  if (child.status !== 0) {
    throw new Error(
      `${label} arm failed with status ${child.status} (signal ${child.signal ?? "none"}):\n` +
        `stdout:\n${child.stdout ?? ""}\nstderr:\n${child.stderr ?? ""}`,
    );
  }
  return JSON.parse(fs.readFileSync(resultPath, "utf8")) as ArmResult;
}

function contentText(content: unknown): string {
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

function stripEnvironmentContext(text: string): string {
  return text.replace(ENVIRONMENT_CONTEXT, "");
}

function normalizedMessages(result: ArmResult): Array<{ role: string; text: string }> {
  if (!result.nextRequest) throw new Error(`${result.arm}: no next provider request captured`);
  return result.nextRequest.messages.map((message) => ({
    role: message.role,
    text: stripEnvironmentContext(message.text),
  }));
}

function normalizedEntries(result: ArmResult, includeEnvironmentContext: boolean) {
  return result.entries
    .filter(
      (entry) =>
        includeEnvironmentContext ||
        !(entry.type === "custom_message" && entry.customType === "environment-context"),
    )
    .map((entry) => {
      if (entry.type === "message") {
        return {
          type: "message",
          role: entry.message?.role,
          text: contentText(entry.message?.content),
        };
      }
      if (entry.type === "compaction") {
        return {
          type: "compaction",
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          firstKeptIndex: result.entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId),
          details: entry.details ?? null,
        };
      }
      if (entry.type === "custom" || entry.type === "custom_message") {
        return { type: entry.type, customType: entry.customType };
      }
      return { type: entry.type };
    });
}

function assertJsonEqual(label: string, actual: unknown, expected: unknown): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText === expectedText) return;
  let index = 0;
  while (index < actualText.length && index < expectedText.length && actualText[index] === expectedText[index]) {
    index += 1;
  }
  const from = Math.max(0, index - 200);
  throw new Error(
    `${label} differ at character ${index}\n` +
      `actual:   ${actualText.slice(from, index + 400)}\n` +
      `expected: ${expectedText.slice(from, index + 400)}`,
  );
}

function messagesText(request: ProviderRequestRecord | null): string {
  if (!request) return "";
  return request.messages.map((message) => message.text).join("\n");
}

function todoLine(result: ArmResult): string | undefined {
  return messagesText(result.nextRequest)
    .split("\n")
    .find((line) => line.includes(TODO_MARKER));
}

function hasRestorationDirective(result: ArmResult): boolean {
  return messagesText(result.nextRequest).includes(RESTORE_MARKER);
}

function continuityEntries(result: ArmResult): unknown[] {
  return result.entries.filter(
    (entry) =>
      entry.customType === "compaction.agent-checkpoint" ||
      entry.customType === "compaction.todo-snapshot",
  );
}

test(
  "builtin threshold route and mod-style precomputed apply keep identical continuity",
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piomo-continuity-test-"));
    const beforeAgentDirs = new Set(
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("piomo-continuity-agent-")),
    );
    try {
      const builtin = runArm(directory, "builtin", { ...COMMON, arm: "builtin" });
      expect(builtin.ok).toBe(true);
      expect(builtin.compactionEvents.length).toBe(1);
      expect(builtin.compactionEvents[0].accepted).toBe(true);
      expect(builtin.compactionEvents[0].reason).toBe("extension");
      expect(builtin.compactionEvents[0].fromExtension).toBe(true);
      // A precomputed apply skips the core session_before_compact hook.
      expect(builtin.beforeCompactEvents).toEqual([]);
      expect(builtin.extracted).not.toBeNull();
      const builtinResult = builtin.extracted!;
      expect(builtinResult.cutIndex).toBeGreaterThanOrEqual(0);
      expect(builtinResult.summary).toContain(TODO_MARKER);

      const mod = runArm(directory, "mod", {
        ...COMMON,
        arm: "mod",
        mod: {
          summary: builtinResult.summary,
          cutIndex: builtinResult.cutIndex,
          tokensBefore: builtinResult.tokensBefore,
          details: builtinResult.details,
        },
      });
      expect(mod.ok).toBe(true);
      expect(mod.apply?.stale?.result).toEqual({ applied: false, reason: "stale" });
      expect(mod.apply?.stale?.entriesDelta).toBe(0);
      expect(mod.apply?.result).toEqual({ applied: true, reason: "ok" });
      expect(mod.compactionEvents.length).toBe(1);
      expect(mod.compactionEvents[0].accepted).toBe(true);
      expect(mod.compactionEvents[0].reason).toBe("extension");
      expect(mod.beforeCompactEvents).toEqual([]);
      expect(mod.entries.filter((entry) => entry.type === "compaction").length).toBe(1);
      expect(mod.extracted).not.toBeNull();
      expect(mod.extracted!.cutIndex).toBe(builtinResult.cutIndex);
      expect(mod.extracted!.tokensBefore).toBe(builtinResult.tokensBefore);

      const core = runArm(directory, "core", { ...COMMON, arm: "core" });
      expect(core.ok).toBe(true);
      expect(core.beforeCompactEvents.length).toBe(1);
      expect(core.beforeCompactEvents[0].reason).toBe("manual");
      expect(core.compactionEvents.length).toBe(1);
      expect(core.compactionEvents[0].reason).toBe("manual");

      // Continuity payload: todo text, summary, kept messages, and entries.
      const builtinMessages = normalizedMessages(builtin);
      const modMessages = normalizedMessages(mod);
      assertJsonEqual("next-request messages", modMessages, builtinMessages);
      expect(builtin.nextRequest!.systemPrompt).toBe(mod.nextRequest!.systemPrompt);

      const builtinEntries = normalizedEntries(builtin, false);
      const modEntries = normalizedEntries(mod, false);
      assertJsonEqual("entries", modEntries, builtinEntries);
      // The only raw entry difference is the standard environment-context
      // custom message that the SDK re-injects when the apply precedes the
      // prompt; it carries no continuity data.
      const builtinEntriesRaw = normalizedEntries(builtin, true);
      const modEntriesRaw = normalizedEntries(mod, true);
      const rawEntriesEqual = JSON.stringify(modEntriesRaw) === JSON.stringify(builtinEntriesRaw);

      const builtinTodo = todoLine(builtin);
      const modTodo = todoLine(mod);
      expect(builtinTodo).toBe(`- ${TODO_MARKER}: verify that the todo list survives compaction.`);
      expect(modTodo).toBe(builtinTodo);
      expect(builtinTodo).toBeDefined();

      // Neither precomputed route gets the core-route restoration payload.
      expect(hasRestorationDirective(builtin)).toBe(false);
      expect(hasRestorationDirective(mod)).toBe(false);
      expect(continuityEntries(builtin)).toEqual([]);
      expect(continuityEntries(mod)).toEqual([]);

      // The core route proves the accepted difference is real and confined.
      expect(hasRestorationDirective(core)).toBe(true);
      expect(continuityEntries(core).length).toBe(2);
      expect(core.entries.some((entry) => entry.customType === "compaction.agent-checkpoint")).toBe(true);
      expect(core.entries.some((entry) => entry.customType === "compaction.todo-snapshot")).toBe(true);

      const rawMessagesEqual =
        JSON.stringify(builtin.nextRequest!.messages) === JSON.stringify(mod.nextRequest!.messages);
      console.log(
        JSON.stringify({
          parity: {
            next_request_messages_normalized: true,
            next_request_messages_raw: rawMessagesEqual,
            entries_normalized: true,
            entries_raw: rawEntriesEqual,
            todo_text_equal: modTodo === builtinTodo,
            restoration_equal: hasRestorationDirective(mod) === hasRestorationDirective(builtin),
          },
          accepted_differences: {
            core_route_restoration_directive: hasRestorationDirective(core),
            environment_context_reinjected_by_mod_timing: !rawMessagesEqual,
          },
          stale_apply: mod.apply?.stale,
          arms: [builtin, mod, core].map((result) => ({
            arm: result.arm,
            temp_dir_removed: result.cleanup.tempDirRemoved,
          })),
        }),
      );

      for (const result of [builtin, mod, core]) {
        expect(result.cleanup.tempDirRemoved).toBe(true);
        expect(fs.existsSync(result.cleanup.tempDir)).toBe(false);
      }
      const leaked = fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith("piomo-continuity-agent-") && !beforeAgentDirs.has(name));
      expect(leaked).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  },
  180_000,
);
