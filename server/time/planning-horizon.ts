/** Shared planning horizon inference: dates are civil days, never event instants. */
function addDays(day: string, count: number) { return new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10); }
export function inferPlanningEndDate(
  startDate: string,
  request: string,
  context: { exams?: readonly { examDate: string }[] },
  explicit?: string,
): string {
  if (explicit) return explicit;
  const lower = request.toLowerCase();
  if (/\b(?:today|tonight|right now|now)\b/.test(lower)) return startDate;
  const count = lower.match(/\bnext\s+(\d{1,2})\s+days?\b/);
  if (count) return addDays(startDate, Math.max(0, Number(count[1]) - 1));
  if (/\b(?:exam|midterm|final)\b/.test(lower)) {
    const exam = context.exams
      ?.filter((item) => item.examDate.slice(0, 10) >= startDate)
      .sort((a, b) => a.examDate.localeCompare(b.examDate))[0];
    if (exam) return addDays(exam.examDate.slice(0, 10), -1);
    const inDays = lower.match(/\bin\s+(\d{1,2})\s+days?\b/);
    if (inDays) return addDays(startDate, Math.max(0, Number(inDays[1]) - 1));
  }
  return addDays(startDate, /\bweek\b/.test(lower) ? 6 : 6);
}
