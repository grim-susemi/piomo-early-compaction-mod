import { describe, expect, test } from "bun:test";
import {
  BREAKER_WARNING,
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  MODEL_UNRESOLVED_WARNING,
  ROUTE_WORDS,
  STATUS_KEY,
  applyNotice,
  createSurface,
  dormancyWarning,
  dormantFooterText,
  footerText,
  thousands,
  type SurfaceCommandContext,
  type SurfaceState,
} from "../src/surface";

interface StatusCall {
  readonly key: string;
  readonly text: string | undefined;
}

interface NotifyCall {
  readonly message: string;
  readonly type: "info" | "warning" | "error" | undefined;
}

class FakeUI {
  readonly statusCalls: StatusCall[] = [];
  readonly notifications: NotifyCall[] = [];

  setStatus(key: string, text: string | undefined): void {
    this.statusCalls.push({ key, text });
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notifications.push({ message, type });
  }
}

interface RegisteredCommand {
  readonly name: string;
  readonly options: {
    readonly description?: string;
    readonly handler: (
      args: string,
      ctx: SurfaceCommandContext,
    ) => Promise<void> | void;
  };
}

class FakeRegistrar {
  readonly commands: RegisteredCommand[] = [];

  register: (name: string, options: RegisteredCommand["options"]) => void = (
    name,
    options,
  ) => {
    this.commands.push({ name, options });
  };
}

function activeSurface(
  overrides: {
    hasUI?: boolean;
    mode?: "notes" | "rewrite";
    register?: FakeRegistrar;
    now?: () => Date;
  } = {},
) {
  const ui = new FakeUI();
  const registrar = overrides.register;
  const surface = createSurface({
    ui,
    hasUI: overrides.hasUI ?? true,
    gate: { state: "active" },
    mode: overrides.mode ?? "notes",
    registerCommand: registrar?.register,
    now: overrides.now,
  });
  return { ui, registrar, surface };
}

function statusTexts(ui: FakeUI): (string | undefined)[] {
  return ui.statusCalls.map((call) => call.text);
}

describe("footer", () => {
  test("exact string for each active state and update-on-change only", () => {
    const { ui, surface } = activeSurface();

    expect(ui.statusCalls).toEqual([{ key: STATUS_KEY, text: "EC 대기" }]);

    surface.setState({ phase: "generating" });
    expect(statusTexts(ui)).toEqual(["EC 대기", "EC 준비중"]);

    surface.setState({ phase: "ready", savedTokens: 112_400 });
    expect(statusTexts(ui)).toEqual(["EC 대기", "EC 준비중", "EC 준비됨 -112k"]);

    surface.setState({ phase: "idle" });
    expect(statusTexts(ui)).toEqual([
      "EC 대기",
      "EC 준비중",
      "EC 준비됨 -112k",
      "EC 대기",
    ]);

    // Same text again: no duplicate footer write.
    surface.setState({ phase: "idle" });
    expect(ui.statusCalls).toHaveLength(4);
  });

  test("READY reports saved tokens in thousands, rounded", () => {
    const { ui, surface } = activeSurface();

    surface.setState({ phase: "ready", savedTokens: 168_900 });
    surface.setState({ phase: "ready", savedTokens: 999 });
    surface.setState({ phase: "ready", savedTokens: 1_500 });

    expect(statusTexts(ui)).toEqual([
      "EC 대기",
      "EC 준비됨 -169k",
      "EC 준비됨 -1k",
      "EC 준비됨 -2k",
    ]);
  });

  test("pure footer helpers match the emitted strings", () => {
    const states: SurfaceState[] = [
      { phase: "idle" },
      { phase: "generating" },
      { phase: "ready", savedTokens: 61_500 },
    ];
    expect(states.map(footerText)).toEqual([
      "EC 대기",
      "EC 준비중",
      "EC 준비됨 -62k",
    ]);
    expect(thousands(-10)).toBe(0);
    expect(thousands(61_499)).toBe(61);
    expect(dormantFooterText("capability")).toBe("EC 꺼짐(capability)");
  });

  test("stop clears the footer once", () => {
    const { ui, surface } = activeSurface();
    surface.stop();
    surface.stop();
    expect(ui.statusCalls).toEqual([
      { key: STATUS_KEY, text: "EC 대기" },
      { key: STATUS_KEY, text: undefined },
    ]);
  });
});

