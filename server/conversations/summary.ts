import "server-only";
import { z } from "zod";
import type { AIProvider } from "../ai/types";
import { CONVERSATION_CONFIG } from "./config";
import type {
  ConversationMessageRecord,
  ConversationSummaryData,
  ConversationSummaryItem,
} from "./types";

const itemSchema = z
  .object({
    text: z.string().trim().min(1).max(600),
    sourceMessageIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(CONVERSATION_CONFIG.maximumSummarySourcesPerItem),
  })
  .strict();

const summaryDataSchema = z
  .object({
    activeGoals: z.array(itemSchema).max(CONVERSATION_CONFIG.maximumSummaryItemsPerCategory),
    importantFacts: z.array(itemSchema).max(CONVERSATION_CONFIG.maximumSummaryItemsPerCategory),
    decisions: z.array(itemSchema).max(CONVERSATION_CONFIG.maximumSummaryItemsPerCategory),
    unresolvedItems: z.array(itemSchema).max(CONVERSATION_CONFIG.maximumSummaryItemsPerCategory),
    activeResources: z.array(itemSchema).max(CONVERSATION_CONFIG.maximumSummaryItemsPerCategory),
    recentProgress: z.array(itemSchema).max(CONVERSATION_CONFIG.maximumSummaryItemsPerCategory),
    corrections: z.array(itemSchema).max(CONVERSATION_CONFIG.maximumSummaryItemsPerCategory),
    summaryText: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_CONFIG.maximumSummaryTextCharacters),
  })
  .strict();

