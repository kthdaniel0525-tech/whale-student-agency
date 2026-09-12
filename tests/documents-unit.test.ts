import { describe, expect, it } from "vitest";
import { chunkPages } from "@/server/documents/chunking";
import { extractPages, validateFile } from "@/server/documents/extraction";
import { validateEmbedding } from "@/server/documents/embeddings";
import { storage } from "@/server/documents/storage/local";
import { inductionPages, textPdf } from "./fixtures/documents";
describe("document parsing and chunking", () => {
  it("extracts real PDF text with page boundaries", async () => {
    const pages = await extractPages(textPdf(inductionPages), "PDF");
    expect(pages).toHaveLength(2);
    expect(pages[0].content).toContain("base case");
    expect(pages[1]).toMatchObject({
      pageNumber: 2,
      content: expect.stringContaining("inductive hypothesis"),
    });
  });
  it("rejects disguised binary, unsupported types, traversal and false PDF signatures", async () => {
    const text = new TextEncoder().encode("Some academic text");
    for (const name of [
      "../lecture.txt",
      "x\\lecture.txt",
      "lecture.exe",
      "lecture.pdf",
    ])
      expect(() => validateFile(name, text)).toThrow();
    expect(() =>
      validateFile("lecture.md", new Uint8Array([0, 1, 2])),
    ).toThrow();
    expect(() => validateFile("lecture.txt", new Uint8Array([255]))).toThrow();
    expect(() => validateFile("lecture.txt", new Uint8Array())).toThrow();
    expect(() =>
      validateFile("lecture.txt", new Uint8Array(10 * 1024 * 1024 + 1)),
    ).toThrow();
    await expect(storage.get("../.env")).rejects.toThrow(
      "Invalid document storage",
    );
    expect(validateFile("lecture.md", text)).toBe("MARKDOWN");
  });
  it("preserves all non-whitespace source text around punctuation and long sentences", () => {
    const text =
      "Sentence without a separating space.Next sentence. Price 3.14!網址https://a.b/test?中文沒有空格。下一句！".repeat(
        100,
      );
    const chunks = chunkPages([{ pageNumber: 7, content: text }], 700, 0);
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks
        .map((c) => c.content)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(text.replace(/\s/g, ""));
    expect(chunks.every((c) => c.pageNumber === 7 && c.pageEnd === 7)).toBe(
      true,
    );
    const long = "a".repeat(13000);
    expect(
      chunkPages([{ pageNumber: 1, content: long }], 700, 0)
        .map((c) => c.content)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(long);
  });
  it("keeps practical overlap, source ranges and bounded chunk sizes", () => {
    const chunks = chunkPages(
      Array.from({ length: 5 }, (_, i) => ({
        pageNumber: i + 1,
        content: (
          "A useful paragraph about mathematical induction and proofs. ".repeat(
            20,
          ) + "\n\n"
        ).repeat(2),
      })),
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(
      chunks.every(
        (c, i) =>
          c.chunkIndex === i &&
          c.tokenCount <= 1000 &&
          c.pageEnd >= c.pageNumber,
      ),
    ).toBe(true);
    expect(chunks.some((c) => c.pageNumber < c.pageEnd)).toBe(true);
    expect(chunks[1].content.slice(0, 150)).toBeTruthy();
    expect(chunks[0].content).toContain(chunks[1].content.split("\n\n")[0]);
  });
  it("fails unreadable PDF safely and validates finite embedding dimensions", async () => {
    await expect(
      extractPages(new TextEncoder().encode("%PDF-invalid"), "PDF"),
    ).rejects.toThrow("encrypted or damaged");
    for (const vector of [[], Array(384).fill(0), Array(384).fill(NaN)])
      expect(() => validateEmbedding(vector)).toThrow();
    expect(
      validateEmbedding(Array(384).fill(1)).reduce((s, x) => s + x * x, 0),
    ).toBeCloseTo(1);
  });
});
