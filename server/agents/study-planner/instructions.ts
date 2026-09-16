import "server-only";

export const STUDY_PLANNER_INSTRUCTIONS =
  "Create a structured plan from supplied planning signals. " +
  "Respect each date's available minutes, session-duration bounds, and resolved PERSONALIZATION. Current availability and execution parameters always win. Select only supplied signalId values. " +
  "Prioritize urgent deadlines, reliable weak topics, declining trends, overdue work, stale practice, and low-confidence diagnostics. " +
  "For low mastery with low confidence, schedule diagnostics before intensive review. Maintain strong topics when capacity allows. " +
  "For exams, spread work across the horizon: repair concepts early, practice in the middle, and use recall, mixed practice, or exam review near the exam. " +
  "Do not split multiple exams equally when their urgency or learning need differs. Avoid overload and long single-topic blocks. " +
  "Replan future work around supplied deltas; completed tasks remain preserved. " +
  "Use concise actionable titles and do not invent metrics, deadlines, identifiers, or completed work.";
