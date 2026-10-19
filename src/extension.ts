/**
 * Extension factory and event wiring for early compaction.
 *
 * The `bindCore` override is installed at factory/load time, before any handler
 * is registered. Each `session_start` re-evaluates the gate, activates the
 * override entry for the session, opens metrics, creates the visible surface,
 * and starts the per-session job controller (idle timer + user-activity
 * subscription).
 *
 * Handlers only delegate. `turn_end`/`agent_settled` never await generation;
 * the input handler awaits the apply promise (not the generation promise) so a
 * threshold handoff lands before the submitted prompt is built.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@code-yeongyu/senpi";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@code-yeongyu/senpi";
import { Type } from "@earendil-works/pi-ai";
import { CACHE_WARM_PING_EVENT, createCacheStateTracker } from "./cache-state";
import { createRealSessionGate, type GateResult } from "./gate";
import {
  JobController,
  type JobCache,
  type JobContext,
  type JobMetricsWriter,
  type JobSnapshot,
  type JobTimers,
  type PrepareFn,
  type GenerateFn,
} from "./job";
import {
  createMetricsWriter,
  hashSessionId,
  type OverrideState,
} from "./metrics";
import {
  activate,
  deactivate,
  installOverride,
  type ActivateResult,
  type InstallOverrideResult,
} from "./override";
import {
  resolvePolicyConfig,
  type CompactionMode,
  type PolicyConfig,
} from "./policy";
import {
  createSurface,
  type SurfaceOptions,
  type VisibleSurface,
} from "./surface";

/** `<agentDir>/early-compaction/config.json`, defaults applied. */
export interface ExtensionConfig {
  mode: CompactionMode;
  policy: PolicyConfig;
  allowRpcInteractive: boolean;
  /** Set when a config file existed but could not be used in full. */
  configIssue?: "unreadable" | "invalid" | undefined;
}

/** Test seams; production uses every default. */
export interface EarlyCompactionOptions {
  installOverride?: () => InstallOverrideResult;
  gate?: (ctx: JobContext, config: ExtensionConfig) => GateResult;
  activateOverride?: (sessionManager: SessionManager, ctx: JobContext) => ActivateResult;
  deactivateOverride?: (sessionManager: SessionManager) => void;
  createMetrics?: (ctx: JobContext) => JobMetricsWriter | null;
  createSurface?: (options: SurfaceOptions) => VisibleSurface;
  createCache?: (now: () => number) => JobCache;
  config?: ExtensionConfig;
  now?: () => number;
  random?: () => number;
  timers?: JobTimers;
  prepare?: PrepareFn;
  generate?: GenerateFn;
}

export interface EarlyCompactionHandle {
  getSession(): JobSnapshot | undefined;
  dispose(): void;
}

