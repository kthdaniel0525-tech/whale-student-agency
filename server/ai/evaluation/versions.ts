import "server-only";
import { AGENT_PROMPT_FRAME } from "../../agents/executor/prompt-frame";
import { createHash } from "node:crypto";
import { TUTOR_INSTRUCTIONS } from "../../agents/tutor/instructions";
import { NOTES_INSTRUCTIONS } from "../../agents/notes/instructions";
import { QUIZ_INSTRUCTIONS } from "../../agents/quiz/instructions";
import { STUDY_PLANNER_INSTRUCTIONS } from "../../agents/study-planner/instructions";
import { ACADEMIC_MANAGER_INSTRUCTIONS } from "../../agents/academic-manager/instructions";
import { CAREER_INSTRUCTIONS } from "../../agents/career/instructions";
import { ROUTING_POLICY, getModelCatalog } from "../routing/catalog";
export const CONTEXT_VERSION = "context-v1";
export const PROMPT_FRAME_VERSION = "agent-frame-v1";
export const ROUTING_VERSION = "routing-v1";
export const SOURCE_INSTRUCTIONS: Record<string, string> = { tutor: TUTOR_INSTRUCTIONS, notes: NOTES_INSTRUCTIONS, quiz: QUIZ_INSTRUCTIONS, "study-planner": STUDY_PLANNER_INSTRUCTIONS, "academic-manager": ACADEMIC_MANAGER_INSTRUCTIONS, career: CAREER_INSTRUCTIONS };
export const versionHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
export function promptVersion(agentId: string, instructions = SOURCE_INSTRUCTIONS[agentId] ?? "", frame = PROMPT_FRAME_VERSION) { return `${agentId}:${frame}:${versionHash({ instructions, system: AGENT_PROMPT_FRAME })}`; }
export function routingVersion(catalog = getModelCatalog()) { return `${ROUTING_VERSION}:${versionHash({ policy: ROUTING_POLICY, catalog })}`; }
