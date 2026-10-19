// Import guard: every module specifier under src/ must be relative, a
// node:* builtin, or exactly one of the two extension-loader roots.
// Any deeper path (e.g. "@code-yeongyu/senpi/dist/...") fails.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Optional argv[2] lets tests run the guard against a temp fixture tree.
const SRC = process.argv[2]
  ? resolve(process.argv[2])
  : join(fileURLToPath(new URL("..", import.meta.url)), "src");

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
const DYNAMIC_TEMPLATE_RE = /import\s*\(\s*`((?:[^`\\]|\\.)*)`\s*\)/g;

function staticAndQuotedDynamic(clean) {
  const out = [];
  for (const re of [STATIC_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) out.push(m[1]);
  }
  return out;
}

// Template-literal dynamic imports: a substitution-free template is its plain
// specifier. A template WITH substitutions fails when any literal chunk carries
// an allowed-root-plus-slash prefix, or when the fixed head before the first
// ${} is not a relative path, a node: builtin, or exactly an allowed root.
function checkTemplateBody(body) {
  const sub = body.indexOf("${");
  if (sub === -1) return isAllowed(body) ? null : body;
  for (const root of ALLOWED_ROOTS) {
    if (body.includes(root + "/")) return body;
  }
  const head = body.slice(0, sub);
  if (head.startsWith(".") || head.startsWith("node:")) return null;
  if (ALLOWED_ROOTS.has(head)) return null;
  return body;
}

function templateViolations(clean) {
  const out = [];
  DYNAMIC_TEMPLATE_RE.lastIndex = 0;
  let m;
  while ((m = DYNAMIC_TEMPLATE_RE.exec(clean)) !== null) {
    if (checkTemplateBody(m[1]) !== null) out.push("`" + m[1] + "`");
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
  const clean = stripComments(text);
  for (const spec of staticAndQuotedDynamic(clean)) {
    if (!isAllowed(spec)) failures.push({ file, spec });
  }
  for (const spec of templateViolations(clean)) failures.push({ file, spec });
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