export function emptyConversationSummary(): ConversationSummaryData {
  return {
    activeGoals: [],
    importantFacts: [],
    decisions: [],
    unresolvedItems: [],
    activeResources: [],
    recentProgress: [],
    corrections: [],
    summaryText: "No earlier conversation has been summarized yet.",
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function deduplicate(items: readonly ConversationSummaryItem[]) {
  const result: ConversationSummaryItem[] = [];
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    const key = normalize(text);
    const existing = result.find((candidate) => normalize(candidate.text) === key);
    if (existing) {
      const index = result.indexOf(existing);
      result[index] = {
        ...existing,
        sourceMessageIds: [
          ...new Set([...existing.sourceMessageIds, ...item.sourceMessageIds]),
        ].slice(0, CONVERSATION_CONFIG.maximumSummarySourcesPerItem),
      };
    } else {
      result.push({
        text: text.slice(0, 600),
        sourceMessageIds: [...new Set(item.sourceMessageIds)].slice(
          0,
          CONVERSATION_CONFIG.maximumSummarySourcesPerItem,
        ),
      });
    }
  }
  return result.slice(0, CONVERSATION_CONFIG.maximumSummaryItemsPerCategory);
}

function deterministicSafeguards(messages: readonly ConversationMessageRecord[]) {
  const importantFacts: ConversationSummaryItem[] = [];
  const activeGoals: ConversationSummaryItem[] = [];
  const decisions: ConversationSummaryItem[] = [];
  const unresolvedItems: ConversationSummaryItem[] = [];
  const activeResources: ConversationSummaryItem[] = [];
  const recentProgress: ConversationSummaryItem[] = [];
  const corrections: ConversationSummaryItem[] = [];
  for (const message of messages) {
    const text = message.content.trim().replace(/\s+/g, " ").slice(0, 600);
    const item = { text, sourceMessageIds: [message.id] };
    if (message.role === "user") {
      if (/\b(?:my goal|i want|i need|trying to|prepare for)\b|목표|준비(?:하고|할)|원해|하고 싶/i.test(text))
        activeGoals.push(item);
      if (/\b(?:must|exactly|require[ds]?|use the|do not|don't|prefer)\b|반드시|정확히|사용해|하지 마|선호/i.test(text))
        importantFacts.push(item);
      if (/\b(?:decided|we will|let's use|choose)\b|결정|선택/i.test(text))
        decisions.push(item);
      if (/\b(?:actually|correction|i meant|instead|changed to)\b|사실|정정|아니고|바꿨어|변경/i.test(text))
        corrections.push(item);
      if (/\b(?:upload|send|provide|waiting|later)\b|업로드|보낼게|제공|기다|나중/i.test(text) || /\?$/.test(text))
        unresolvedItems.push(item);
      if (/\b(?:lecture|document|pdf|assignment|quiz|proof|draft|resume|portfolio|MATH\s*\d+)\b|강의|문서|과제|퀴즈|증명|초안/i.test(text))
        activeResources.push(item);
    } else if (message.role === "assistant" && /\b(?:completed|created|updated|reviewed|explained|generated)\b|완료|생성|수정|검토|설명/i.test(text)) {
      recentProgress.push(item);
    }
  }
  return {
    activeGoals,
    importantFacts,
    decisions,
    unresolvedItems,
    activeResources,
    recentProgress,
    corrections,
  };
}

function correctionSubject(text: string): string | undefined {
  const normalized = normalize(text);
  for (const subject of ["exam", "midterm", "final", "deadline", "due date", "difficulty", "course", "시험", "마감", "난이도", "과목"]) {
    if (normalized.includes(subject)) return subject;
  }
  return undefined;
}

function applyCorrectionPrecedence(data: ConversationSummaryData) {
  const latestBySubject = new Map<string, ConversationSummaryItem>();
  for (const correction of data.corrections) {
    const subject = correctionSubject(correction.text);
    if (subject) latestBySubject.set(subject, correction);
  }
  let importantFacts = [...data.importantFacts];
  let decisions = [...data.decisions];
  let summaryText = data.summaryText;
  for (const [subject, correction] of latestBySubject) {
    const keep = (item: ConversationSummaryItem) =>
      !normalize(item.text).includes(subject) ||
      item.sourceMessageIds.some((id) => correction.sourceMessageIds.includes(id));
    importantFacts = importantFacts.filter(keep);
    decisions = decisions.filter(keep);
    const oldSubject = new RegExp(`[^.!?]*(?:${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})[^.!?]*[.!?]?`, "giu");
    summaryText = summaryText.replace(oldSubject, " ").replace(/\s+/g, " ").trim();
    summaryText = `${summaryText ? summaryText + " " : ""}Latest correction: ${correction.text}`;
  }
  return {
    ...data,
    importantFacts,
    decisions,
    summaryText: summaryText.slice(
      0,
      CONVERSATION_CONFIG.maximumSummaryTextCharacters,
    ),
  };
}

function mergeSafeguards(
  generated: ConversationSummaryData,
  previous: ConversationSummaryData | undefined,
  messages: readonly ConversationMessageRecord[],
): ConversationSummaryData {
  const safeguards = deterministicSafeguards(messages);
  const merged = {
    activeGoals: deduplicate([...generated.activeGoals, ...(previous?.activeGoals ?? []), ...safeguards.activeGoals]),
    importantFacts: deduplicate([...generated.importantFacts, ...(previous?.importantFacts ?? []), ...safeguards.importantFacts]),
    decisions: deduplicate([...generated.decisions, ...(previous?.decisions ?? []), ...safeguards.decisions]),
    unresolvedItems: deduplicate([...generated.unresolvedItems, ...safeguards.unresolvedItems]),
    activeResources: deduplicate([...generated.activeResources, ...safeguards.activeResources]),
    recentProgress: deduplicate([...generated.recentProgress, ...safeguards.recentProgress]),
    corrections: deduplicate([...(previous?.corrections ?? []), ...generated.corrections, ...safeguards.corrections]),
    summaryText: generated.summaryText,
  };
  return applyCorrectionPrecedence(merged);
}

function fallbackSummary(
  previous: ConversationSummaryData | undefined,
  messages: readonly ConversationMessageRecord[],
): ConversationSummaryData {
  const safeguards = deterministicSafeguards(messages);
  const meaningful = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-8)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content.replace(/\s+/g, " ").slice(0, 240)}`)
    .join(" ");
  const base = previous ?? emptyConversationSummary();
  return applyCorrectionPrecedence({
    activeGoals: deduplicate([...base.activeGoals, ...safeguards.activeGoals]),
    importantFacts: deduplicate([...base.importantFacts, ...safeguards.importantFacts]),
    decisions: deduplicate([...base.decisions, ...safeguards.decisions]),
    unresolvedItems: deduplicate([...base.unresolvedItems, ...safeguards.unresolvedItems]),
    activeResources: deduplicate([...base.activeResources, ...safeguards.activeResources]),
    recentProgress: deduplicate([...base.recentProgress, ...safeguards.recentProgress]),
    corrections: deduplicate([...base.corrections, ...safeguards.corrections]),
    summaryText: `${base.summaryText === "No earlier conversation has been summarized yet." ? "" : base.summaryText + " "}${meaningful}`
      .trim()
      .slice(0, CONVERSATION_CONFIG.maximumSummaryTextCharacters) || "Earlier conversation context is available in structured facts.",
  });
}

export async function generateIncrementalSummary(input: {
  provider?: AIProvider;
  previous?: ConversationSummaryData;
  messages: readonly ConversationMessageRecord[];
}): Promise<ConversationSummaryData> {
  if (!input.provider) return fallbackSummary(input.previous, input.messages);
  const allowed = new Set([
    ...(input.previous
      ? Object.values(input.previous)
          .filter(Array.isArray)
          .flatMap((items) =>
            (items as ConversationSummaryItem[]).flatMap((item) => item.sourceMessageIds),
          )
      : []),
    ...input.messages.map((message) => message.id),
  ]);
  try {
    const response = await input.provider.generateStructuredOutput({
      schemaName: "conversation_summary",
      schema: summaryDataSchema,
      maxOutputTokens: 1800,
      messages: [
        {
          role: "system",
          content:
            "Incrementally update a conversation summary from the previous structured summary and only the newly compressible user-visible messages. Preserve goals, constraints, decisions, corrections, unresolved items, resources, and progress. New corrections replace stale conflicting facts. Keep unchanged facts stable and cite only supplied message IDs. Do not infer permanent user memory, workflow status, or private reasoning. Return concise structured data.",
        },
        {
          role: "user",
          content: JSON.stringify({
            previousSummary: input.previous ?? null,
            newMessages: input.messages.map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content,
              agentId: message.agentId,
            })),
          }),
        },
      ],
    });
    const parsed = summaryDataSchema.parse(response.data);
    for (const item of Object.values(parsed).filter(Array.isArray).flat() as ConversationSummaryItem[]) {
      if (item.sourceMessageIds.some((id) => !allowed.has(id)))
        throw new Error("Summary referenced an unknown message.");
    }
    return mergeSafeguards(parsed, input.previous, input.messages);
  } catch {
    return fallbackSummary(input.previous, input.messages);
  }
}

export { summaryDataSchema as conversationSummaryDataSchema };
