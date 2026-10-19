/**
 * Visible surface for the early-compaction mod: footer status, apply notices,
 * failure warnings and the read-only `/early-compaction` command.
 *
 * The surface is created once per session with the gate result. It is active
 * only when `hasUI` is true and the gate passed; silent dormancy (`env`,
 * `mode`, `compaction-off`) makes every method a no-op and registers no
 * command. Warning dormancy (`unqualified`, `capability`) shows
 * `EC 꺼짐(<reason>)` and emits exactly one warning per session.
 *
 * Footer strings:
 *   EC 대기              active, no prepared summary
 *   EC 준비중            a summary is being generated
 *   EC 준비됨 -<N>k      READY, N = saved tokens in thousands
 *   EC 꺼짐(<reason>)    warning dormancy only
 *
 * Every apply produces exactly one info notice; skipped jobs and failed jobs
 * produce none. Warnings are limited to one per cause per session.
 */
import type { GateReason, GateResult } from "./gate";
import type { ApplyRoute, CompactionMode } from "./policy";

/** Footer status key used with `ctx.ui.setStatus`. */
export const STATUS_KEY = "early-compaction";

/** Command name, without the leading slash. */
export const COMMAND_NAME = "early-compaction";

/** Command description shown by the TUI command picker. */
export const COMMAND_DESCRIPTION = "Show early-compaction state (read-only)";

/** Dormancy reasons that stay silent (no footer, no warning, no command). */
export const SILENT_DORMANCY_REASONS = [
  "env",
  "mode",
  "compaction-off",
] as const satisfies readonly GateReason[];

/** Dormancy reasons that warn and show the footer. */
export const WARNING_DORMANCY_REASONS = [
  "unqualified",
  "capability",
] as const satisfies readonly GateReason[];

export type WarningDormancyReason =
  (typeof WARNING_DORMANCY_REASONS)[number];

/** An apply route that actually happened ("none" never reaches the surface). */
export type AppliedRoute = Exclude<ApplyRoute, "none">;

/** Korean route words used in the apply notice. */
export const ROUTE_WORDS = {
  cold: "식은 캐시",
  boundary: "작업 끝",
  threshold: "한계 도달",
} as const satisfies Record<AppliedRoute, string>;

/** One of the three footer states while the gate is active. */
export type SurfaceState =
  | { readonly phase: "idle" }
  | { readonly phase: "generating" }
  | { readonly phase: "ready"; readonly savedTokens: number };

/** Input for one successful apply. */
export interface SurfaceApply {
  readonly route: AppliedRoute;
  readonly tokensBefore: number;
  readonly estimatedTokensAfter: number;
}

/** Stored record of the last successful apply. */
export interface SurfaceApplyRecord extends SurfaceApply {
  /** ISO-8601 UTC timestamp from the injected clock. */
  readonly at: string;
}

/** The two UI methods the surface uses. */
export interface SurfaceUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

/** The subset of `pi.registerCommand` the surface needs. */
export type RegisterCommand = (
  name: string,
  options: {
    readonly description?: string;
    readonly handler: (
      args: string,
      ctx: SurfaceCommandContext,
    ) => Promise<void> | void;
  },
) => void;

