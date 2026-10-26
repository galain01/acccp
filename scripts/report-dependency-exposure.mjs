// Read-only: node scripts/report-dependency-exposure.mjs [repository-root]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
if (process.argv.length > 3) throw new Error("Expected at most one repository-root argument");
const ts = createRequire(join(root, "package.json"))("typescript");
const targets = [
  "@esbuild-kit/core-utils", "@esbuild-kit/esm-loader", "@modelcontextprotocol/sdk",
  "@vitest/mocker", "body-parser", "brace-expansion", "drizzle-kit", "esbuild",
  "fast-uri", "hono", "ip-address", "proxy-addr", "shadcn", "source-map-js",
  "tinypool", "undici", "vite", "vitest", "zod",
];
const roots = ["app", "lib", "components", "contexts", "hooks"];
const rootEntry = /^(?:middleware|proxy|instrumentation(?:-client)?)\./;
const slash = (value) => value.split(sep).join("/");
const local = (value) => slash(relative(root, value));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const scope = (file) => file.match(/^\.next\/(server|static|build)\//)?.[1] ?? "framework";
const errors = [], skippedSymlinks = [], externalMapSections = [], inventory = [];
const counts = { traces: 0, maps: 0, indexedSections: 0, sourceEntries: 0, sourceMapsByScope: {} };
const routeEntries = [], routeReferences = new Map();

function packageName(specifier) {
  const parts = specifier.split("/");
  const name = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return targets.includes(name) ? name : null;
}
function packagePaths(value) {
  try { value = decodeURIComponent(value); } catch { /* Retain undecodable text. */ }
  return [...value.replaceAll("\\", "/").matchAll(/(?:^|\/)node_modules\/((?:@[^/\s]+\/)?[^/\s?#]+)/g)]
    .map((match) => match[1]).filter((name) => targets.includes(name));
}
async function walk(directory, optional = false) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (!optional || error.code !== "ENOENT") errors.push({ file: local(directory), code: error.code });
    return [];
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", ".git", ".next"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) skippedSymlinks.push(local(path));
    else if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const lockBytes = await readFile(join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const packages = new Map(targets.map((name) => [name, {
  package: name,
  lockedVersions: [...new Set(Object.entries(lock.packages ?? {})
    .filter(([path]) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length) === name)
    .map(([, entry]) => entry.version))].sort(),
  sourceImports: [], traces: [], mappedModules: [],
}]));
const sourceFiles = [];
for (const directory of roots) sourceFiles.push(...await walk(join(root, directory), true));
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && rootEntry.test(entry.name)) sourceFiles.push(join(root, entry.name));
}
const runtimeFiles = sourceFiles.sort().filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/\.(?:test|spec)\.|[/\\]__tests__[/\\]/.test(file));
for (const file of runtimeFiles) {
  const ast = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) errors.push({ file: local(file), code: "SOURCE_PARSE_DIAGNOSTIC", count: ast.parseDiagnostics.length });
  const visit = (node) => {
    let literal, kind;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal = node.moduleSpecifier; kind = ts.isImportDeclaration(node) ? "import" : "export-from";
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal = node.moduleReference.expression; kind = "import-equals";
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) kind = "dynamic-import";
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") kind = "require";
      else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" && node.expression.name.text === "resolve") kind = "require-resolve";
      if (kind) literal = node.arguments[0];
    }
    if (literal && ts.isStringLiteralLike(literal)) {
      const name = packageName(literal.text);
      if (name) packages.get(name).sourceImports.push({ file: local(file), line: ast.getLineAndCharacterOfPosition(literal.getStart(ast)).line + 1, kind, specifier: literal.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

let buildId = null;
try { buildId = (await readFile(join(root, ".next/BUILD_ID"), "utf8")).trim(); }
catch (error) { errors.push({ file: ".next/BUILD_ID", code: error.code }); }
for (const path of await walk(join(root, ".next"))) {
  if (!/\.nft\.json$|\.map$/.test(path)) continue;
  const file = local(path), bytes = await readFile(path);
  inventory.push(`${file} ${hash(bytes)}`);
  try {
    const data = JSON.parse(bytes.toString("utf8"));
    if (file.endsWith(".nft.json")) {
      counts.traces++;
      const route = file.startsWith(".next/server/app/") ? "/" + file.slice(17).replace(/(?:^|\/)(?:page|route)\.js\.nft\.json$/, "") : null;
      if (route !== null) routeEntries.push({ route, trace: file });
      const found = new Map();
      for (const entry of data.files) {
        const resolved = local(resolve(dirname(path), entry));
        if (route !== null) {
          if (!routeReferences.has(resolved)) routeReferences.set(resolved, new Set());
          routeReferences.get(resolved).add(route);
        }
        for (const name of packagePaths(resolved)) {
          if (!found.has(name)) found.set(name, []);
          found.get(name).push(resolved);
        }
      }
      for (const [name, entries] of found) packages.get(name).traces.push({ file, scope: scope(file), route, count: entries.length, examples: entries.slice(0, 3) });
    } else {
      counts.maps++;
      counts.sourceMapsByScope[scope(file)] = (counts.sourceMapsByScope[scope(file)] ?? 0) + 1;
      const sources = [];
      const visit = (map) => {
        sources.push(...map.sources ?? []);
        for (const section of map.sections ?? []) {
          counts.indexedSections++;
          if (section.map) visit(section.map);
          else if (section.url) externalMapSections.push({ file, url: section.url });
        }
      };
      visit(data);
      counts.sourceEntries += sources.length;
      for (const name of targets) {
        const matches = sources.filter((source) => packagePaths(source).includes(name));
        if (matches.length) packages.get(name).mappedModules.push({ file, scope: scope(file), count: matches.length, examples: matches.slice(0, 3) });
      }
    }
  } catch (error) { errors.push({ file, code: "BUILD_PARSE_ERROR", message: String(error.message).slice(0, 120) }); }
}
for (const report of packages.values()) {
  for (const mappedModule of report.mappedModules) mappedModule.routes = [...routeReferences.get(mappedModule.file.slice(0, -4)) ?? []].sort();
}
console.log(JSON.stringify({
  schemaVersion: 1,
  repository: { root, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(), packageLockSha256: hash(lockBytes) },
  build: { id: buildId, counts, routes: routeEntries, traceAndMapInventorySha256: hash(inventory.sort().join("\n")), inventoryHashFormat: "Sorted relative path + space + SHA-256 of bytes; LF joined, no trailing LF" },
  source: { runtimeFiles: runtimeFiles.length, includesUntrackedFiles: true, typescript: ts.version, roots: [...roots, "middleware", "proxy", "instrumentation", "instrumentation-client"] },
  positiveControl: { zodServerEvidence: [...packages.get("zod").traces, ...packages.get("zod").mappedModules].some((entry) => entry.scope === "server") },
  packages: [...packages.values()],
  coverage: { errors, skippedSymlinks, externalMapSections, compiledJavaScriptScanned: false },
  limitations: [
    "This describes local source and an existing build, not a deployment or exploitability. HEAD does not establish which source created the build.",
    "Source AST scan includes tracked/untracked non-test files in the stated roots. Other roots and computed imports are excluded; type-only/unreachable imports remain evidence. Framework-name strings are ignored.",
    "NFT traces and maps may omit dynamic or unrepresented paths. Compiled JavaScript is not parsed; client bundles without maps are not covered. Absence is not proof of unreachability; an empty routes list is not proof of no route use.",
    "Package attribution matches named node_modules package paths; vendored copies such as next/dist/compiled/* are not inventoried completely.",
    "Symlinks and indexed-map external URLs are reported without following them. The existing TypeScript parser is loaded, but no application modules, helpers, services or network calls execute.",
    "Node-bundled Undici, native/container components and hosted runtime/configuration are outside this package-lock report.",
  ],
}, null, 2));
