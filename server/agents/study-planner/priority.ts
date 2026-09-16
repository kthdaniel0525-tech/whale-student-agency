import "server-only";
import type {
  AssignmentContext,
  ExamContext,
  LearningTopicContext,
  UserContext,
} from "../../context/types";
import type {
  PlanningBrief,
  PlanningBriefOptions,
  PlanningPriorityLevel,
  PlanningSignal,
  PlanningSignalInput,
  StudyActivityType,
  StudyAvailability,
} from "./types";
import type { PersonalizationProfile } from "../../personalization";

const DAY = 86_400_000;
const MINIMUM_SESSION = 15;
const MAXIMUM_HORIZON_DAYS = 90;

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number): number {
  return Math.round(clamp(value));
}

export function planningPriorityLevel(score: number): PlanningPriorityLevel {
  if (score >= 80) return "urgent";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function addDays(value: string, amount: number): string {
  return dateOnly(new Date(parseDate(value).getTime() + amount * DAY));
}

function daysBetween(from: string, to: string): number {
  return Math.ceil((parseDate(to).getTime() - parseDate(from).getTime()) / DAY);
}

function allDates(start: string, end: string): string[] {
  const count = daysBetween(start, end);
  return Array.from({ length: count + 1 }, (_, index) => addDays(start, index));
}

function todayAt(date: Date, timezone: string | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return dateOnly(date);
  }
}

function urgencyFor(dueDate: string, startDate: string): number {
  const days = daysBetween(startDate, dueDate.slice(0, 10));
  if (days < 0) return 100;
  if (days === 0) return 100;
  if (days === 1) return 94;
  if (days <= 3) return 84;
  if (days <= 7) return 70;
  if (days <= 14) return 52;
  if (days <= 30) return 32;
  if (days <= 60) return 18;
  return 8;
}

function daysSince(value: string | null, startDate: string): number {
  if (!value) return 90;
  return Math.max(0, daysBetween(value.slice(0, 10), startDate));
}

function learningTopics(context: UserContext["learning"]): LearningTopicContext[] {
  if (!context) return [];
  const topics = new Map<string, LearningTopicContext>();
  for (const topic of [
    ...context.recommendedTopics,
    ...context.weakTopics,
    ...context.strongTopics,
  ]) {
    if (!topics.has(topic.topicId)) topics.set(topic.topicId, topic);
  }
  return [...topics.values()];
}

function suggestedTopicActivity(topic: LearningTopicContext): {
  suggested: StudyActivityType;
  allowed: readonly StudyActivityType[];
} {
  if (topic.confidence < 45) {
    return {
      suggested: "quiz",
      allowed: ["quiz", "practice", "mixed-practice"],
    };
  }
  if (topic.mastery < 40) {
    return {
      suggested: "learn",
      allowed: ["learn", "review", "practice", "quiz"],
    };
  }
  if (topic.mastery < 70) {
    return {
      suggested: "practice",
      allowed: ["review", "practice", "quiz", "mixed-practice"],
    };
  }
  if (topic.confidence < 65) {
    return {
      suggested: "quiz",
      allowed: ["quiz", "practice", "mixed-practice"],
    };
  }
  return {
    suggested: "review",
    allowed: ["review", "quiz", "mixed-practice", "notes-review"],
  };
}

