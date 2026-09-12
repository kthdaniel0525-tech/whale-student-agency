import "server-only";
import {
  DocumentError,
  MAX_FILE_BYTES,
  MAX_PAGES,
  MAX_TEXT_CHARS,
} from "../config";
export type ExtractedPage = { pageNumber: number; content: string };
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
  if (name.length > 200 || /[\/\\\x00-\x1f]/.test(name))
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
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: bytes,
    enableXfa: false,
    useWorkerFetch: false,
    useSystemFonts: true,
    stopAtErrors: true,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES)
      throw new DocumentError("PDFs can contain up to 200 pages.");
    const pages: ExtractedPage[] = [];
    let size = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const text = await page.getTextContent();
      const content = clean(
        text.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join(""),
      );
      size += content.length;
      if (size > MAX_TEXT_CHARS)
        throw new DocumentError(
          "Extracted text exceeds the 400,000-character limit.",
        );
      pages.push({ pageNumber: index, content });
      page.cleanup();
    }
    if (pages.every((page) => page.content.length < 10))
      throw new DocumentError(
        "No readable text found. Scanned PDFs need OCR before upload.",
      );
    return pages;
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    throw new DocumentError(
      "This PDF could not be read. It may be encrypted or damaged.",
    );
  } finally {
    await task.destroy();
  }
}
