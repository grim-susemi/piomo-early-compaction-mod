import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "scripts",
  "check-imports.mjs",
);

function runGuard(dir: string) {
  try {
    const stdout = execFileSync("node", [GUARD, dir], { encoding: "utf8" });
    return { exit: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { exit: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function makeFixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "import-guard-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

const BT = "`"; // backtick, kept out of source literals for readability

describe("import guard", () => {
  test("template-literal deep import fails and names the file", () => {
    const dir = makeFixture({
      "deep-template.ts":
        "export async function load() {\n" +
        "  return await import(" + BT + "@code-yeongyu/senpi/dist/core/agent-session.js" + BT + ");\n" +
        "}\n",
    });
    try {
      const r = runGuard(dir);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("deep-template.ts");
      expect(r.stderr).toContain("@code-yeongyu/senpi/dist/core/agent-session.js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("static deep import still fails", () => {
    const dir = makeFixture({
      "deep-static.ts":
        'import { AgentSession } from "@code-yeongyu/senpi/dist/core/agent-session.js";\nexport const bad = AgentSession;\n',
    });
    try {
      const r = runGuard(dir);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("deep-static.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("template with substitution over a deep path fails", () => {
    const dir = makeFixture({
      "deep-sub.ts":
        "export async function load(entry: string) {\n" +
        "  return await import(" + BT + "@code-yeongyu/senpi/dist/${entry}.js" + BT + ");\n" +
        "}\n",
    });
    try {
      const r = runGuard(dir);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("deep-sub.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("template with a non-allowlist head fails", () => {
    const dir = makeFixture({
      "bad-head.ts":
        "export async function load(name: string) {\n" +
        "  return await import(" + BT + "https://example.com/${name}.js" + BT + ");\n" +
        "}\n",
    });
    try {
      const r = runGuard(dir);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("bad-head.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clean fixture passes", () => {
    const dir = makeFixture({
      "clean.ts":
        'import { VERSION } from "@code-yeongyu/senpi";\n' +
        'import { Type } from "@earendil-works/pi-ai";\n' +
        'import { join } from "node:path";\n' +
        'import { helper } from "./helper";\n' +
        "export async function load(name: string) {\n" +
        "  return await import(" + BT + "./local/${name}.js" + BT + ");\n" +
        "}\n" +
        "export const v = [VERSION, Type, join, helper];\n",
      "helper.ts": "export const helper = 1;\n",
    });
    try {
      const r = runGuard(dir);
      expect(r.exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
