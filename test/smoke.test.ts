import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { VERSION, engineBuildIdentity } from "@code-yeongyu/senpi";

const SENPI_PKG =
  "C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/package.json";
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("smoke", () => {
  test("VERSION equals the installed senpi package.json (no hardcoded literal)", () => {
    const pkg = JSON.parse(readFileSync(SENPI_PKG, "utf8"));
    expect(VERSION).toBe(pkg.version);
  });

  test("engine identity recorded; bundle keeps both externals", () => {
    const identity = engineBuildIdentity();
    mkdirSync(join(ROOT, "qa", "out"), { recursive: true });
    writeFileSync(
      join(ROOT, "qa", "out", "engine.json"),
      JSON.stringify({ version: VERSION, identity: identity.text }) + "\n",
      "utf8",
    );

    const dist = join(ROOT, "dist", "early-compaction.js");
    if (!existsSync(dist)) {
      execSync("bun run build", { cwd: ROOT, stdio: "pipe" });
    }
    const js = readFileSync(dist, "utf8");
    expect(js).toContain('from "@code-yeongyu/senpi"');
    expect(js).toContain('from "@earendil-works/pi-ai"');
  });
});
