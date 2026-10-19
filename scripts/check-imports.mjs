// Import guard: every module specifier under src/ must be relative, a
// node:* builtin, or exactly one of the two extension-loader roots.
// Any deeper path (e.g. "@code-yeongyu/senpi/dist/...") fails.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("..", import.meta.url)), "src");

const ALLOWED_ROOTS = new Set([
  "@code-yeongyu/senpi",
  "@earendil-works/pi-ai",
]);

function isAllowed(spec) {
  if (spec.startsWith(".") || spec.startsWith("node:")) return true;
  return ALLOWED_ROOTS.has(spec);
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\/])\/\/.*$/gm, "$1");
}

const STATIC_RE =
  /(?:import\s+(?:[^'"]*?\sfrom\s+)?|export\s+[^'"]*?\sfrom\s+)['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(text) {
  const out = [];
  const clean = stripComments(text);
  for (const re of [STATIC_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) out.push(m[1]);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const failures = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const spec of specifiersOf(text)) {
    if (!isAllowed(spec)) failures.push({ file, spec });
  }
}

if (failures.length > 0) {
  for (const { file, spec } of failures) {
    console.error(`forbidden import: ${file} -> ${spec}`);
  }
  console.error(
    `${failures.length} forbidden import(s): src/ may only import relative paths, node:* builtins, @code-yeongyu/senpi and @earendil-works/pi-ai (exact roots).`,
  );
  process.exit(1);
}
console.log(`import guard ok: ${walk(SRC).length} file(s) under src/`);
