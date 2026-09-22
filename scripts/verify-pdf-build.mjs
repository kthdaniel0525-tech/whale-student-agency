// Run after npm run build: node --import tsx scripts/verify-pdf-build.mjs
// Source tests cannot catch Turbopack replacing require.resolve with module IDs.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inductionPages, textPdf } from "../tests/fixtures/documents.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const entry = resolve(root, ".next/server/app/api/student/documents/route.js");
// Register the route's compiled chunks without executing the route/auth/DB code.
// Discover the parser's generated ID rather than relying on a particular build.
let parserId;
let parserCode;
let parserExports;
const webpackRuntime = resolve(root, ".next/server/webpack-runtime.js");
if (existsSync(webpackRuntime)) {
  const runtime = require(webpackRuntime);
  const chunks = resolve(root, ".next/server/chunks");
  for (const file of readdirSync(chunks).filter((file) => file.endsWith(".js"))) {
    const chunk = require(resolve(chunks, file));
    if (chunk.modules) runtime.C(chunk);
  }
  // Webpack puts Node builtin wrappers in route entrypoints. Register only those
  // wrappers; executing an entrypoint would also initialize auth and DB services.
  const app = resolve(root, ".next/server/app");
  for (const file of readdirSync(app, { recursive: true }).filter((file) => file.endsWith("route.js"))) {
    const code = readFileSync(resolve(app, file), "utf8");
    for (const [, id, , specifier] of code.matchAll(/(\d+):([A-Za-z_$][\w$]*)=>\{\2\.exports=require\("([^"]+)"\)\}/g)) {
      if (isBuiltin(specifier)) runtime.m[id] = (module) => { module.exports = require(specifier); };
    }
  }
  for (const [id, factory] of Object.entries(runtime.m)) {
    if (factory.toString().includes("safe processing limit")) {
      parserId = id;
      parserCode = factory.toString();
      parserExports = runtime(id);
      break;
    }
  }
} else {
  const runtime = require(resolve(root, ".next/server/chunks/[turbopack]_runtime.js"))(
    "server/app/api/student/documents/route.js",
  );
  for (const [, relative] of readFileSync(entry, "utf8").matchAll(/R\.c\("([^"]+)"\)/g)) {
    runtime.c(relative);
    const registrations = require(resolve(root, ".next", relative));
    let id;
    for (const item of registrations) {
      if (typeof item !== "function") { id = item; continue; }
      const code = item.toString();
      if (code.includes("safe processing limit") && code.includes("extractPages")) {
        parserId = id;
        parserCode = code;
      }
    }
  }
  if (parserId !== undefined) parserExports = runtime.m(parserId).exports;
}
assert.notEqual(parserId, undefined, "Compiled PDF parser module must exist");
assert.ok(!parserCode.includes(pathToFileURL(root).href), "PDF resolver must not embed the build machine's source path");
// Webpack minifies exported names; extractPages is the parser's async export.
const extractPages = parserExports.extractPages ?? Object.values(parserExports).find(
  (value) => typeof value === "function" && value.constructor.name === "AsyncFunction",
);
assert.equal(typeof extractPages, "function");
const bytes = textPdf(inductionPages);
const pages = await extractPages(bytes, "PDF");
assert.equal(pages.length, 2);
assert.match(pages[0].content, /base case/);
assert.match(pages[1].content, /inductive hypothesis/);
assert.ok(bytes.length > 0, "The worker must preserve the caller's bytes");
await assert.rejects(
  extractPages(new TextEncoder().encode("%PDF-invalid"), "PDF"),
  /encrypted or damaged/,
);
await assert.rejects(
  extractPages(textPdf(Array.from({ length: 201 }, () => ["A valid academic page with readable text."])), "PDF"),
  /200 pages/,
);

const trace = JSON.parse(readFileSync(`${entry}.nft.json`, "utf8"));
const traced = new Set(trace.files.map((path) => resolve(dirname(entry), path)));
for (const path of [
  "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "node_modules/pdfjs-dist/package.json",
  "node_modules/@napi-rs/canvas/index.js",
  "node_modules/@napi-rs/canvas/js-binding.js",
  "node_modules/@napi-rs/canvas/geometry.js",
]) assert.ok(traced.has(resolve(root, path)), `Missing runtime file in production trace: ${path}`);
assert.ok(
  [...traced].some((path) => /@napi-rs\/canvas-[^/]+\/[^/]+\.node$/.test(path)),
  "Missing native canvas binary in production trace",
);
console.log("Production PDF parser passed: real text, safe failures, page limit, and deployment dependencies.");
