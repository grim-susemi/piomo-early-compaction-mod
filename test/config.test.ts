import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExtensionConfig, resolveExtensionConfig } from "../src/extension";

const dirs: string[] = [];

function agentDirWith(configText: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "ec-config-test-"));
  dirs.push(dir);
  if (configText !== undefined) {
    mkdirSync(join(dir, "early-compaction"), { recursive: true });
    writeFileSync(join(dir, "early-compaction", "config.json"), configText);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("readExtensionConfig", () => {
  test("a missing file is normal: defaults and no issue", () => {
    const config = readExtensionConfig(agentDirWith(undefined));
    expect(config.mode).toBe("notes");
    expect(config.configIssue).toBeUndefined();
  });

  test("a valid file is applied with no issue", () => {
    const config = readExtensionConfig(
      agentDirWith(JSON.stringify({ schema: 1, mode: "rewrite" })),
    );
    expect(config.mode).toBe("rewrite");
    expect(config.configIssue).toBeUndefined();
  });

  test("malformed JSON falls back to defaults and reports an issue", () => {
    const config = readExtensionConfig(agentDirWith("{ not json"));
    expect(config.mode).toBe("notes");
    expect(config.configIssue).toBe("invalid");
  });

  test("an unreadable path (a directory) reports an issue, not a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "ec-config-test-"));
    dirs.push(dir);
    mkdirSync(join(dir, "early-compaction", "config.json"), { recursive: true });
    const config = readExtensionConfig(dir);
    expect(config.mode).toBe("notes");
    expect(config.configIssue).toBe("unreadable");
  });
});

describe("resolveExtensionConfig", () => {
  test("a non-object value reports an issue", () => {
    expect(resolveExtensionConfig([1, 2]).configIssue).toBe("invalid");
    expect(resolveExtensionConfig("x").configIssue).toBe("invalid");
  });

  test("an unknown schema version reports an issue and keeps defaults", () => {
    const config = resolveExtensionConfig({ schema: 2, mode: "rewrite" });
    expect(config.configIssue).toBe("invalid");
    expect(config.mode).toBe("notes");
  });

  test("an invalid policy keeps the valid mode, defaults the policy, and reports", () => {
    const config = resolveExtensionConfig({
      mode: "rewrite",
      policy: { definitelyNotAKey: 1 },
    });
    expect(config.configIssue).toBe("invalid");
    expect(config.mode).toBe("rewrite");
  });
});
