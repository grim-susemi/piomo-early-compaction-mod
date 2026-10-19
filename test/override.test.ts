import { expect, test } from "bun:test";
import { ExtensionRunner } from "@code-yeongyu/senpi";
import type { CompactionSettings, SessionManager } from "@code-yeongyu/senpi";
import {
  activate,
  deactivate,
  installOverride,
  type CompactionSettingsContext,
} from "../src/override";

type TestSettings = CompactionSettings & { model?: string; extra?: string };

/**
 * Mirrors the fields ExtensionRunner.bindCore touches: it replaces
 * getCompactionSettingsFn with the context action, and the runner keeps its
 * sessionManager for the per-session key.
 */
class FakeRunner {
  sessionManager: SessionManager;
  getCompactionSettingsFn: () => TestSettings;
  originalGetter: () => TestSettings;
  modelRegistry = {
    find: (_provider: string, _id: string): undefined => undefined,
  };
  getModel = (): undefined => undefined;
  getterSeenAtBindEntry?: () => TestSettings;
  bindCoreCalls = 0;

  constructor(sessionManager: SessionManager, settings: TestSettings) {
    this.sessionManager = sessionManager;
    this.originalGetter = () => settings;
    this.getCompactionSettingsFn = this.originalGetter;
  }

  bindCore(
    _actions: unknown,
    contextActions: { getCompactionSettings: () => TestSettings },
  ): void {
    this.bindCoreCalls += 1;
    this.getterSeenAtBindEntry = this.getCompactionSettingsFn;
    this.getCompactionSettingsFn = contextActions.getCompactionSettings;
  }
}

function baseSettings(model?: string): TestSettings {
  return {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    speculativeEnabled: true,
    idleCompactionEnabled: true,
    model,
  };
}

function contextFor(runner: FakeRunner): CompactionSettingsContext {
  return { getCompactionSettings: () => runner.getCompactionSettingsFn() };
}

function prototypeOf(): Record<string, unknown> {
  return FakeRunner.prototype as unknown as Record<string, unknown>;
}

// This test must not install anything: the shared `wrapped` flag stays false.
test("kill switch leaves the real prototype bindCore untouched", () => {
  const original = ExtensionRunner.prototype.bindCore;
  const result = installOverride({ env: { PIOMO_EARLY_COMPACTION: "0" } });
  expect(result).toEqual({ state: "skipped", reason: "env" });
  expect(ExtensionRunner.prototype.bindCore).toBe(original);
});

// First install in this process. Later tests reuse the same wrapped prototype,
// exactly as a /reload does in production.
test("installs after bindCore, chains OMO before us, and gates by session", () => {
  const proto = prototypeOf();
  const trueOriginal = proto.bindCore as (
    this: FakeRunner,
    ...args: unknown[]
  ) => unknown;
  const omoReads: TestSettings[] = [];

  // OMO-like extension loaded first: it captures the original bindCore and
  // reads the compaction model through getCompactionSettingsFn.
  proto.bindCore = function omoBefore(
    this: FakeRunner,
    ...args: unknown[]
  ): unknown {
    const bound = trueOriginal.apply(this, args);
    omoReads.push(this.getCompactionSettingsFn());
    return bound;
  };
  const omoBindCore = proto.bindCore;

  expect(installOverride({ prototype: proto, env: {} })).toEqual({
    state: "installed",
  });
  expect(proto.bindCore).not.toBe(omoBindCore);

  const sessionA = {} as SessionManager;
  const settingsA: TestSettings = {
    ...baseSettings("anthropic/claude-a"),
    extra: "keep",
  };
  const runnerA = new FakeRunner(sessionA, settingsA);
  const ctxA = contextFor(runnerA);
  runnerA.bindCore({}, { getCompactionSettings: () => settingsA });

  // The wrapped getter exists only after the original bindCore has run.
  expect(runnerA.getterSeenAtBindEntry).toBe(runnerA.originalGetter);
  expect(runnerA.getCompactionSettingsFn).not.toBe(runnerA.originalGetter);

  // OMO loaded before us still sees the model through the chain.
  expect(omoReads).toHaveLength(1);
  expect(omoReads[0]?.model).toBe(settingsA.model);

  // Never activated: exact base object, flags untouched.
  expect(ctxA.getCompactionSettings()).toBe(settingsA);

  expect(activate(sessionA, ctxA)).toEqual({ state: "active" });
  const activeSettings = ctxA.getCompactionSettings() as TestSettings;
  expect(activeSettings).not.toBe(settingsA);
  expect(activeSettings.speculativeEnabled).toBe(false);
  expect(activeSettings.idleCompactionEnabled).toBe(false);
  expect(activeSettings.model).toBe(settingsA.model);
  expect(activeSettings.enabled).toBe(true);
  expect(activeSettings.reserveTokens).toBe(16384);
  expect(activeSettings.keepRecentTokens).toBe(20000);
  expect(activeSettings.extra).toBe("keep");

  // A sibling session on the same prototype stays stock by identity.
  const sessionB = {} as SessionManager;
  const settingsB = baseSettings("openai/gpt-b");
  const runnerB = new FakeRunner(sessionB, settingsB);
  const ctxB = contextFor(runnerB);
  runnerB.bindCore({}, { getCompactionSettings: () => settingsB });
  expect(ctxB.getCompactionSettings()).toBe(settingsB);

  deactivate(sessionA);
  expect(ctxA.getCompactionSettings()).toBe(settingsA);
});