function topicSignal(
  topic: LearningTopicContext,
  exams: readonly ExamContext[],
  assignments: readonly AssignmentContext[],
  startDate: string,
): PlanningSignal {
  const courseExams = exams.filter((exam) => exam.course.id === topic.course.id);
  const namedExams = courseExams.filter((exam) =>
    exam.topics.some((name) => normalize(name) === normalize(topic.topic)),
  );
  const linkedExam = [...(namedExams.length ? namedExams : courseExams)].sort(
    (a, b) => a.examDate.localeCompare(b.examDate),
  )[0];
  const courseAssignments = assignments.filter(
    (assignment) => assignment.course.id === topic.course.id,
  );
  const deadlineUrgency = Math.max(
    linkedExam ? urgencyFor(linkedExam.examDate, startDate) : 0,
    ...courseAssignments.map((item) => urgencyFor(item.dueDate, startDate) * 0.65),
  );
  const confidenceFactor = 0.45 + 0.55 * (topic.confidence / 100);
  const weakness = topic.questionsAttempted
    ? clamp((100 - topic.mastery) * confidenceFactor)
    : 35;
  const confidenceNeed = 100 - topic.confidence;
  const trend =
    topic.trend === "declining"
      ? 100
      : topic.trend === "improving"
        ? 15
        : topic.trend === "stable"
          ? 40
          : 60;
  const staleness = clamp((daysSince(topic.lastPracticedAt, startDate) / 60) * 100);
  const importance = namedExams.length ? 100 : linkedExam ? 72 : 45;
  const score = round(
    0.28 * deadlineUrgency +
      0.34 * weakness +
      0.14 * confidenceNeed +
      0.1 * trend +
      0.08 * staleness +
      0.06 * importance,
  );
  const activity = suggestedTopicActivity(topic);
  const reason =
    topic.confidence < 45
      ? `${topic.topic} has ${topic.mastery}% mastery but only ${topic.confidence}% confidence, so diagnostic practice should come first${linkedExam ? ` before ${linkedExam.title}` : ""}.`
      : `${topic.topic} mastery is ${topic.mastery}% with ${topic.confidence}% confidence${topic.trend === "declining" ? " and a declining trend" : ""}${linkedExam ? `; ${linkedExam.title} is in ${Math.max(0, daysBetween(startDate, linkedExam.examDate.slice(0, 10)))} days` : ""}.`;
  return {
    id: `topic:${topic.topicId}`,
    kind: "topic",
    courseId: topic.course.id,
    courseName: `${topic.course.courseCode} ${topic.course.courseName}`.trim(),
    topicId: topic.topicId,
    topic: topic.topic,
    linkedExamId: linkedExam?.id ?? null,
    linkedAssignmentId: null,
    priorityScore: score,
    priority: planningPriorityLevel(score),
    urgency: round(deadlineUrgency),
    weakness: round(weakness),
    confidenceNeed: round(confidenceNeed),
    trend,
    staleness: round(staleness),
    importance,
    suggestedActivity: activity.suggested,
    allowedActivities: activity.allowed,
    reason,
    sourceDueDate: linkedExam?.examDate ?? null,
    sourceMasteryScore: topic.mastery,
    sourceConfidenceScore: topic.confidence,
    targetMinutes: 0,
  };
}

function examSignal(
  exam: ExamContext,
  topics: readonly LearningTopicContext[],
  startDate: string,
): PlanningSignal {
  const related = topics.filter((topic) => topic.course.id === exam.course.id);
  const averageNeed = related.length
    ? related.reduce(
        (sum, topic) =>
          sum +
          (100 - topic.mastery) * (0.45 + 0.55 * (topic.confidence / 100)),
        0,
      ) / related.length
    : 50;
  const urgency = urgencyFor(exam.examDate, startDate);
  const confidenceNeed = related.length
    ? related.reduce((sum, topic) => sum + 100 - topic.confidence, 0) /
      related.length
    : 50;
  const score = round(0.62 * urgency + 0.28 * averageNeed + 0.1 * confidenceNeed);
  return {
    id: `exam:${exam.id}`,
    kind: "exam",
    courseId: exam.course.id,
    courseName: `${exam.course.courseCode} ${exam.course.courseName}`.trim(),
    topicId: null,
    topic: exam.topics.length ? exam.topics.slice(0, 3).join(", ") : null,
    linkedExamId: exam.id,
    linkedAssignmentId: null,
    priorityScore: score,
    priority: planningPriorityLevel(score),
    urgency,
    weakness: round(averageNeed),
    confidenceNeed: round(confidenceNeed),
    trend: 0,
    staleness: 0,
    importance: 90,
    suggestedActivity: "exam-review",
    allowedActivities: ["exam-review", "mixed-practice", "quiz", "review"],
    reason: `${exam.title} is in ${Math.max(0, daysBetween(startDate, exam.examDate.slice(0, 10)))} days; course learning need is ${round(averageNeed)}%.`,
    sourceDueDate: exam.examDate,
    sourceMasteryScore: null,
    sourceConfidenceScore: null,
    targetMinutes: 0,
  };
}