describe("apply notice", () => {
  test("exactly one info notice per apply with the route word", () => {
    const { ui, surface } = activeSurface();

    surface.recordApply({
      route: "cold",
      tokensBefore: 168_000,
      estimatedTokensAfter: 41_000,
    });
    surface.recordApply({
      route: "boundary",
      tokensBefore: 120_400,
      estimatedTokensAfter: 31_000,
    });
    surface.recordApply({
      route: "threshold",
      tokensBefore: 183_000,
      estimatedTokensAfter: 52_000,
    });

    expect(ui.notifications).toEqual([
      {
        message: "조기 요약 적용: 168k -> 41k (식은 캐시)",
        type: "info",
      },
      {
        message: "조기 요약 적용: 120k -> 31k (작업 끝)",
        type: "info",
      },
      {
        message: "조기 요약 적용: 183k -> 52k (한계 도달)",
        type: "info",
      },
    ]);
    // No warnings ride along with an apply.
    expect(ui.notifications.every((call) => call.type === "info")).toBe(true);
    expect(surface.snapshot().applies).toEqual({
      cold: 1,
      boundary: 1,
      threshold: 1,
    });
    expect(surface.snapshot().totalApplies).toBe(3);
  });

  test("route words and notice text are exported consistently", () => {
    expect(ROUTE_WORDS).toEqual({
      cold: "식은 캐시",
      boundary: "작업 끝",
      threshold: "한계 도달",
    });
    expect(
      applyNotice({
        route: "boundary",
        tokensBefore: 10_000,
        estimatedTokensAfter: 9_000,
      }),
    ).toBe("조기 요약 적용: 10k -> 9k (작업 끝)");
  });

  test("last apply keeps the injected clock timestamp", () => {
    const { surface } = activeSurface({
      now: () => new Date("2026-10-19T12:34:56.000Z"),
    });
    surface.recordApply({
      route: "cold",
      tokensBefore: 50_000,
      estimatedTokensAfter: 20_000,
    });
    expect(surface.snapshot().lastApply).toEqual({
      route: "cold",
      tokensBefore: 50_000,
      estimatedTokensAfter: 20_000,
      at: "2026-10-19T12:34:56.000Z",
    });
  });
});

describe("warnings", () => {
  test("warning dormancy warns and shows the off footer once per session", () => {
    for (const reason of ["unqualified", "capability"] as const) {
      const ui = new FakeUI();
      const surface = createSurface({
        ui,
        hasUI: true,
        gate: { state: "dormant", reason },
        mode: "notes",
      });

      expect(ui.notifications).toEqual([
        { message: dormancyWarning(reason), type: "warning" },
      ]);
      expect(ui.statusCalls).toEqual([
        { key: STATUS_KEY, text: `EC 꺼짐(${reason})` },
      ]);

      surface.warnDormancy(reason);
      surface.warnDormancy(reason);
      expect(ui.notifications).toHaveLength(1);
      expect(ui.statusCalls).toHaveLength(1);
      expect(surface.snapshot().warnings).toEqual(["dormancy"]);
    }
  });

  test("breaker and model-unresolved warn once each per session", () => {
    const { ui, surface } = activeSurface();

    surface.warnBreakerOpened();
    surface.warnBreakerOpened();
    surface.warnModelUnresolved();
    surface.warnModelUnresolved();

    expect(ui.notifications).toEqual([
      { message: BREAKER_WARNING, type: "warning" },
      { message: MODEL_UNRESOLVED_WARNING, type: "warning" },
    ]);
    expect(surface.snapshot().warnings).toEqual(["breaker", "model-unresolved"]);
  });

  test("each cause has its own once-per-session slot", () => {
    const { ui, surface } = activeSurface();
    surface.warnBreakerOpened();
    surface.warnModelUnresolved();
    surface.warnDormancy("capability"); // not a dormancy session
    surface.warnDormancy("unqualified");
    surface.warnBreakerOpened();

    expect(ui.notifications.map((call) => call.type)).toEqual([
      "warning",
      "warning",
    ]);
  });

  test("a new session warns again (once per session)", () => {
    const first = activeSurface();
    first.surface.warnBreakerOpened();
    first.surface.warnBreakerOpened();
    const second = activeSurface();
    second.surface.warnBreakerOpened();

    expect(first.ui.notifications).toHaveLength(1);
    expect(second.ui.notifications).toHaveLength(1);
  });
});

