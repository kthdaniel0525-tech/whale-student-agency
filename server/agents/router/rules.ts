import "server-only";
import type { Agent, AgentId, StudentAgentId } from "../types";

// Small intent hints for planned Student agents; capabilities come from the registry.
const rules: readonly { agentId: StudentAgentId; pattern: RegExp }[] = [
  {
    agentId: "tutor",
    pattern:
      /\b(?:explain(?!\s+why\s+(?:(?:is|was)\s+)?my\s+answer)|what is|help me understand|i (?:do not|don't) understand|teach me)\b/,
  },
  {
    agentId: "notes",
    pattern:
      /\b(?:summarize|summary|make notes|lecture notes|study notes|key concepts|definitions|(?:exam )?review notes|cheat sheet)\b/,
  },
  {
    agentId: "quiz",
    pattern:
      /\b(?:quiz me|(?:make|create|generate)(?: me)?\s+(?:an?\s+)?(?:(?:[\w/]+(?:-[\w/]+)*)\s+){0,6}quiz|practice questions|test me|generate questions|multiple[ -]choice questions|short[ -]answer questions|long[ -]answer questions|check my answer|why (?:(?:is|was) my answer wrong|my answer (?:is|was) wrong)|make (?:the )?questions harder)\b/,
  },
  {
    agentId: "study-planner",
    pattern:
      /\b(?:study plan|study schedule|(?:give|make|create) me (?:a )?(?:study )?schedule|schedule (?:my )?studying|plan my (?:week|day|studying|exam preparation|exam prep)|plan (?:for )?my .{0,40}exam|exam (?:study|preparation|prep) (?:plan|schedule)|what should i study|study (?:today|tonight|right now)|update (?:my )?study (?:plan|schedule)|adjust (?:my )?(?:study )?(?:plan|schedule)|rebalance (?:my )?(?:study )?(?:plan|schedule)|focus more on (?:my )?weak topics?|missed .{0,40}study session|final exam study schedule|help me prioritize .{0,40}exams?|i have .{0,40}exams? .{0,60}(?:help me )?prioritize|only (?:have )?(?:\d+(?:\.\d+)?|one|two|three|four|five|six) hours? tonight)\b/,
  },
  { agentId: "career", pattern: /\b(?:resume|résumé|portfolio|career|internships?|what projects? should i build|what skills am i missing|describe (?:this|my) course project|(?:create|make) bullet points from my experience|make my profile stronger)\b/ },
  {
    agentId: "academic-manager",
    pattern:
      /\b(?:what should i do|what do i need to do|what should i (?:focus on|prioritize)|what should i study next|how am i doing|which course needs|am i ready for (?:my )?exams?|i feel behind|i(?:'m| am) falling behind|help me (?:manage|figure out)|manage my semester|prioritize everything|help me with school|prioritize my semester|academic overview)\b/,
  },
];

export function matchRules<Extension extends string>(
  request: string,
  agents: readonly Agent<Extension>[],
): AgentId<Extension>[] {
  const normalized = request.toLowerCase().replace(/\s+/g, " ");
  const available = new Set<AgentId<Extension>>(
    agents.map((agent) => agent.id),
  );
  return rules
    .filter(
      (rule) => available.has(rule.agentId) && rule.pattern.test(normalized),
    )
    .map((rule) => rule.agentId)
    // Broad next-step guidance belongs to Manager; explicit schedules remain Planner.
    .filter((id) => !(id === "study-planner" && /\bwhat should i study next\b/.test(normalized) && !/\b(?:plan|schedule)\b/.test(normalized)))
    // A career-qualified focus question is not an academic overview request.
    .filter((id) => !(id === "academic-manager" && /\bwhat should i focus on for my career\b/.test(normalized)));
}

function words(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z]+/g) ?? []).map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
    ),
  );
}

export function matchCapabilities<Extension extends string>(
  request: string,
  agents: readonly Agent<Extension>[],
): { agentId: AgentId<Extension>; confidence: number } | undefined {
  const requestWords = words(request);
  const ranked = agents
    .map((agent) => ({
      agentId: agent.id,
      confidence: Math.max(
        0,
        ...agent.capabilities.map((capability) => {
          const terms = [...words(capability)];
          const matched = terms.filter((word) => requestWords.has(word)).length;
          return matched === terms.length && matched > 0
            ? 0.86
            : matched > 0
              ? 0.55
              : 0;
        }),
      ),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  const [best, runnerUp] = ranked;
  // Ties and near ties are uncertainty, not registry-order tie breakers.
  if (
    !best ||
    best.confidence === 0 ||
    (runnerUp && best.confidence - runnerUp.confidence < 0.15)
  )
    return undefined;
  return best;
}
