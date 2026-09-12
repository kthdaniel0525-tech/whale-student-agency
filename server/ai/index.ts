import "server-only";
import { OpenAIProvider } from "./providers/openai";
import type { AIProvider } from "./types";

export type * from "./types";
export { AIError, type AIErrorCode } from "./errors";

let provider: AIProvider | undefined;
export function getAIProvider(): AIProvider {
  return (provider ??= new OpenAIProvider());
}
