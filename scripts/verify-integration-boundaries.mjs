import "dotenv/config";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const sources = ["app", "features", "components", "hooks", "lib", "server"].flatMap(dir => files(join(root, dir))).filter(file => /\.(?:tsx?|jsx?)$/.test(file) && !file.endsWith(".d.ts"));
const parsed = new Map(sources.map(file => [file, ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)]));
const directive = (source, value) => source.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === value);
function dependencies(source) {
  const result = [];
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly || clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(e => e.isTypeOnly)) return;
      result.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) result.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source); return result;
}
function resolveLocal(from, specifier) {
  const base = specifier.startsWith("@/") ? join(root, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  return base && [base, ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].map(ext => base + ext)].find(file => parsed.has(file));
}
const clients = [...parsed].filter(([, source]) => directive(source, "use client")).map(([file]) => file);
const visited = new Set();
function inspect(file) {
  if (visited.has(file)) return;
  visited.add(file); const source = parsed.get(file);
  // Next compiles server action imports into references, not browser implementations.
  if (directive(source, "use server")) return;
  const deps = dependencies(source);
  if (deps.includes("server-only")) failures.push(`Server-only implementation reachable from client: ${relative(root, file)}`);
  for (const dependency of deps) { const target = resolveLocal(file, dependency); if (target) inspect(target); }
}
clients.forEach(inspect);
for (const [file, source] of parsed) {
  if (!file.startsWith(join(root, "server/agents/"))) continue;
  for (const dependency of dependencies(source)) {
    const target = resolveLocal(file, dependency);
    if (target && /server\/(?:drive|academic-integrations|integrations)\/|server\/calendar\/(?:google|service|writes)\./.test(relative(root, target))) failures.push(`Provider-specific agent dependency: ${relative(root, file)}`);
  }
}
const bundles = files(join(root, ".next/static")).filter(file => /\.(js|map)$/.test(file));
if (!bundles.length) failures.push("Production client bundle missing; run npm run build first.");
const secrets = ["GOOGLE_INTEGRATION_CLIENT_SECRET", "INTEGRATION_TOKEN_KEYS", "OPENAI_API_KEY", "BETTER_AUTH_SECRET", "DATABASE_URL"].flatMap(name => process.env[name] && process.env[name].length >= 8 ? [[name, process.env[name]]] : []);
try { for (const key of Object.values(JSON.parse(process.env.INTEGRATION_TOKEN_KEYS ?? "{}"))) if (typeof key === "string" && key.length >= 8) secrets.push(["integration encryption key", key]); } catch { failures.push("Invalid token key configuration"); }
for (const file of bundles) {
  const text = readFileSync(file, "utf8");
  if (/AesTokenEncryptionService|GOOGLE_INTEGRATION_CLIENT_SECRET|INTEGRATION_TOKEN_KEYS|codeVerifierEncrypted|refreshLeaseToken/.test(text)) failures.push(`Server credential implementation in client bundle: ${relative(root, file)}`);
  for (const [name, value] of secrets) if (text.includes(value)) failures.push(`Configured ${name} value in client bundle: ${relative(root, file)}`);
}
if (failures.length) { failures.forEach(failure => console.error(failure)); process.exitCode = 1; }
else console.log(`Integration boundary audit passed: ${clients.length} client entrypoints, ${visited.size} reachable source modules, ${bundles.length} production bundles; no provider-specific agent imports or credential implementation/values found.`);
