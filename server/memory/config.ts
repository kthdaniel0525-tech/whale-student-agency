import type { MemoryCategory } from "./types";

export const MEMORY_CONFIG = Object.freeze({
  defaultRetrievalLimit: 5,
  maximumRetrievalLimit: 10,
  maximumActiveMemories: 100,
  maximumObservationsPerMemory: 20,
  promotionEvidenceCount: 3,
  promotionDominance: 0.6,
  explicitConfidence: 95,
  maximumInferredConfidence: 85,
  staleAfterDays: {
    preference: 365,
    "academic-goal": 180,
    "career-goal": 365,
    "learning-pattern": 180,
    "successful-strategy": 240,
    "user-defined": 180,
  } satisfies Record<MemoryCategory, number>,
});

export const MEMORY_DEFAULT_IMPORTANCE: Readonly<Record<MemoryCategory, number>> =
  Object.freeze({
    preference: 75,
    "academic-goal": 90,
    "career-goal": 90,
    "learning-pattern": 70,
    "successful-strategy": 80,
    "user-defined": 60,
  });

