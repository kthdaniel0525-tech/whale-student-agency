import "server-only";
import path from "node:path";
import { z } from "zod";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 400000;
export const MAX_PAGES = 200;
export const MAX_CHUNKS = 256;
export function documentConfig() {
  const env = z
    .object({
      DOCUMENT_STORAGE_PATH: z.string().optional(),
      EMBEDDING_CACHE_PATH: z.string().optional(),
      RAG_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.35),
    })
    .parse(process.env);
  // These are runtime volumes, never build assets or deployment trace inputs.
  const storage = path.resolve(
    /* turbopackIgnore: true */ env.DOCUMENT_STORAGE_PATH || ".local/documents",
  );
  if (
    storage === path.resolve("public") ||
    storage.startsWith(path.resolve("public") + path.sep)
  )
    throw Error("Document storage must be private.");
  return {
    storage,
    modelCache: path.resolve(
      /* turbopackIgnore: true */ env.EMBEDDING_CACHE_PATH || ".local/models",
    ),
    similarity: env.RAG_MIN_SIMILARITY,
  };
}
export class DocumentError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
