import "server-only";
import { WorkflowError } from "./errors";
import { normalizeTopicName } from "../learning/normalization";
import type { LearningTopicContext } from "../context/types";
import type { WorkflowContext, WorkflowDefinition } from "./types";

export function examDecisions(context: WorkflowContext, topics: LearningTopicContext[]) {
  if (!context.exam) throw new WorkflowError("INVALID_REQUEST");
  const names = new Set(context.exam.topics.map(normalizeTopicName));
  const relevant = topics.filter((topic) => topic.course.id === context.courseId && (!names.size || names.has(normalizeTopicName(topic.topic))));
  const weak = relevant.filter((topic) => topic.mastery < 70 && topic.confidence >= 60 && topic.questionsAttempted >= 3)
    .sort((a, b) => (100 - b.mastery + (b.trend === "declining" ? 10 : 0)) - (100 - a.mastery + (a.trend === "declining" ? 10 : 0)));
  const low = relevant.filter((topic) => topic.confidence < 40 || topic.questionsAttempted < 3).map((topic) => topic.topic);
  const unknown = context.exam.topics.filter((name) => !relevant.some((topic) => normalizeTopicName(topic.topic) === normalizeTopicName(name)));
  const diagnostic = [...new Set([...unknown, ...low])];
  const targetTopics = (diagnostic.length ? diagnostic : weak.length ? weak.map((topic) => topic.topic) : context.exam.topics.length ? context.exam.topics : relevant.map((topic) => topic.topic)).slice(0, 3);
  return { topics: relevant.slice(0, 10), tutorTopic: weak[0]?.topic ?? null, quizMode: diagnostic.length || !relevant.length ? "diagnostic" as const : "practice" as const, targetTopics };
}

const quizInput = (context: Readonly<WorkflowContext>) => ({
  request: `Create a quiz for ${context.quizMode} exam preparation. Use recent accuracy, mastery, confidence and trends in the supplied learning context. ${context.quizMode === "diagnostic" ? "Identify current understanding without assuming low mastery." : "Practice weak concepts and include brief retention checks."} Target topics: ${context.targetTopics.join(", ").slice(0, 360)}.`,
  topic: context.targetTopics.join(", ").slice(0, 200) || context.exam?.title.slice(0, 200) || "Exam topics",
});
export const examPreparation: WorkflowDefinition = {
  id: "exam-preparation", name: "Exam Preparation", description: "Prepare for a selected exam using academic state, a current plan, and focused learning support.",
  intents: ["prepare for my exam", "prepare for my midterm"],
  maxSteps: 5, maxAgentCalls: 2, maxRetries: 1, maxDurationMs: 300000, failurePolicy: "fail-workflow",
  steps: [
    { id: "analyze", agentId: "academic-manager", purpose: "Analyze readiness and priorities for the selected exam.", outputKey: "analysis",
      input: (c) => ({ request: `Give an academic overview for the selected exam. Goal: ${c.goal.slice(0, 600)}` }) },
    { id: "plan", agentId: "study-planner", purpose: "Create or update the relevant study plan while preserving completed work.", outputKey: "plan",
      condition: (c) => ({ run: !c.planCurrent, reason: "The active exam plan remains current and fits availability." }),
      input: (c) => ({ request: `${c.studyPlanId ? "Update my study plan" : "Create a study plan"} for the selected exam. Focus on ${c.targetTopics.join(", ").slice(0, 300) || "exam coverage"}. Academic priority: ${c.priorities[0]?.reason.slice(0, 200) ?? "Prepare before the exam date"}. Goal: ${c.goal.slice(0, 200)}` }),
      invalidates: ["academicOverview"] },
    { id: "diagnostic", agentId: "quiz", purpose: "Generate a useful diagnostic quiz for uncertain topics.", outputKey: "diagnostic",
      condition: (c) => ({ run: c.quizMode === "diagnostic" && !c.quizCurrent, reason: c.quizCurrent ? "A relevant unfinished quiz is already available." : "Confidence supports practice rather than another diagnostic." }),
      input: quizInput, invalidates: ["learning", "academicOverview"] },
    { id: "tutor", agentId: "tutor", purpose: "Explain a demonstrated weak concept before further practice.", outputKey: "explanation", failurePolicy: "continue-with-warning",
      condition: (c) => ({ run: Boolean(c.tutorTopic), reason: "No high-confidence weak concept currently needs an explanation." }),
      input: (c) => ({ request: `Explain ${c.tutorTopic} for the selected exam. Use the student's learning state and a worked example. Check common misconceptions.`, topic: c.tutorTopic ?? undefined }) },
    { id: "practice", agentId: "quiz", purpose: "Generate focused practice after weak-concept support.", outputKey: "practice",
      condition: (c) => ({ run: c.quizMode === "practice" && !c.quizCurrent, reason: c.quizCurrent ? "A relevant unfinished quiz is already available." : "A diagnostic is more useful before further practice." }),
      input: quizInput, invalidates: ["learning", "academicOverview"] },
  ],
};
