import "server-only";
import { auth } from "@/server/auth/config";
import { assertCourse, getDocument } from "@/server/documents/service";
import { NotFoundError } from "@/server/services/academic";
import {
  assignmentContext,
  courseContext,
  documentContext,
  examContext,
  memoryContext,
  profileContext,
  type CategoryInput,
} from "./categories";
import { contextSchema, ContextError } from "./validation";
import type {
  ContextCategory,
  ContextData,
  ContextRequest,
  UserContext,
} from "./types";

const categories: ContextCategory[] = [
  "profile",
  "course",
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
    clip: (value, max) => {
      if (value.length <= max) return value;
      truncated.add(category);
      return value.slice(0, max - 1) + "…";
    },
  });
  // Only selected loaders execute. Adding a category does not alter the other loaders.
  const loaders: Record<ContextCategory, () => Promise<void>> = {
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
      unavailable.push("learning");
    },
  };
  await Promise.all(requested.map((category) => loaders[category]()));
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
  return {
    ...data,
    metadata: {
      generatedAt: now.toISOString(),
      requestedCategories: requested,
      unavailableCategories: categories.filter((category) =>
        unavailable.includes(category),
      ),
      truncatedCategories: categories.filter((category) =>
        truncated.has(category),
      ),
      estimatedContextSize,
      estimatedTokens: Math.ceil(estimatedContextSize / 4),
      maxCharacters: input.options.limits.maxCharacters,
    },
  };
}
