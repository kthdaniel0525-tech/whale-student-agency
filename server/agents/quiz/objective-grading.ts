export function normalizedAnswer(value: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (["t", "yes"].includes(normalized)) return "true";
  if (["f", "no"].includes(normalized)) return "false";
  return normalized;
}

export function gradeObjectiveAnswer(answer: string, expected: string) {
  const correct = normalizedAnswer(answer) === normalizedAnswer(expected);
  return { correct, score: correct ? 1 : 0 };
}
