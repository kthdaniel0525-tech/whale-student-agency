import "server-only";
import type {
  ConversationContext,
  ConversationMessageRecord,
  ConversationSummaryItem,
} from "./types";

function line(item: ConversationSummaryItem): string {
  return `- ${item.text}`;
}

function messageLine(message: ConversationMessageRecord): string {
  const role = message.role === "user" ? "User" : "Assistant";
  const agent = message.agentId ? ` (${message.agentId})` : "";
  return `${role}${agent}: ${JSON.stringify(message.content)}`;
}

/** Conversation values remain untrusted reference data, not prompt instructions. */
export function formatConversationForAI(context: ConversationContext): string {
  const sections: string[] = [];
  if (context.summary) {
    const summary = context.summary;
    const structured: string[] = [];
    const add = (label: string, items: readonly ConversationSummaryItem[]) => {
      if (items.length) structured.push(`${label}:\n${items.map(line).join("\n")}`);
    };
    add("Goals", summary.activeGoals);
    add("Important facts and constraints", summary.importantFacts);
    add("Decisions", summary.decisions);
    add("Corrections (latest overrides older facts)", summary.corrections);
    add("Unresolved items", summary.unresolvedItems);
    add("Active resources", summary.activeResources);
    add("Progress", summary.recentProgress);
    sections.push(
      `[CONVERSATION SUMMARY]\n${summary.summaryText}${structured.length ? "\n" + structured.join("\n") : ""}`,
    );
  }
  if (context.recentMessages.length) {
    sections.push(
      `[RECENT CONVERSATION]\n${context.recentMessages.map(messageLine).join("\n")}`,
    );
  }
  if (context.relevantHistoricalMessages.length) {
    sections.push(
      `[RELEVANT EARLIER CONTEXT]\n${context.relevantHistoricalMessages.map(messageLine).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
