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

export type AssistantActionTarget = "agent" | "workflow";
export type AssistantActionStyle = "primary" | "secondary" | "quiet";

/** A provider-independent action supplied to interactive result components. */
export type AssistantAction = {
  id: string;
  label: string;
  targetType: AssistantActionTarget;
  targetId: string;
  prompt: string;
  payload?: {
    courseId?: string;
    documentIds?: string[];
    assignmentId?: string;
    examId?: string;
    topicId?: string;
    topicName?: string;
    studyPlanId?: string;
    projectIds?: string[];
    targetRole?: string;
    targetIndustry?: string;
    targetCompanies?: string[];
    applicationTimeline?: string;
    availableWeeklyMinutes?: number;
  };
  style?: AssistantActionStyle;
  confirmationRequired?: boolean;
};

export type AssistantSource = {
  documentId: string;
  documentTitle: string;
  pageNumber?: number | null;
  pageEnd?: number | null;
  courseCode?: string | null;
  chunkIndex: number;
};

/** Normalized result contract used by all Agent and Workflow renderers. */
export type AIResult = {
  mode: "agent" | "workflow";
  kind: "agent" | "workflow" | "clarification" | "error";
  targetId?: string;
  targetName?: string;
  content?: string;
  structuredData?: unknown;
  workflow?: AssistantWorkflow;
  quiz?: AssistantQuiz;
  studyPlan?: AssistantStudyPlan;
  sources?: AssistantSource[];
  actions?: AssistantAction[];
  status?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type AssistantPresentation = AIResult;

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
  projectIds?: string[];
  targetRole?: string;
  targetIndustry?: string;
  targetCompanies?: string[];
  applicationTimeline?: string;
  availableWeeklyMinutes?: number;
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
  sources?: readonly AssistantSource[];
  attempt?: AssistantQuizAttempt | null;
  adapted?: boolean;
};

export type AssistantQuizEvaluation = {
  quizId: string;
  questionId: string;
  quizAttemptId: string;
  correct: boolean;
  score: number;
  feedback: string;
  explanation: string;
  userAnswer?: string;
  method?: "deterministic" | "semantic";
};

export type AssistantQuizAttempt = {
  id: string;
  completedAt: string | null;
  evaluations: readonly AssistantQuizEvaluation[];
};

export type AssistantStudyTask = {
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  scheduledTimezone?: string | null;
  id: string;
  date: string;
  title: string;
  courseId?: string | null;
  courseName: string | null;
  topicId?: string | null;
  topic: string | null;
  examId?: string | null;
  assignmentId?: string | null;
  activityType: string;
  durationMinutes: number;
  priority: number;
  status: "planned" | "in-progress" | "completed" | "skipped";
  reason: string;
};

export type AssistantPendingInteraction = {
  type: "quiz" | "text" | "long-text" | "confirmation" | "choice";
  title: string;
  description?: string;
  requiredFields?: readonly string[];
  choices?: readonly string[];
  submitLabel: string;
  kind?: "student-work" | "career-data";
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
  status: "pending" | "running" | "waiting-for-input" | "waiting-for-user" | "completed" | "failed" | "cancelled";
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
  pendingInteraction?: AssistantPendingInteraction | null;
};
