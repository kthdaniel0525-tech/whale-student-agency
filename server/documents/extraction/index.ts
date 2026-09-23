import "server-only";
import {
  DocumentError,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
} from "../config";
import { extractPdfPages } from "./pdf-worker";
export type ExtractedPage = { pageNumber: number; content: string };
export function validateUploadMime(name: string, mime: string) {
  const type = mime.trim().toLowerCase().split(";")[0];
  if (!type || type === "application/octet-stream") return;
  const extension = name.split(".").pop()?.toLowerCase();
  const allowed = extension === "pdf" ? ["application/pdf"] :
    extension === "txt" ? ["text/plain"] : ["text/plain", "text/markdown", "text/x-markdown"];
  if (!allowed.includes(type))
    throw new DocumentError("The file type does not match its supported format.", 415);
}
function clean(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function validateFile(name: string, bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES)
    throw new DocumentError("Choose a non-empty file up to 10 MB.", 413);
  if (name.length > 200 || /[\/\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name))
    throw new DocumentError("Choose a file with a simple filename.");
  const extension = name.split(".").pop()?.toLowerCase();
  const signature = new TextDecoder().decode(bytes.slice(0, 5));
  if (extension === "pdf") {
    if (signature !== "%PDF-")
      throw new DocumentError("The file does not have a valid PDF signature.");
    return "PDF" as const;
  }
  if (!["txt", "md", "markdown"].includes(extension || ""))
    throw new DocumentError("Supported formats are PDF, TXT and Markdown.");
  if (signature === "%PDF-")
    throw new DocumentError("Rename this PDF with a .pdf extension.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentError("Text files must use UTF-8 encoding.");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new DocumentError("Binary files are not supported.");
  return extension === "txt" ? ("TXT" as const) : ("MARKDOWN" as const);
}
export async function extractPages(
  bytes: Uint8Array,
  fileType: string,
): Promise<ExtractedPage[]> {
  if (fileType !== "PDF") {
    const content = clean(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!content || content.length > MAX_TEXT_CHARS)
      throw new DocumentError(
        "The text is empty or exceeds the 400,000-character limit.",
      );
    return [{ pageNumber: 1, content }];
  }
  return extractPdfPages(bytes);
}