/** Command handler context: only `ui.notify` is read. */
export interface SurfaceCommandContext {
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/** Warning causes remembered per session. */
export type SurfaceWarningCause = "dormancy" | "breaker" | "model-unresolved";

export interface SurfaceOptions {
  readonly ui: SurfaceUI;
  readonly hasUI: boolean;
  readonly gate: GateResult;
  readonly mode: CompactionMode;
  /** `pi.registerCommand`; omitted in tests or contexts without commands. */
  readonly registerCommand?: RegisterCommand | undefined;
  /** Injectable clock for the last-apply timestamp. */
  readonly now?: (() => Date) | undefined;
}

export interface SurfaceSnapshot {
  readonly visible: boolean;
  readonly gate: "active" | "dormant";
  readonly state: SurfaceState;
  readonly mode: CompactionMode;
  readonly dormantReason: GateReason | undefined;
  readonly applies: Readonly<Record<AppliedRoute, number>>;
  readonly totalApplies: number;
  readonly lastApply: SurfaceApplyRecord | undefined;
  readonly warnings: readonly SurfaceWarningCause[];
}

export interface VisibleSurface {
  /** True when the footer, notices and command are live. */
  readonly visible: boolean;
  /** Update the footer. Repeated identical text is not re-sent. */
  setState(state: SurfaceState): void;
  /** Emit the single per-apply notice and record the route. */
  recordApply(apply: SurfaceApply): SurfaceApplyRecord | undefined;
  /** One warning per session for warning dormancy. */
  warnDormancy(reason?: GateReason): void;
  /** One warning per session when the failure breaker opens. */
  warnBreakerOpened(): void;
  /** One warning per session when `compaction.model` cannot be resolved. */
  warnModelUnresolved(): void;
  /** Read-only command text: state, mode, route counts, last apply, dormancy. */
  statusText(): string;
  /** Print `statusText()` as one info notice; never mutates surface state. */
  handleCommand(ctx: SurfaceCommandContext): void;
  /** Clear the footer (session shutdown). */
  stop(): void;
  /** Immutable copy of the current state. */
  snapshot(): SurfaceSnapshot;
}

/** Warning text for warning dormancy. */
export function dormancyWarning(reason: GateReason): string {
  return (
    `piomo early-compaction: dormant (${reason}); ` +
    "stock senpi behaviour is unchanged."
  );
}

/** Warning text when the failure breaker opens. */
export const BREAKER_WARNING =
  "piomo early-compaction: summarization paused after repeated failures " +
  "(breaker open).";

/** Warning text when the configured compaction model is unknown. */
export const MODEL_UNRESOLVED_WARNING =
  "piomo early-compaction: compaction model is not in the model registry; " +
  "skipping early summaries.";

/** Tokens in thousands, rounded to the nearest thousand. */
export function thousands(tokens: number): number {
  return Math.round(Math.max(0, tokens) / 1000);
}

/** Exact footer text for an active state. */
export function footerText(state: SurfaceState): string {
  switch (state.phase) {
    case "idle":
      return "EC 대기";
    case "generating":
      return "EC 준비중";
    case "ready":
      return `EC 준비됨 -${thousands(state.savedTokens)}k`;
  }
}

/** Exact footer text for a warning dormancy. */
export function dormantFooterText(reason: GateReason): string {
  return `EC 꺼짐(${reason})`;
}

/** Exact one-per-apply notice text. */
export function applyNotice(apply: SurfaceApply): string {
  return (
    `조기 요약 적용: ${thousands(apply.tokensBefore)}k -> ` +
    `${thousands(apply.estimatedTokensAfter)}k (${ROUTE_WORDS[apply.route]})`
  );
}

function isWarningDormancy(reason: GateReason): reason is WarningDormancyReason {
  return (WARNING_DORMANCY_REASONS as readonly string[]).includes(reason);
}

function copyState(state: SurfaceState): SurfaceState {
  return state.phase === "ready"
    ? { phase: "ready", savedTokens: state.savedTokens }
    : { phase: state.phase };
}

/**
 * Create the per-session surface. Construction emits the initial footer (and
 * the dormancy warning when applicable) only when both `hasUI` and the gate
 * allow UI output.
 */
export function createSurface(options: SurfaceOptions): VisibleSurface {
  const { ui, hasUI, gate, mode } = options;
  const now = options.now ?? (() => new Date());
  const dormantReason = gate.state === "dormant" ? gate.reason : undefined;
  const warningDormant =
    dormantReason !== undefined && isWarningDormancy(dormantReason);

  // Silent dormancy and UI-less sessions are inert: no footer, no warning,
  // no command. Their snapshot still reports why.
  const visible = hasUI && (gate.state === "active" || warningDormant);

  let state: SurfaceState = { phase: "idle" };
  let stopped = false;
  let lastFooter: string | undefined;
  let lastApply: SurfaceApplyRecord | undefined;
  const applies: Record<AppliedRoute, number> = {
    cold: 0,
    boundary: 0,
    threshold: 0,
  };
  const warned = new Set<SurfaceWarningCause>();

  function setFooter(text: string | undefined): void {
    if (!visible || stopped) return;
    if (text === lastFooter) return;
    lastFooter = text;
    ui.setStatus(STATUS_KEY, text);
  }

  function warnOnce(cause: SurfaceWarningCause, message: string): void {
    if (!visible || stopped || warned.has(cause)) return;
    warned.add(cause);
    ui.notify(message, "warning");
  }

  const surface: VisibleSurface = {
    visible,

    setState(next: SurfaceState): void {
      if (!visible || stopped) return;
      state = copyState(next);
      setFooter(footerText(state));
    },

    recordApply(apply: SurfaceApply): SurfaceApplyRecord | undefined {
      if (!visible || stopped) return undefined;
      const record: SurfaceApplyRecord = {
        route: apply.route,
        tokensBefore: apply.tokensBefore,
        estimatedTokensAfter: apply.estimatedTokensAfter,
        at: now().toISOString(),
      };
      applies[apply.route] += 1;
      lastApply = record;
      ui.notify(applyNotice(apply), "info");
      return record;
    },

    warnDormancy(reason?: GateReason): void {
      const cause = reason ?? dormantReason;
      if (gate.state !== "dormant" || cause !== dormantReason) return;
      if (cause === undefined || !isWarningDormancy(cause)) return;
      warnOnce("dormancy", dormancyWarning(cause));
    },

    warnBreakerOpened(): void {
      warnOnce("breaker", BREAKER_WARNING);
    },

    warnModelUnresolved(): void {
      warnOnce("model-unresolved", MODEL_UNRESOLVED_WARNING);
    },

    statusText(): string {
      const total = applies.cold + applies.boundary + applies.threshold;
      const stateLine =
        gate.state === "active"
          ? state.phase === "ready"
            ? `state: active (ready, ${thousands(state.savedTokens)}k saved)`
            : `state: active (${state.phase})`
          : `state: dormant (${gate.reason})`;
      const lastApplyLine =
        lastApply === undefined
          ? "last apply: none"
          : `last apply: ${lastApply.route} ` +
            `${thousands(lastApply.tokensBefore)}k -> ` +
            `${thousands(lastApply.estimatedTokensAfter)}k at ${lastApply.at}`;
      return [
        "early-compaction",
        stateLine,
        `mode: ${mode}`,
        `applies this session: cold=${applies.cold} boundary=${applies.boundary} ` +
          `threshold=${applies.threshold} total=${total}`,
        lastApplyLine,
        `dormant: ${dormantReason ?? "none"}`,
      ].join("\n");
    },

    handleCommand(ctx: SurfaceCommandContext): void {
      if (!visible || stopped) return;
      ctx.ui.notify(surface.statusText(), "info");
    },

    stop(): void {
      if (stopped) return;
      setFooter(undefined);
      stopped = true;
    },

    snapshot(): SurfaceSnapshot {
      return {
        visible,
        gate: gate.state,
        state: copyState(state),
        mode,
        dormantReason,
        applies: { ...applies },
        totalApplies: applies.cold + applies.boundary + applies.threshold,
        lastApply: lastApply === undefined ? undefined : { ...lastApply },
        warnings: [...warned],
      };
    },
  };

  if (warningDormant) {
    // Warning first, then the off footer: the owner sees why it is off.
    surface.warnDormancy(dormantReason);
    setFooter(dormantFooterText(dormantReason));
  } else if (gate.state === "active") {
    setFooter(footerText(state));
  }

  if (visible && options.registerCommand !== undefined) {
    options.registerCommand(COMMAND_NAME, {
      description: COMMAND_DESCRIPTION,
      handler: (_args: string, ctx: SurfaceCommandContext) => {
        surface.handleCommand(ctx);
      },
    });
  }

  return surface;
}
