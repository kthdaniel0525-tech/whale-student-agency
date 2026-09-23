import type { ExtractedPage } from "../extraction";
export type TextChunk = {
  content: string;
  chunkIndex: number;
  pageNumber: number;
  pageEnd: number;
  tokenCount: number;
};
// Approximate tokens for packing; the embedding adapter uses its actual tokenizer.
export function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(Array.from(text).length / 4));
}
export function chunkPages(
  pages: ExtractedPage[],
  target = 700,
  overlap = 100,
): TextChunk[] {
  if (target < 100 || overlap < 0 || overlap >= target / 2)
    throw Error("Invalid chunk configuration.");
  const units: { text: string; page: number }[] = [];
  for (const page of pages) {
    const paragraphs = page.content.split(/\n\s*\n/).filter((p) => p.trim());
    for (const paragraph of paragraphs) {
      if (estimateTokens(paragraph) <= target)
        units.push({ text: paragraph, page: page.pageNumber });
      else {
        // Match every character, including punctuation without a following space.
        const sentences = paragraph.match(
          /[^.!?。！？]+[.!?。！？]*|[.!?。！？]+/g,
        ) || [paragraph];
        for (const sentence of sentences) {
          if (estimateTokens(sentence) <= target)
            units.push({ text: sentence.trim(), page: page.pageNumber });
          else {
            const chars = Array.from(sentence);
            for (let i = 0; i < chars.length; i += target * 4)
              units.push({
                text: chars
                  .slice(i, i + target * 4)
                  .join("")
                  .trim(),
                page: page.pageNumber,
              });
          }
        }
      }
    }
  }
  const result: TextChunk[] = [];
  let buffer: typeof units = [];
  let size = 0;
  let hasNew = false;
  const flush = () => {
    const content = buffer.map((unit) => unit.text).join("\n\n");
    result.push({
      content,
      chunkIndex: result.length,
      pageNumber: buffer[0].page,
      pageEnd: buffer[buffer.length - 1].page,
      tokenCount: estimateTokens(content),
    });
  };
  for (const unit of units) {
    if (buffer.length && size + estimateTokens(unit.text) > target) {
      flush();
      const previous = buffer[buffer.length - 1];
      const tail = overlap
        ? Array.from(previous.text)
            .slice(-overlap * 4)
            .join("")
            .replace(/^\S*\s/, "")
        : "";
      buffer = overlap && tail ? [{ text: tail, page: previous.page }] : [];
      size = tail ? estimateTokens(tail) : 0;
      hasNew = false;
    }
    buffer.push(unit);
    size += estimateTokens(unit.text) + 1;
    hasNew = true;
  }
  if (buffer.length && hasNew) {
    if (
      size < 100 &&
      result.length &&
      result[result.length - 1].tokenCount + size < target + overlap + 100
    ) {
      const last = result[result.length - 1];
      last.content += "\n\n" + buffer.map((unit) => unit.text).join("\n\n");
      last.pageEnd = buffer[buffer.length - 1].page;
      last.tokenCount = estimateTokens(last.content);
    } else flush();
  }
  return result;
}