function assignmentSignal(
  assignment: AssignmentContext,
  startDate: string,
): PlanningSignal {
  const urgency = urgencyFor(assignment.dueDate, startDate);
  const importance =
    assignment.priority === "HIGH"
      ? 100
      : assignment.priority === "MEDIUM"
        ? 65
        : 35;
  const effort = clamp((assignment.estimatedHours / 8) * 100);
  const score = round(0.58 * urgency + 0.27 * importance + 0.15 * effort);
  const due = Math.max(0, daysBetween(startDate, assignment.dueDate.slice(0, 10)));
  return {
    id: `assignment:${assignment.id}`,
    kind: "assignment",
    courseId: assignment.course.id,
    courseName: `${assignment.course.courseCode} ${assignment.course.courseName}`.trim(),
    topicId: null,
    topic: null,
    linkedExamId: null,
    linkedAssignmentId: assignment.id,
    priorityScore: score,
    priority: planningPriorityLevel(score),
    urgency,
    weakness: 0,
    confidenceNeed: 0,
    trend: 0,
    staleness: 0,
    importance,
    suggestedActivity: "assignment",
    allowedActivities: ["assignment"],
    reason: assignment.overdue
      ? `${assignment.title} is overdue, ${assignment.priority.toLowerCase()} priority, and estimated at ${assignment.estimatedHours} hours.`
      : `${assignment.title} is due in ${due} days, ${assignment.priority.toLowerCase()} priority, and estimated at ${assignment.estimatedHours} hours.`,
    sourceDueDate: assignment.dueDate,
    sourceMasteryScore: null,
    sourceConfidenceScore: null,
    targetMinutes: 0,
  };
}

function allocateTargets(
  rawSignals: readonly PlanningSignal[],
  availableMinutes: number,
): PlanningSignal[] {
  if (availableMinutes < MINIMUM_SESSION) {
    return rawSignals
      .slice()
      .sort((a, b) => b.priorityScore - a.priorityScore || a.id.localeCompare(b.id))
      .slice(0, 1)
      .map((signal) => ({ ...signal, targetMinutes: 0 }));
  }
  const maximumSignals = Math.max(1, Math.floor(availableMinutes / MINIMUM_SESSION));
  const signals = rawSignals
    .slice()
    .sort((a, b) => b.priorityScore - a.priorityScore || a.id.localeCompare(b.id))
    .slice(0, Math.min(24, maximumSignals));
  const allocatable = Math.floor(availableMinutes / MINIMUM_SESSION) * MINIMUM_SESSION;
  const minutes = new Map(signals.map((signal) => [signal.id, MINIMUM_SESSION]));
  let remaining = allocatable - signals.length * MINIMUM_SESSION;
  while (remaining >= MINIMUM_SESSION && signals.length) {
    const selected = signals.reduce((best, signal) => {
      const ratio = (minutes.get(signal.id) ?? 0) / Math.max(10, signal.priorityScore);
      const bestRatio = (minutes.get(best.id) ?? 0) / Math.max(10, best.priorityScore);
      return ratio < bestRatio || (ratio === bestRatio && signal.priorityScore > best.priorityScore)
        ? signal
        : best;
    });
    minutes.set(selected.id, (minutes.get(selected.id) ?? 0) + MINIMUM_SESSION);
    remaining -= MINIMUM_SESSION;
  }
  return signals.map((signal) => ({
    ...signal,
    targetMinutes: minutes.get(signal.id) ?? 0,
  }));
}

/** Deterministic academic and learning priority signals supplied to the model. */
export function calculatePlanningSignals(input: PlanningSignalInput): PlanningSignal[] {
  const topics = learningTopics(input.learning);
  const signals: PlanningSignal[] = [
    ...input.assignments.map((item) => assignmentSignal(item, input.startDate)),
    ...input.exams.map((item) => examSignal(item, topics, input.startDate)),
    ...topics.map((item) =>
      topicSignal(item, input.exams, input.assignments, input.startDate),
    ),
  ];
  if (!signals.length) {
    signals.push({
      id: "general:review",
      kind: "general",
      courseId: null,
      courseName: null,
      topicId: null,
      topic: null,
      linkedExamId: null,
      linkedAssignmentId: null,
      priorityScore: 35,
      priority: "medium",
      urgency: 0,
      weakness: 0,
      confidenceNeed: 50,
      trend: 0,
      staleness: 50,
      importance: 35,
      suggestedActivity: "review",
      allowedActivities: ["review", "practice", "notes-review", "mixed-practice"],
      reason: "No current deadline or reliable learning evidence is available, so use a focused course review.",
      sourceDueDate: null,
      sourceMasteryScore: null,
      sourceConfidenceScore: null,
      targetMinutes: 0,
    });
  }
  return allocateTargets(signals, input.totalAvailableMinutes);
}

function requestedMinutes(request: string): number | undefined {
  const match = request.toLowerCase().match(
    /\b(?:only\s+)?(?:have\s+)?(\d+(?:\.\d+)?|one|two|three|four|five|six)\s+hours?\b/,
  );
  if (match) {
    const words: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
    };
    const hours = words[match[1]] ?? Number(match[1]);
    return clamp(Math.round(hours * 60), MINIMUM_SESSION, 720);
  }
  const minutes = request.toLowerCase().match(/\b(\d{2,3})\s+minutes?\b/);
  return minutes ? clamp(Number(minutes[1]), MINIMUM_SESSION, 720) : undefined;
}

