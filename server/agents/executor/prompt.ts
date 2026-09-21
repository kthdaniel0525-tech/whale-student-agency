import "server-only";
import { AGENT_PROMPT_FRAME } from "./prompt-frame";
import type { AIMessage } from "../../ai/types";
import { formatContextForAI } from "../../context/format";
import { formatPersonalizationForAI } from "../../personalization";
import type { PersonalizationProfile } from "../../personalization";
import type { Agent, AgentExecutionInput } from "../types";
import { formatConversationForAI } from "../../conversations";
import {
  formatAdaptiveStrategyForAI,
  type AdaptiveStrategy,
} from "../../adaptive";

/** Caller supplies server-owned instructions and context already prepared by Context Builder. */
export function buildExecutionPrompt<Extension extends string>(
  agent: Agent<Extension>,
  input: AgentExecutionInput,
  instructions?: string,
  directive?: string,
  personalization?: PersonalizationProfile,
  adaptiveStrategy?: AdaptiveStrategy,
): AIMessage[] {
  const metadata = JSON.stringify({
    id: agent.id,
    name: agent.name.slice(0, 80),
    description: agent.description.slice(0, 240),
    capabilities: agent.capabilities.slice(0, 8),
  });
  const messages: AIMessage[] = [
    {
      role: "system",
      content:
        AGENT_PROMPT_FRAME +
        metadata +
        (adaptiveStrategy
          ? "\n" + formatAdaptiveStrategyForAI(adaptiveStrategy)
          : "") +
        (instructions ? "\nExecution instructions: " + instructions : "") +
        (directive ? "\nExecution parameters: " + directive : ""),
    },
  ];
  const factualContext = formatContextForAI(input.context, {
    omitPersonalizationSignals: true,
  });
  const personalizationReference = personalization
    ? formatPersonalizationForAI(personalization, {
        omitResolvedBehavior: Boolean(adaptiveStrategy),
      })
    : "";
  const conversationReference = input.conversationContext
    ? formatConversationForAI(input.conversationContext)
    : "";
  const reference = [conversationReference, factualContext, personalizationReference]
    .filter(Boolean)
    .join("\n\n");
  if (reference)
    messages.push({
      role: "user",
      content: "Relevant reference data:\n" + reference,
    });
  messages.push({ role: "user", content: input.request });
  return messages;
}
