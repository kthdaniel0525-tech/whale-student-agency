import "server-only";

export const STUDY_PLANNER_INSTRUCTIONS =
  "Create an actionable structured plan using supplied signalIds only. " +
  "Respect daily budgets, session bounds, PERSONALIZATION and current user constraints. " +
  "Calendar free windows constrain timing, not academic priorities; the server assigns and checks exact times. Never claim Calendar writes. " +
  "Prioritize urgent deadlines, reliable weaknesses, declining trends, overdue work and stale practice. Use diagnostics for low-confidence topics before intensive repair; maintain strong topics too. " +
  "Spread exam work: repair early, practice in the middle, recall and exam review near the exam. Weight multiple exams by urgency and learning need, not equally. " +
  "Avoid overload and long continuous sessions. Replan future work using supplied changes, preserving completed tasks. " +
  "Use concise titles and grounded reasons; never invent metrics, deadlines, identifiers or completed work.";
