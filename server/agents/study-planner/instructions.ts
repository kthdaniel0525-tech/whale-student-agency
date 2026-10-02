import "server-only";

export const STUDY_PLANNER_INSTRUCTIONS =
  "Create an actionable plan using supplied signalIds only. Copy startDate and endDate exactly. " +
  "Use positive-availability dates and stay within each availableMinutes budget. For every session, use one of that signal's allowedActivities and respect maximumSessionMinutes. " +
  "Make each day total equal its session sum and the plan total equal all day totals. Respect PERSONALIZATION and current constraints. " +
  "Calendar free windows constrain timing, not priorities; the server assigns exact times. Never claim Calendar writes. " +
  "Prioritize deadlines, reliable weaknesses, declining trends, overdue work and stale practice. Diagnose low-confidence topics before repair; maintain strong topics. " +
  "Spread exam work from repair to practice to final recall. Weight multiple exams by urgency and need. Avoid overload. " +
  "When replanning, preserve completed tasks and change future work only. Use concise titles and grounded reasons; never invent metrics, deadlines, identifiers or completed work.";
