import "server-only";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { DocumentError, MAX_FILE_BYTES, MAX_PAGES, MAX_TEXT_CHARS } from "../config";
import type { ExtractedPage } from "./index";

const errors = {
  pages: "PDFs can contain up to 200 pages.",
  text: "Extracted text exceeds the 400,000-character limit.",
  empty: "No readable text found. Scanned PDFs need OCR before upload.",
  parser: "This PDF could not be read. It may be encrypted or damaged.",
  budget: "This PDF exceeded the safe processing limit. Try a smaller PDF.",
} as const;

// Static, trusted code. PDF bytes are worker data, never executable source. A
// worker deadline can interrupt synchronous parser loops that Promise.race cannot.
const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  let task;
  try {
    const { getDocument } = await import(workerData.moduleUrl);
    task = getDocument({ data: workerData.bytes, enableXfa: false,
      useWorkerFetch: false, useSystemFonts: false, disableFontFace: true,
      isEvalSupported: false, stopAtErrors: true, verbosity: 0 });
    const pdf = await task.promise;
    if (pdf.numPages > workerData.maxPages) throw "pages";
    const pages = []; let size = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      // Check accumulated input before joining/normalizing a large text array.
      const stream = page.streamTextContent();
      const reader = stream.getReader(); const parts = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        for (const item of value.items) if ("str" in item) {
          size += item.str.length;
          if (size > workerData.maxChars) { await reader.cancel(); throw "text"; }
          parts.push(item.str + (item.hasEOL ? "\n" : " "));
        }
      }
      const content = parts.join("").replace(/\r\n?/g, "\n")
        .replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n").trim();
      pages.push({ pageNumber: index, content }); page.cleanup();
    }
    if (pages.every(page => page.content.length < 10)) throw "empty";
    parentPort.postMessage({ pages });
  } catch (error) {
    parentPort.postMessage({ error: ["pages", "text", "empty"].includes(error) ? error : "parser" });
  } finally { if (task) await task.destroy(); }
})();`;

/** Heap caps do not cover every native allocation: production workers also need
 * an OS/container memory limit. No secrets or provider credentials enter this worker. */
export async function extractPdfPages(bytes: Uint8Array, timeoutMs = 20_000): Promise<ExtractedPage[]> {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES)
    throw new DocumentError("Choose a non-empty file up to 10 MB.", 413);
  // Use Node's runtime resolver: Turbopack rewrites a statically imported
  // createRequire(...).resolve(...) to a module ID instead of a filesystem path.
  // next.config.ts explicitly traces this dynamically resolved worker dependency.
  // Anchor to the deployed app, since Webpack inlines import.meta.url with the
  // build machine's source path. Both Node lookups must remain runtime operations.
  const runtimePackage = process.getBuiltinModule("path").join(process.cwd(), "package.json");
  const nodeRequire = process.getBuiltinModule("module").createRequire(runtimePackage);
  const moduleUrl = pathToFileURL(nodeRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true, env: {}, stdout: true, stderr: true,
      workerData: { moduleUrl, bytes, maxPages: MAX_PAGES, maxChars: MAX_TEXT_CHARS },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    // Parser diagnostics can contain document text; discard rather than forward.
    worker.stdout?.resume(); worker.stderr?.resume();
    let settled = false;
    const finish = (error?: keyof typeof errors, pages?: ExtractedPage[]) => {
      if (settled) return; settled = true;
      clearTimeout(timer); void worker.terminate().catch(() => {});
      if (error) reject(new DocumentError(errors[error])); else resolve(pages!);
    };
    const timer = setTimeout(() => finish("budget"), Math.max(1, Math.min(timeoutMs, 20_000)));
    worker.once("message", (result: { error?: keyof typeof errors; pages?: ExtractedPage[] }) => {
      if (result.error) finish(result.error in errors ? result.error : "parser");
      else if (Array.isArray(result.pages)) finish(undefined, result.pages);
      else finish("parser");
    });
    worker.once("error", () => finish("budget"));
    worker.once("exit", () => finish("parser"));
  });
}
