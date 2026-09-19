import "server-only";
import { bindUsageOwner } from "../ai/usage/context";
import { availabilityContext } from "./availability";
import { auth } from "@/server/auth/config";
import { assertCourse, getDocument } from "@/server/documents/service";
import { getAssignment, getExam, NotFoundError } from "@/server/services/academic";
import type { ContextReadCache } from "./cache";
import {
  assignmentContext,
  courseContext,
  documentContext,
  examContext,
  learningContext,
  memoryContext,
  profileContext,
  type CategoryInput,
} from "./categories";
import { contextSchema, ContextError } from "./validation";
import { academicOverviewContext } from "./academic-overview";
import { careerContext } from "./career";
import type {
  ContextCategory,
  ContextData,
  ContextRequest,
  UserContext,
} from "./types";

const categories: ContextCategory[] = [
  "availability",
  "profile",
  "course",
  "career",
  "academicOverview",
  "assignments",
  "exams",
  "documents",
  "memories",
  "learning",
];

/** Call from a server route/service with the incoming request's headers; never accept a client userId. */
export async function buildUserContext(
  request: ContextRequest,
  requestHeaders: Headers,
  cache?: ContextReadCache,
): Promise<UserContext> {
  const session = await auth().api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: true },
  });
  if (!session) throw new ContextError("UNAUTHENTICATED");
  const parsed = contextSchema.safeParse(request);
  if (!parsed.success) throw new ContextError("INVALID_REQUEST");
  const input = parsed.data;
  const userId = session.user.id;
  let selectedExamTopics: string[] | undefined;
  const selectedAssignment = input.assignmentId ? await getAssignment(userId, input.assignmentId) : undefined;
  if (selectedAssignment) {
    if (input.courseId && selectedAssignment.courseId !== input.courseId) throw new NotFoundError();
    input.courseId = selectedAssignment.courseId;
  }
  if (input.examId) {
    const exam = await getExam(userId, input.examId);
    if (input.courseId && exam.courseId !== input.courseId) throw new NotFoundError();
    input.courseId = exam.courseId;
    selectedExamTopics = exam.topics.slice(0, 100);
  }
  // Scope is authorized even when its corresponding output category is disabled.
  if (input.courseId) await assertCourse(userId, input.courseId);
  if (input.documentIds)
    for (const id of input.documentIds) {
      const document = await getDocument(userId, id);
      if (input.courseId && document.courseId !== input.courseId)
        throw new NotFoundError();
    }
  const now = new Date();
  const data: ContextData = {};
  const unavailable: ContextCategory[] = [];
  const truncated = new Set<ContextCategory>();
  const requested = categories.filter((category) => input.options[category]);
  const args = (category: ContextCategory): CategoryInput => ({
    userId,
    input,
    now,
    selectedAssignment,
    ...(input.options.academicOverview && !input.courseId && data.profile?.semester
      ? { semester: data.profile.semester } : {}),
    ...(input.options.academicOverview || selectedExamTopics ? {
      examTopicNames: selectedExamTopics ?? [...new Set(data.exams?.flatMap((exam) => exam.topics) ?? [])].slice(0, 100),
    } : {}),
    clip: (value, max) => {
      if (value.length <= max) return value;
      truncated.add(category);
      return value.slice(0, max - 1) + "…";
    },
  });
  // Only selected loaders execute. Adding a category does not alter the other loaders.
  const loaders: Record<ContextCategory, () => Promise<void>> = {
    availability: async () => {
      data.availability = await availabilityContext(args("availability"), data);
      if (["unavailable", "partial"].includes(data.availability.status)) unavailable.push("availability");
    },
    career: async () => {
      data.career = await careerContext(args("career"));
      if (data.career.limitations.length) truncated.add("career");
    },
    profile: async () => {
      data.profile = await profileContext(args("profile"));
      if (!data.profile) unavailable.push("profile");
    },
    course: async () => {
      data.course = await courseContext(args("course"));
      if (!data.course) unavailable.push("course");
    },
    assignments: async () => {
      data.assignments = await assignmentContext(args("assignments"));
    },
    exams: async () => {
      data.exams = await examContext(args("exams"));
    },
    documents: async () => {
      data.documents = await documentContext(args("documents"));
    },
    memories: async () => {
      data.memories = await memoryContext(args("memories"));
    },
    learning: async () => {
      data.learning = await learningContext(args("learning"));
      if (!data.learning) unavailable.push("learning");
    },
    academicOverview: async () => {
      data.academicOverview = await academicOverviewContext(args("academicOverview"), data);
      // Readiness has consumed exact exam-topic evidence; avoid duplicating it in prompts.
      if (data.learning) delete data.learning.examTopics;
    },
  };
  if (cache) {
    for (const category of categories) {
      const load = loaders[category];
      loaders[category] = async () => {
        const result = await cache.read(category, args(category), async () => {
          await load();
          return { value: data[category], truncated: truncated.has(category), unavailable: unavailable.includes(category) };
        });
        Object.assign(data, { [category]: result.value });
        if (result.truncated) truncated.add(category);
        if (result.unavailable && !unavailable.includes(category)) unavailable.push(category);
      };
    }
  }
  if (input.options.academicOverview) {
    // Profile establishes semester/timezone; deadlines establish exact readiness topics.
    await loaders.profile();
    const prerequisites = new Set([...requested, "assignments", "exams"] as ContextCategory[]);
    await Promise.all([...prerequisites].filter((category) => !["profile", "learning", "academicOverview", "availability"].includes(category)).map((category) => loaders[category]()));
    await loaders.learning();
    await loaders.academicOverview();
    if (data.learning) delete data.learning.examTopics;
    for (const category of ["profile", "assignments", "exams", "learning"] as const) {
      if (!input.options[category]) delete data[category];
    }
  } else {
    await Promise.all(requested.filter(category => category !== "availability").map((category) => loaders[category]()));
  }
  if (input.options.availability) await loaders.availability();
  const size = () => JSON.stringify(data).length;
  // Deterministic budget: keep profile/course first, then nearest deadlines and highest-ranked passages.
  for (const category of [...categories].reverse()) {
    if (size() <= input.options.limits.maxCharacters) break;
    const value = data[category];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      while (value.length && size() > input.options.limits.maxCharacters) {
        value.pop();
        truncated.add(category);
      }
    } else {
      delete data[category];
      truncated.add(category);
    }
  }
  const estimatedContextSize = size();
  return bindUsageOwner({
    ...data,
    metadata: {
      generatedAt: now.toISOString(),
      requestedCategories: requested,
      unavailableCategories: categories.filter((category) =>
        requested.includes(category) && unavailable.includes(category),
      ),
      truncatedCategories: categories.filter((category) =>
        truncated.has(category),
      ),
      estimatedContextSize,
      estimatedTokens: Math.ceil(estimatedContextSize / 4),
      maxCharacters: input.options.limits.maxCharacters,
    },
  }, userId);
}
