/**
 * In-memory suppression of the builtin's speculative and idle pre-summarization.
 *
 * The builtin reads both switches through the runner's compaction-settings getter
 * (builtin/compaction/policy.js:99, idle.js:14). `ExtensionRunner.bindCore` assigns
 * that getter from the session's context actions (runner.js:365), so the only seam
 * is a wrapper installed after the original bindCore has run. It must be installed
 * at extension load, before the runner is bound; a session may then be activated
 * and deactivated at any time.
 *
 * The patch and the per-session keys live on globalThis because `/reload` can
 * evaluate a fresh copy of this module while the prototype patch from the previous
 * generation stays in force. The prototype is never restored: another extension
 * (omo-compaction-model.ts) may have captured the bindCore that existed at its own
 * load time, and restoring would bypass its wrapper.
 */
import { ExtensionRunner } from "@code-yeongyu/senpi";
import type { CompactionSettings, SessionManager } from "@code-yeongyu/senpi";

const STATE_KEY = Symbol.for("piomo.early-compaction.override.v1");

export interface OverrideGlobalState {
  wrapped: boolean;
  active: WeakSet<SessionManager>;
}

/** Settings as the runner exposes them at runtime; the type root omits `model`. */
type ModelBearingSettings = CompactionSettings & { model?: string };

interface RunnerLike {
  sessionManager: SessionManager;
  getCompactionSettingsFn?: () => CompactionSettings;
}

export interface InstallOverrideOptions {
  /** Test seam: prototype to patch. Defaults to ExtensionRunner.prototype. */
  prototype?: Record<string, unknown>;
  /** Test seam: environment map. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export type InstallOverrideResult =
  | { state: "installed" }
  | { state: "skipped"; reason: "env" | "already-wrapped" | "shape-mismatch" };

/** The part of an extension context the self-test needs. */
export interface CompactionSettingsContext {
  getCompactionSettings(): CompactionSettings;
}

export type ActivateResult =
  | { state: "active" }
  | { state: "dormant"; reason: "capability" };

function getState(): OverrideGlobalState {
  const holder = globalThis as unknown as {
    [key: symbol]: OverrideGlobalState | undefined;
  };
  const existing = holder[STATE_KEY];
  if (
    existing &&
    existing.active instanceof WeakSet &&
    typeof existing.wrapped === "boolean"
  ) {
    return existing;
  }
  const created: OverrideGlobalState = {
    wrapped: false,
    active: new WeakSet<SessionManager>(),
  };
  holder[STATE_KEY] = created;
  return created;
}

/**
 * Install the process-global bindCore patch once. Safe to call from every
 * extension generation: later calls see the shared `wrapped` flag and do nothing.
 */
export function installOverride(
  options: InstallOverrideOptions = {},
): InstallOverrideResult {
  const env = options.env ?? process.env;
  if (env.PIOMO_EARLY_COMPACTION === "0") {
    return { state: "skipped", reason: "env" };
  }

  const state = getState();
  if (state.wrapped) {
    return { state: "skipped", reason: "already-wrapped" };
  }

  const ctor = ExtensionRunner as unknown as
    | { prototype?: Record<string, unknown> }
    | undefined;
  const proto = options.prototype ?? ctor?.prototype;
  const previous = proto?.bindCore;
  if (!proto || typeof previous !== "function") {
    return { state: "skipped", reason: "shape-mismatch" };
  }

  proto.bindCore = function patchedBindCore(
    this: RunnerLike,
    ...args: unknown[]
  ): unknown {
    const bound = previous.apply(this, args);
    // Only after the original assigned this.getCompactionSettingsFn.
    wrapSettingsGetter(this);
    return bound;
  };
  state.wrapped = true;
  return { state: "installed" };
}

function wrapSettingsGetter(runner: RunnerLike): void {
  const base = runner.getCompactionSettingsFn;
  if (typeof base !== "function") {
    // Fail closed: an unexpected runner shape keeps the base getter untouched.
    return;
  }
  runner.getCompactionSettingsFn = function patchedCompactionSettings(): CompactionSettings {
    const settings = base.call(runner);
    if (!getState().active.has(runner.sessionManager)) {
      // Inactive sessions must see the exact base object, not a copy.
      return settings;
    }
    return {
      ...settings,
      speculativeEnabled: false,
      idleCompactionEnabled: false,
    };
  };
}

function modelOf(settings: CompactionSettings): string | undefined {
  return (settings as ModelBearingSettings).model;
}

function readSettings(
  ctx: CompactionSettingsContext,
):
  | { ok: true; value: CompactionSettings }
  | { ok: false } {
  try {
    const value = ctx.getCompactionSettings();
    if (!value || typeof value !== "object") return { ok: false };
    return { ok: true, value };
  } catch {
    // A throwing getter means the seam is not usable in this runner.
    return { ok: false };
  }
}

/**
 * Mark one session as active and prove the seam works for it. The self-test
 * compares the base getter (before activation) with the suppressed getter
 * (after activation): both flags must be false and `model` must be unchanged.
 * Any mismatch removes the key and leaves stock behaviour in place.
 */
export function activate(
  sessionManager: SessionManager,
  ctx: CompactionSettingsContext,
): ActivateResult {
  const state = getState();
  const base = readSettings(ctx);
  if (!base.ok) return { state: "dormant", reason: "capability" };

  state.active.add(sessionManager);
  const active = readSettings(ctx);
  if (!active.ok) {
    state.active.delete(sessionManager);
    return { state: "dormant", reason: "capability" };
  }

  const ok =
    active.value.speculativeEnabled === false &&
    active.value.idleCompactionEnabled === false &&
    modelOf(active.value) === modelOf(base.value);
  if (!ok) {
    state.active.delete(sessionManager);
    return { state: "dormant", reason: "capability" };
  }
  return { state: "active" };
}

/** Remove one session; its getter returns the base object again. */
export function deactivate(sessionManager: SessionManager): void {
  getState().active.delete(sessionManager);
}
