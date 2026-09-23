import "server-only";
import { AgentService, type AgentServiceOptions } from "./core";
import { AgentRegistry } from "./registry";
import { getStudentAgentDefinitions } from "./student";
import { TUTOR_INSTRUCTIONS } from "./tutor/instructions";
import { NOTES_INSTRUCTIONS } from "./notes/instructions";
import { QUIZ_INSTRUCTIONS } from "./quiz/instructions";
import { STUDY_PLANNER_INSTRUCTIONS } from "./study-planner/instructions";
import { executeAcademicManager } from "./academic-manager/execution";
import { ACADEMIC_MANAGER_INSTRUCTIONS } from "./academic-manager/instructions";
import { executeCareer } from "./career/execution";
import { CAREER_INSTRUCTIONS } from "./career/instructions";

export function createStudentAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  for (const agent of getStudentAgentDefinitions()) registry.register(agent);
  return registry;
}

/** Student configuration for the existing core service and implemented agent instructions. */
export function createStudentAgentService(
  options: AgentServiceOptions = {},
): AgentService {
  const registry = createStudentAgentRegistry();
  return new AgentService(registry, {
    ...options,
    handlers: { "academic-manager": executeAcademicManager, career: executeCareer, ...options.handlers },
    executor: {
      ...options.executor,
      instructions: {
        tutor: TUTOR_INSTRUCTIONS,
        notes: NOTES_INSTRUCTIONS,
        quiz: QUIZ_INSTRUCTIONS,
        "study-planner": STUDY_PLANNER_INSTRUCTIONS,
        "academic-manager": ACADEMIC_MANAGER_INSTRUCTIONS,
        career: CAREER_INSTRUCTIONS,
        ...options.executor?.instructions,
      },
    },
  });
}