interface CurrentSession {
  controller: JobController;
  sessionManager: SessionManager;
  activated: boolean;
  cacheWarmUnsubscribe: (() => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultConfig(): ExtensionConfig {
  return {
    mode: "notes",
    policy: resolvePolicyConfig({}),
    allowRpcInteractive: false,
  };
}

/** Validate the config file; a bad file falls back to defaults, never throws. */
export function resolveExtensionConfig(value: unknown): ExtensionConfig {
  const defaults = defaultConfig();
  if (!isRecord(value)) return { ...defaults, configIssue: "invalid" };
  if (value.schema !== undefined && value.schema !== 1) {
    return { ...defaults, configIssue: "invalid" };
  }

  const mode: CompactionMode = value.mode === "rewrite" ? "rewrite" : "notes";
  let policy = defaults.policy;
  let configIssue: ExtensionConfig["configIssue"];
  try {
    policy = resolvePolicyConfig(value.policy ?? {});
  } catch {
    policy = defaults.policy;
    configIssue = "invalid";
  }
  return {
    mode,
    policy,
    allowRpcInteractive: value.allowRpcInteractive === true,
    configIssue,
  };
}

/**
 * Read `<agentDir>/early-compaction/config.json`. A missing file is normal
 * (defaults, no issue); an unreadable or malformed file falls back to defaults
 * and sets `configIssue` so the session can warn once.
 */
export function readExtensionConfig(agentDir: string): ExtensionConfig {
  let text: string;
  try {
    text = readFileSync(join(agentDir, "early-compaction", "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return defaultConfig();
    return { ...defaultConfig(), configIssue: "unreadable" };
  }
  try {
    return resolveExtensionConfig(JSON.parse(text) as unknown);
  } catch {
    return { ...defaultConfig(), configIssue: "invalid" };
  }
}

function createSessionMetrics(ctx: JobContext): JobMetricsWriter | null {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
    return createMetricsWriter({
      agentDir: ctx.agentDir,
      sessionHash: hashSessionId(sessionId),
      modelLabel,
    });
  } catch {
    return null;
  }
}

function installForLoad(options: EarlyCompactionOptions): InstallOverrideResult {
  try {
    return (options.installOverride ?? installOverride)();
  } catch {
    return { state: "skipped", reason: "shape-mismatch" };
  }
}

/**
 * Register the extension. Returns a small handle for QA to observe the phase
 * and to dispose deterministically; the loader ignores the return value.
 */
export function createEarlyCompactionExtension(
  pi: ExtensionAPI,
  options: EarlyCompactionOptions = {},
): EarlyCompactionHandle {
  // MUST run before handlers: the gate's self-test and every per-session
  // activation depend on the prototype patch being in place.
  const install = installForLoad(options);
  const installUsable =
    install.state === "installed" ||
    (install.state === "skipped" && install.reason === "already-wrapped");

  const now = options.now ?? Date.now;
  let current: CurrentSession | undefined;

  const jobContext = (ctx: ExtensionContext): JobContext => ctx;

  function disposeCurrent(): void {
    const prior = current;
    current = undefined;
    if (!prior) return;
    try {
      prior.controller.sessionShutdown();
    } catch {
      // Teardown is best-effort.
    }
    try {
      prior.cacheWarmUnsubscribe?.();
    } catch {
      // The bus may already be gone.
    }
    if (prior.activated) {
      try {
        (options.deactivateOverride ?? deactivate)(prior.sessionManager);
      } catch {
        // WeakSet deletion cannot fail, but a host seam might.
      }
    }
  }

  function evaluateGate(ctx: JobContext, config: ExtensionConfig): GateResult {
    try {
      if (options.gate) return options.gate(ctx, config);
      const gate = createRealSessionGate({
        pi: { sessionKind: pi.sessionKind },
        ctx,
        config: { allowRpcInteractive: config.allowRpcInteractive },
        overrideSelfTest: installUsable,
        // Warning dormancy is emitted once by the surface, not twice.
        warn: () => {},
      });
      return gate.evaluate();
    } catch {
      return { state: "dormant", reason: "capability" };
    }
  }

  function makeSurface(
    ctx: JobContext,
    gate: GateResult,
    config: ExtensionConfig,
  ): VisibleSurface {
    const factory = options.createSurface ?? createSurface;
    const surfaceOptions: SurfaceOptions = {
      ui: ctx.ui,
      hasUI: ctx.hasUI,
      gate,
      mode: config.mode,
      registerCommand: (name, command) => {
        try {
          pi.registerCommand(name, {
            description: command.description,
            handler: async (args, commandCtx) => {
              await command.handler(args, { ui: commandCtx.ui });
            },
          });
        } catch {
          // A duplicate registration after a repeated session_start is fine.
        }
      },
      now: () => new Date(now()),
    };
    try {
      return factory(surfaceOptions);
    } catch {
      // An unusable UI keeps the machinery silent rather than failing loading.
      return createSurface({
        ui: ctx.ui,
        hasUI: false,
        gate: { state: "active" },
        mode: config.mode,
        now: () => new Date(now()),
      });
    }
  }

  function createSession(ctx: ExtensionContext): void {
    disposeCurrent();

    const sessionManager = ctx.sessionManager as unknown as SessionManager;
    let activated = false;
    let controller: JobController | undefined;
    try {
      const context = jobContext(ctx);
      const config = options.config ?? readExtensionConfig(ctx.agentDir);
      const gateResult = evaluateGate(context, config);
      let effectiveGate = gateResult;
      let initialOverrideState: OverrideState | undefined;
      let metrics: JobMetricsWriter | null = null;
      try {
        metrics = options.createMetrics
          ? options.createMetrics(context)
          : createSessionMetrics(context);
      } catch {
        metrics = null;
      }

      if (gateResult.state === "active") {
        let activation: ActivateResult;
        try {
          activation = (options.activateOverride ?? activate)(sessionManager, context);
        } catch {
          try {
            (options.deactivateOverride ?? deactivate)(sessionManager);
          } catch {
            // Fail closed even if the self-test threw unexpectedly.
          }
          activation = { state: "dormant", reason: "capability" };
        }
        if (activation.state === "active") {
          initialOverrideState = "installed";
          activated = true;
        } else {
          try {
            (options.deactivateOverride ?? deactivate)(sessionManager);
          } catch {
            // activate() already removed the entry on its own failure paths.
          }
          effectiveGate = { state: "dormant", reason: "capability" };
          initialOverrideState = "self-test-failed";
        }
      }

      const surface = makeSurface(context, effectiveGate, config);
      if (config.configIssue !== undefined && effectiveGate.state === "active") {
        try {
          surface.warnConfigInvalid();
        } catch {
          // A broken UI must not stop the session; the defaults still apply.
        }
      }
      const cache = (options.createCache ?? ((clock) => createCacheStateTracker({ now: clock })))(
        now,
      );

      controller = new JobController({
        gate: effectiveGate,
        config: { mode: config.mode, policy: config.policy },
        metrics,
        surface,
        cache,
        initialOverrideState,
        now,
        random: options.random,
        timers: options.timers,
        prepare: options.prepare,
        generate: options.generate,
      });
      controller.sessionStart(context);

      let cacheWarmUnsubscribe: (() => void) | undefined;
      try {
        cacheWarmUnsubscribe = pi.events.on(CACHE_WARM_PING_EVENT, () =>
          controller?.observeWarmPing(),
        );
      } catch {
        cacheWarmUnsubscribe = undefined;
      }

      current = {
        controller,
        sessionManager,
        activated,
        cacheWarmUnsubscribe,
      };
    } catch {
      try {
        controller?.sessionShutdown();
      } catch {
        // Nothing else to clean.
      }
      if (activated) {
        try {
          (options.deactivateOverride ?? deactivate)(sessionManager);
        } catch {
          // Fail closed; the session is not being served.
        }
      }
      current = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Event wiring. Every handler delegates; none awaits generation.
  // -------------------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    createSession(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    current?.controller.turnEnd(jobContext(ctx));
  });

  pi.on("agent_end", (event, ctx) => {
    current?.controller.agentEnd(jobContext(ctx), event);
  });

  pi.on("agent_settled", (_event, ctx) => {
    current?.controller.agentSettled(jobContext(ctx));
  });

  pi.on("input", async (event, ctx) => {
    try {
      await current?.controller.handleInput(jobContext(ctx), event);
    } catch {
      // The prompt continues even if the job seam failed.
    }
    return undefined;
  });

  pi.on("session_before_compact", (_event, ctx) => {
    try {
      current?.controller.sessionBeforeCompact(jobContext(ctx));
    } catch {
      // Always continue with stock compaction.
    }
    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    current?.controller.sessionCompact(jobContext(ctx), event);
  });

  pi.on("session_tree", (_event, ctx) => {
    current?.controller.sessionTree(jobContext(ctx));
  });

  pi.on("model_select", (_event, ctx) => {
    current?.controller.modelSelect(jobContext(ctx));
  });

  pi.on("message_end", (event, ctx) => {
    current?.controller.messageEnd(jobContext(ctx), event);
  });

  pi.on("after_provider_response", (_event, ctx) => {
    current?.controller.afterProviderResponse(jobContext(ctx));
  });

  pi.on("before_provider_request", (event, ctx) => {
    try {
      current?.controller.beforeProviderRequest(jobContext(ctx), event);
    } catch {
      // This handler must always return undefined.
    }
    return undefined;
  });

  pi.on("session_shutdown", () => {
    disposeCurrent();
  });

  return {
    getSession: () => current?.controller.snapshot(),
    dispose: () => disposeCurrent(),
  };
}

export default function earlyCompaction(pi: ExtensionAPI): void {
  // Both runtime imports stay referenced so the bundle keeps the extension
  // loader's two externals (smoke.test.ts).
  void VERSION;
  void Type;
  createEarlyCompactionExtension(pi);
}
