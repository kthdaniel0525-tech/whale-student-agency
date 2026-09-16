import "server-only";
import { copyAgent } from "./metadata";
import { getNotesAgentDefinition } from "./notes/definition";
import { getTutorAgentDefinition } from "./tutor/definition";
import { getQuizAgentDefinition } from "./quiz/definition";
import { getStudyPlannerAgentDefinition } from "./study-planner/definition";
import { getAcademicManagerAgentDefinition } from "./academic-manager/definition";
import type { Agent } from "./types";
import { getCareerAgentDefinition } from "./career/definition";

const definitions: readonly Agent[] = [
  getAcademicManagerAgentDefinition(),
  getTutorAgentDefinition(),
  getNotesAgentDefinition(),
  getQuizAgentDefinition(),
  getStudyPlannerAgentDefinition(),
  getCareerAgentDefinition(),
];

/** Fresh metadata only; callers decide when and where to register it. */
export function getStudentAgentDefinitions(): readonly Agent[] {
  return Object.freeze(definitions.map(copyAgent));
}