function sessionPreference(
  context: UserContext,
  personalization: Readonly<PersonalizationProfile> | undefined,
  supplied?: number,
): number {
  if (supplied) return supplied;
  if (personalization?.studySessionMinutes)
    return personalization.studySessionMinutes.value;
  // Direct callers that do not execute an Agent still retain the explicit profile default.
  if (context.profile?.studySessionMinutes)
    return context.profile.studySessionMinutes;
  return 45;
}

function inferEndDate(
  startDate: string,
  request: string,
  context: UserContext,
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

function availabilityFor(
  startDate: string,
  endDate: string,
  options: PlanningBriefOptions,
  defaultMinutes: number,
): { availability: StudyAvailability[]; assumptions: string[] } {
  const dates = allDates(startDate, endDate);
  const supplied = new Map(options.availability?.map((item) => [item.date, item.availableMinutes]));
  const requestMinutes = requestedMinutes(options.request);
  const assumptions: string[] = [];
  const availability = dates.map((date) => {
    let minutes: number;
    if (options.mode === "now" && options.availableMinutes !== undefined) {
      minutes = options.availableMinutes;
    } else if (supplied.size) {
      minutes = supplied.get(date) ?? 0;
    } else if (requestMinutes !== undefined && dates.length === 1) {
      minutes = requestMinutes;
    } else {
      minutes = clamp(defaultMinutes * 2, 60, 180);
    }
    const reserved = options.reservedMinutesByDate?.[date] ?? 0;
    return { date, availableMinutes: Math.max(0, minutes - reserved) };
  });
  if (!supplied.size && requestMinutes === undefined && options.availableMinutes === undefined) {
    assumptions.push(
      `Assumed ${clamp(defaultMinutes * 2, 60, 180)} available study minutes per day because no availability was provided.`,
    );
  }
  if (Object.keys(options.reservedMinutesByDate ?? {}).length) {
    assumptions.push("Completed sessions were kept and deducted from the affected dates' availability.");
  }
  return { availability, assumptions };
}

/** Builds a bounded plan horizon and attaches deterministic priority signals. */
export function createPlanningBrief(
  context: UserContext,
  options: PlanningBriefOptions,
  personalization?: Readonly<PersonalizationProfile>,
): PlanningBrief {
  const generatedAt = new Date(context.metadata.generatedAt);
  const today = todayAt(
    Number.isNaN(generatedAt.getTime()) ? new Date() : generatedAt,
    context.profile?.timezone,
  );
  const availabilityDates = options.availability?.map((item) => item.date).sort();
  const startDate = options.startDate ?? availabilityDates?.[0] ?? today;
  let endDate =
    options.mode === "now"
      ? startDate
      : options.endDate ??
        availabilityDates?.at(-1) ??
        inferEndDate(startDate, options.request, context);
  if (endDate < startDate) endDate = startDate;
  if (daysBetween(startDate, endDate) > MAXIMUM_HORIZON_DAYS) {
    endDate = addDays(startDate, MAXIMUM_HORIZON_DAYS);
  }
  const preferredSessionMinutes = sessionPreference(
    context,
    personalization,
    options.preferredSessionMinutes,
  );
  const personalizedMaximum = personalization?.maxContinuousMinutes?.value;
  const maximumSessionMinutes = options.intensive
    ? 180
    : Math.min(
        120,
        Math.max(
          MINIMUM_SESSION,
          personalizedMaximum ?? Math.max(90, preferredSessionMinutes),
        ),
      );
  const availabilityResult = availabilityFor(
    startDate,
    endDate,
    options,
    preferredSessionMinutes,
  );
  const totalAvailableMinutes = availabilityResult.availability.reduce(
    (sum, item) => sum + item.availableMinutes,
    0,
  );
  const signals = calculatePlanningSignals({
    assignments: context.assignments ?? [],
    exams: context.exams ?? [],
    learning: context.learning,
    startDate,
    totalAvailableMinutes,
  });
  return {
    mode: options.mode,
    startDate,
    endDate,
    availability: availabilityResult.availability,
    preferredSessionMinutes,
    maximumSessionMinutes,
    totalAvailableMinutes,
    assumptions: availabilityResult.assumptions,
    signals: options.mode === "now" ? signals.slice(0, 5) : signals,
  };
}