test("an OMO patch loaded after us keeps our wrapper and the model", () => {
  const proto = prototypeOf();
  const previous = proto.bindCore as (
    this: FakeRunner,
    ...args: unknown[]
  ) => unknown;
  const omoReads: TestSettings[] = [];

  proto.bindCore = function omoAfter(
    this: FakeRunner,
    ...args: unknown[]
  ): unknown {
    const bound = previous.apply(this, args);
    omoReads.push(this.getCompactionSettingsFn());
    return bound;
  };
  expect(proto.bindCore).not.toBe(previous);

  const sessionC = {} as SessionManager;
  const settingsC = baseSettings("anthropic/claude-c");
  const runnerC = new FakeRunner(sessionC, settingsC);
  const ctxC = contextFor(runnerC);
  runnerC.bindCore({}, { getCompactionSettings: () => settingsC });

  expect(omoReads).toHaveLength(1);
  expect(omoReads[0]?.model).toBe(settingsC.model);

  expect(activate(sessionC, ctxC)).toEqual({ state: "active" });
  // This is the read OMO's resolver performs after activation.
  const readByOmo = runnerC.getCompactionSettingsFn();
  expect(readByOmo.model).toBe(settingsC.model);
  expect(readByOmo.speculativeEnabled).toBe(false);
  expect(readByOmo.idleCompactionEnabled).toBe(false);
  deactivate(sessionC);
});

test("a fresh module generation reuses the global wrap and active set", async () => {
  const proto = prototypeOf();
  const current = proto.bindCore;

  // Query strings make Bun evaluate separate module instances, like /reload
  // does after the old generation is retired.
  const modA = (await import(
    `../src/override.ts?generation=a-${Date.now()}`
  )) as typeof import("../src/override");
  const modB = (await import(
    `../src/override.ts?generation=b-${Date.now()}`
  )) as typeof import("../src/override");

  expect(modA.installOverride({ prototype: proto, env: {} })).toEqual({
    state: "skipped",
    reason: "already-wrapped",
  });
  expect(modB.installOverride({ prototype: proto, env: {} })).toEqual({
    state: "skipped",
    reason: "already-wrapped",
  });
  expect(proto.bindCore).toBe(current);

  const sessionD = {} as SessionManager;
  const settingsD = baseSettings("anthropic/claude-d");
  const runnerD = new FakeRunner(sessionD, settingsD);
  const ctxD = contextFor(runnerD);
  runnerD.bindCore({}, { getCompactionSettings: () => settingsD });

  expect(modB.activate(sessionD, ctxD)).toEqual({ state: "active" });
  const activeSettings = ctxD.getCompactionSettings() as TestSettings;
  expect(activeSettings.speculativeEnabled).toBe(false);
  expect(activeSettings.idleCompactionEnabled).toBe(false);
  expect(activeSettings.model).toBe(settingsD.model);

  modA.deactivate(sessionD);
  expect(ctxD.getCompactionSettings()).toBe(settingsD);
});

test("a failed self-test removes the entry and reports dormant(capability)", () => {
  // The runner was never bound after the prototype patch, so its getter still
  // returns the base settings and activation must fail closed.
  const sessionE = {} as SessionManager;
  const settingsE = baseSettings("anthropic/claude-e");
  const runnerE = new FakeRunner(sessionE, settingsE);
  const ctxE = contextFor(runnerE);
  expect(activate(sessionE, ctxE)).toEqual({
    state: "dormant",
    reason: "capability",
  });

  runnerE.bindCore({}, { getCompactionSettings: () => settingsE });
  expect(ctxE.getCompactionSettings()).toBe(settingsE);

  // A wrapper that clears the flags but changes `model` must also fail.
  const sessionF = {} as SessionManager;
  const settingsF = baseSettings("anthropic/claude-f");
  const runnerF = new FakeRunner(sessionF, settingsF);
  runnerF.bindCore({}, { getCompactionSettings: () => settingsF });
  let reads = 0;
  const brokenCtx: CompactionSettingsContext = {
    getCompactionSettings: () => {
      reads += 1;
      if (reads === 1) return settingsF;
      return {
        ...settingsF,
        speculativeEnabled: false,
        idleCompactionEnabled: false,
        model: "broken/model",
      };
    },
  };
  expect(activate(sessionF, brokenCtx)).toEqual({
    state: "dormant",
    reason: "capability",
  });
  // The key was removed, so the real wrapper returns the base object again.
  expect(contextFor(runnerF).getCompactionSettings()).toBe(settingsF);
});

test("a second install does not wrap again", () => {
  const proto = prototypeOf();
  const current = proto.bindCore;
  expect(installOverride({ prototype: proto, env: {} })).toEqual({
    state: "skipped",
    reason: "already-wrapped",
  });
  expect(proto.bindCore).toBe(current);
});
