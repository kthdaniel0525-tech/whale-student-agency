import { CONVERSATION_CONFIG } from "./config";
import { formatConversationForAI } from "./format";
import type {
  ConversationContext,
  ConversationMessageRecord,
  ConversationSummaryRecord,
} from "./types";
import { estimateTokens } from "./tokens";

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function duplicate(
  message: ConversationMessageRecord,
  seen: readonly string[],
): boolean {
  const text = normalized(message.content);
  if (!text) return true;
  return seen.some((candidate) => {
    const other = normalized(candidate);
    if (!other) return false;
    if (other.includes(text) || text.includes(other)) return true;
    const left = new Set(text.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    const right = new Set(other.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    if (!left.size || !right.size) return false;
    const overlap = [...left].filter((word) => right.has(word)).length;
    return overlap / Math.min(left.size, right.size) > 0.9;
  });
}

export function conversationTokenTarget(input: {
  agentId?: string;
  request: string;
  domainEstimatedTokens: number;
}): number {
  const configured =
    CONVERSATION_CONFIG.agentConversationTokens[input.agentId ?? ""] ?? 3400;
  const referenceBoost =
    /\b(?:that|previous|earlier|again|continue|as before|the one)\b|그거|이전|아까|다시|계속/i.test(
      input.request,
    )
      ? 600
      : 0;
  const available =
    CONVERSATION_CONFIG.totalInputTargetTokens -
    input.domainEstimatedTokens -
    CONVERSATION_CONFIG.systemAndRequestReserveTokens;
  return Math.min(
    CONVERSATION_CONFIG.maximumConversationTokens,
    Math.max(
      CONVERSATION_CONFIG.minimumConversationTokens,
      Math.min(configured + referenceBoost, available),
    ),
  );
}

function clipped(
  message: ConversationMessageRecord,
  maximumTokens: number,
): ConversationMessageRecord {
  if (message.tokenEstimate <= maximumTokens) return message;
  const maximumCharacters = Math.max(240, maximumTokens * 4);
  return {
    ...message,
    content: message.content.slice(0, maximumCharacters - 1) + "…",
    tokenEstimate: maximumTokens,
  };
}

export function applyConversationBudget(input: {
  conversationId: string;
  courseId: string | null;
  summary?: ConversationSummaryRecord;
  recentMessages: readonly ConversationMessageRecord[];
  historicalMessages: readonly ConversationMessageRecord[];
  targetTokens: number;
  compressionTriggered: boolean;
  domainEstimatedTokens: number;
}): ConversationContext {
  const summaryText = input.summary ? formatConversationForAI({
    conversationId: input.conversationId,
    courseId: input.courseId,
    summary: input.summary,
    recentMessages: [],
    relevantHistoricalMessages: [],
    metadata: {
      recentMessagesUsed: 0,
      historicalMessagesUsed: 0,
      summaryUsed: true,
      estimatedConversationTokens: 0,
      compressionTriggered: input.compressionTriggered,
      targetConversationTokens: input.targetTokens,
      totalAssembledContextEstimate: 0,
    },
  }) : "";
  const summaryTokens = estimateTokens(summaryText);
  let recent = input.recentMessages.slice();
  const recentTokens = () => recent.reduce((sum, item) => sum + item.tokenEstimate, 0);
  while (
    recent.length > CONVERSATION_CONFIG.minimumRecentMessages &&
    summaryTokens + recentTokens() > input.targetTokens &&
    input.summary &&
    recent[0].sequence <= input.summary.coveredUntilSequence
  ) {
    recent = recent.slice(1);
  }
  if (summaryTokens + recentTokens() > input.targetTokens) {
    const perMessage = Math.max(
      120,
      Math.floor((input.targetTokens - summaryTokens) / Math.max(1, recent.length)),
    );
    recent = recent.map((message) => clipped(message, perMessage));
  }
  let used = summaryTokens + recent.reduce((sum, item) => sum + item.tokenEstimate, 0);
  const summaryFacts = input.summary
    ? [
        input.summary.summaryText,
        ...input.summary.activeGoals.map((item) => item.text),
        ...input.summary.importantFacts.map((item) => item.text),
        ...input.summary.decisions.map((item) => item.text),
        ...input.summary.unresolvedItems.map((item) => item.text),
        ...input.summary.activeResources.map((item) => item.text),
        ...input.summary.recentProgress.map((item) => item.text),
        ...input.summary.corrections.map((item) => item.text),
      ]
    : [];
  const seen = [...summaryFacts, ...recent.map((item) => item.content)];
  const history: ConversationMessageRecord[] = [];
  // History is optional supporting context. Reserve the summary and necessary
  // recent turns first, then use only the remaining budget for older matches.
  for (const item of input.historicalMessages) {
    if (duplicate(item, [...seen, ...history.map((message) => message.content)])) continue;
    if (used + item.tokenEstimate > input.targetTokens) continue;
    history.push(item);
    used += item.tokenEstimate;
  }
  const context: ConversationContext = {
    conversationId: input.conversationId,
    courseId: input.courseId,
    ...(input.summary ? { summary: input.summary } : {}),
    recentMessages: recent,
    relevantHistoricalMessages: history,
    metadata: {
      recentMessagesUsed: recent.length,
      historicalMessagesUsed: history.length,
      summaryUsed: Boolean(input.summary),
      estimatedConversationTokens: used,
      compressionTriggered: input.compressionTriggered,
      targetConversationTokens: input.targetTokens,
      totalAssembledContextEstimate:
        used +
        input.domainEstimatedTokens +
        CONVERSATION_CONFIG.systemAndRequestReserveTokens,
    },
  };
  return context;
}
