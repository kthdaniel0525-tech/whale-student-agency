import { LEARNING_CONFIG } from "./constants";

/** Exact normalization only; punctuation and word forms remain distinct. */
export function normalizeTopicName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function prepareTopicNames(values: readonly string[]): {
  readonly name: string;
  readonly normalizedName: string;
}[] {
  const topics = new Map<string, string>();
  for (const raw of values.slice(0, LEARNING_CONFIG.maximumTopicsPerQuestion)) {
    const name = raw.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeTopicName(name);
    if (
      !normalizedName ||
      name.length > LEARNING_CONFIG.maximumTopicNameLength ||
      topics.has(normalizedName)
    ) {
      continue;
    }
    topics.set(normalizedName, name);
  }
  return [...topics].map(([normalizedName, name]) => ({
    name,
    normalizedName,
  }));
}