describe("silent dormancy and no UI", () => {
  test("env, mode and compaction-off make zero UI calls", () => {
    for (const reason of ["env", "mode", "compaction-off"] as const) {
      const ui = new FakeUI();
      const registrar = new FakeRegistrar();
      const surface = createSurface({
        ui,
        hasUI: true,
        gate: { state: "dormant", reason },
        mode: "notes",
        registerCommand: registrar.register,
      });

      surface.setState({ phase: "generating" });
      surface.recordApply({
        route: "cold",
        tokensBefore: 1_000,
        estimatedTokensAfter: 500,
      });
      surface.warnDormancy(reason);
      surface.warnBreakerOpened();
      surface.warnModelUnresolved();
      surface.handleCommand({ ui });
      surface.stop();

      expect(ui.statusCalls).toEqual([]);
      expect(ui.notifications).toEqual([]);
      expect(registrar.commands).toEqual([]);
      expect(surface.visible).toBe(false);
      expect(surface.snapshot().dormantReason).toBe(reason);
    }
  });

  test("hasUI false suppresses footer, notices, warnings and the command", () => {
    for (const gate of [
      { state: "active" as const },
      { state: "dormant" as const, reason: "unqualified" as const },
    ]) {
      const ui = new FakeUI();
      const registrar = new FakeRegistrar();
      const surface = createSurface({
        ui,
        hasUI: false,
        gate,
        mode: "notes",
        registerCommand: registrar.register,
      });

      surface.setState({ phase: "ready", savedTokens: 10_000 });
      surface.recordApply({
        route: "boundary",
        tokensBefore: 10_000,
        estimatedTokensAfter: 5_000,
      });
      surface.warnBreakerOpened();
      surface.warnModelUnresolved();

      expect(ui.statusCalls).toEqual([]);
      expect(ui.notifications).toEqual([]);
      expect(registrar.commands).toEqual([]);
    }
  });
});

describe("/early-compaction command", () => {
  function commandContext(): { ctx: SurfaceCommandContext; ui: FakeUI } {
    const ui = new FakeUI();
    return { ctx: { ui }, ui };
  }

  test("registers one read-only command and prints state, mode, routes, last apply", async () => {
    const registrar = new FakeRegistrar();
    const { ui, surface } = activeSurface({
      register: registrar,
      now: () => new Date("2026-10-19T01:02:03.000Z"),
    });

    expect(registrar.commands).toHaveLength(1);
    const command = registrar.commands[0];
    expect(command.name).toBe(COMMAND_NAME);
    expect(command.options.description).toBe(COMMAND_DESCRIPTION);

    surface.recordApply({
      route: "cold",
      tokensBefore: 100_000,
      estimatedTokensAfter: 30_000,
    });
    surface.recordApply({
      route: "cold",
      tokensBefore: 90_000,
      estimatedTokensAfter: 40_000,
    });
    surface.recordApply({
      route: "boundary",
      tokensBefore: 168_000,
      estimatedTokensAfter: 41_000,
    });

    const before = surface.snapshot();
    const statusBefore = ui.statusCalls.length;
    const { ctx, ui: commandUI } = commandContext();
    await command.options.handler("", ctx);

    expect(commandUI.notifications).toHaveLength(1);
    const printed = commandUI.notifications[0];
    expect(printed.type).toBe("info");
    expect(printed.message).toContain("state: active");
    expect(printed.message).toContain("mode: notes");
    expect(printed.message).toContain(
      "applies this session: cold=2 boundary=1 threshold=0 total=3",
    );
    expect(printed.message).toContain(
      "last apply: boundary 168k -> 41k at 2026-10-19T01:02:03.000Z",
    );
    expect(printed.message).toContain("dormant: none");

    // Read-only: no footer write and no state change.
    expect(ui.statusCalls).toHaveLength(statusBefore);
    expect(surface.snapshot()).toEqual(before);
  });

  test("prints the dormant reason and mode in a warning-dormant session", async () => {
    const ui = new FakeUI();
    const registrar = new FakeRegistrar();
    const surface = createSurface({
      ui,
      hasUI: true,
      gate: { state: "dormant", reason: "capability" },
      mode: "rewrite",
      registerCommand: registrar.register,
    });

    expect(registrar.commands).toHaveLength(1);
    const { ctx, ui: commandUI } = commandContext();
    await registrar.commands[0].options.handler("", ctx);

    const printed = commandUI.notifications[0].message;
    expect(printed).toContain("state: dormant (capability)");
    expect(printed).toContain("mode: rewrite");
    expect(printed).toContain(
      "applies this session: cold=0 boundary=0 threshold=0 total=0",
    );
    expect(printed).toContain("last apply: none");
    expect(printed).toContain("dormant: capability");

    expect(surface.snapshot().lastApply).toBeUndefined();
    expect(surface.snapshot().totalApplies).toBe(0);
  });

  test("statusText is pure and stable across calls", () => {
    const { surface } = activeSurface({ mode: "rewrite" });
    const first = surface.statusText();
    const second = surface.statusText();
    expect(second).toBe(first);
    expect(first).toContain("mode: rewrite");
    expect(surface.snapshot().totalApplies).toBe(0);
  });
});
