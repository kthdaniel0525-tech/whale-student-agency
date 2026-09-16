import "server-only";
import type { ContextCategory, ContextData } from "./types";
import type { CategoryInput } from "./categories";

type Entry = { category: ContextCategory; key: string; expires: number; value: ContextData[ContextCategory]; truncated: boolean; unavailable: boolean };
/** A short-lived server capability, scoped to one workflow. Never accept this
 * object or prepared context in a public request body. Auth still runs on hits. */
export class ContextReadCache {
  private entries: Entry[] = [];
  invalidate(categories?: readonly ContextCategory[]) {
    this.entries = categories ? this.entries.filter((entry) => !categories.includes(entry.category)) : [];
  }
  async read(category: ContextCategory, args: CategoryInput, load: () => Promise<Omit<Entry, "key" | "category" | "expires">>) {
    const { input, userId, semester } = args;
    const o = input.options;
    const scope = { userId, courseId: input.courseId, examId: input.examId, assignmentId: input.assignmentId,
      assignmentRevision: args.selectedAssignment?.updatedAt.toISOString(), projectIds: input.projectIds, semester };
    const key = JSON.stringify(category === "profile" ? { userId } : category === "course" ? { userId, courseId: input.courseId } : category === "learning"
      ? { ...scope, limit: o.limits.learning, names: args.examTopicNames ?? [] }
      : category === "memories" ? { userId, request: input.request, categories: o.memoryCategories, keys: o.memoryKeys, limit: o.limits.memories }
      : { ...scope, options: o, ...(category === "documents" ? { request: input.request, documentIds: input.documentIds } : {}) });
    this.entries = this.entries.filter((entry) => entry.expires > Date.now());
    let existing = this.entries.find((entry) => entry.category === category && entry.key === key);
    if (!existing && category === "learning" && !args.examTopicNames?.length) {
      existing = this.entries.find((entry) => {
        if (entry.category !== category) return false;
        const previous = JSON.parse(entry.key);
        return previous.userId === userId && previous.courseId === input.courseId && previous.semester === semester && previous.limit >= o.limits.learning;
      });
    }
    if (existing) {
      const result = structuredClone(existing);
      if (category === "learning" && result.value) {
        const learning = result.value as NonNullable<ContextData["learning"]>;
        learning.weakTopics = learning.weakTopics.slice(0, o.limits.learning);
        learning.strongTopics = learning.strongTopics.slice(0, o.limits.learning);
        learning.recommendedTopics = learning.recommendedTopics.slice(0, o.limits.learning);
        if (!args.examTopicNames?.length) delete learning.examTopics;
      }
      return result;
    }
    const result = await load();
    this.entries.push({ ...structuredClone(result), category, key, expires: Date.now() + 60000 });
    if (this.entries.length > 64) this.entries.shift();
    return result;
  }
}
