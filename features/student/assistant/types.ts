export type AssistantAgentId =
  | "auto"
  | "tutor"
  | "notes"
  | "quiz"
  | "study-planner"
  | "academic-manager"
  | "career";

export type AssistantContextItem = {
  id: string;
  title: string;
  subtitle?: string;
  courseId?: string | null;
};

export type AssistantCourse = AssistantContextItem & {
  courseCode: string;
  courseName: string;
  documents: AssistantContextItem[];
  assignments: AssistantContextItem[];
  exams: AssistantContextItem[];
};

export type AssistantConversationSummary = {
  id: string;
  title: string | null;
  courseId: string | null;
  courseName: string | null;
  messageCount: number;
  lastMessageAt: string;
};

export type AssistantRecommendation = {
  id: string;
  title: string;
  message: string;
  priority: "low" | "medium" | "high" | "critical";
};

export type AssistantBootstrap = {
  courses: AssistantCourse[];
  conversations: AssistantConversationSummary[];
  recommendations: AssistantRecommendation[];
};

export type AssistantMessage = {
  id: string;
  turnId: string | null;
  role: "user" | "assistant";
  content: string;
  agentId: string | null;
  createdAt: string;
  metadata: Record<string, string | number | boolean | null> | null;
  presentation?: AssistantPresentation;
};

export type AssistantSource = {
  documentId: string;
  documentTitle: string;
  pageNumber?: number | null;
  pageEnd?: number | null;
  courseCode?: string | null;
  chunkIndex: number;
};

export type AssistantPresentation = {
  kind: "agent" | "workflow" | "clarification" | "error";
  targetId?: string;
  targetName?: string;
  structuredData?: unknown;
  workflow?: AssistantWorkflow;
  quiz?: AssistantQuiz;
  studyPlan?: AssistantStudyPlan;
  sources?: AssistantSource[];
};

export type AssistantConversation = AssistantConversationSummary & {
  messages: AssistantMessage[];
};

export type AssistantRequestPayload = {
  request: string;
  conversationId?: string;
  turnId: string;
  courseId?: string;
  documentIds?: string[];
  assignmentId?: string;
  examId?: string;
  topicId?: string;
  topicName?: string;
  studyPlanId?: string;
  preferredAgentId?: Exclude<AssistantAgentId, "auto">;
  preferredWorkflowId?: string;
};

export type AssistantLaunch = Omit<
  AssistantRequestPayload,
  "turnId" | "conversationId"
>;

export type AssistantRequestResponse = {
  conversation: AssistantConversationSummary;
  userMessage: AssistantMessage;
  assistantMessage: AssistantMessage;
};

export type AssistantQuizQuestion = {
  id: string;
  type: "multiple-choice" | "true-false" | "short-answer" | "long-answer";
  prompt: string;
  choices: readonly string[] | null;
  topics: readonly string[];
};

export type AssistantQuiz = {
  id: string;
  title: string;
  topic: string | null;
  difficulty: string;
  questions: readonly AssistantQuizQuestion[];
};

export type AssistantQuizEvaluation = {
  quizId: string;
  questionId: string;
  quizAttemptId: string;
  correct: boolean;
  score: number;
  feedback: string;
  explanation: string;
};

export type AssistantStudyTask = {
  id: string;
  date: string;
  title: string;
  courseName: string | null;
  topic: string | null;
  activityType: string;
  durationMinutes: number;
  priority: number;
  status: "planned" | "in-progress" | "completed" | "skipped";
  reason: string;
};

export type AssistantStudyPlan = {
  id?: string;
  title?: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  summary: string;
  totalMinutes?: number;
  totalPlannedMinutes?: number;
  assumptions?: readonly string[];
  sessions?: readonly Omit<AssistantStudyTask, "id" | "status">[];
  days?: readonly { date: string; totalMinutes: number; sessions: readonly AssistantStudyTask[] }[];
};

export type AssistantWorkflow = {
  runId: string;
  workflowId: string;
  status: "pending" | "running" | "waiting-for-input" | "completed" | "failed" | "cancelled";
  summary: string;
  completedSteps: string[];
  steps: Array<{
    stepId: string;
    agentId: string;
    status: string;
    outputSummary: string | null;
    errorCode: string | null;
  }>;
  warnings: string[];
  errorCode: string | null;
  recommendedNextAction: string;
  waitingFor?: { kind: "quiz" | "student-work" | "career-data"; referenceId: string } | null;
};
