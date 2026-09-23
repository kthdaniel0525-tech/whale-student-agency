import "server-only";
import { createStudentAgentRegistry } from "../agents/student-service";
import { assignmentSupport } from "./assignment-support";
import { careerPreparation } from "./career-preparation";
import { examPreparation } from "./exam-preparation";
import { lectureStudy } from "./lecture-study";
import { WorkflowRegistry } from "./registry";
import { weakTopicRecovery } from "./weak-topic-recovery";

const definitions = [examPreparation, weakTopicRecovery, lectureStudy, assignmentSupport, careerPreparation] as const;

/** Fresh catalog for routing metadata. WorkflowService remains the only executor. */
export function createStudentWorkflowRegistry() {
  const registry = new WorkflowRegistry(createStudentAgentRegistry());
  for (const definition of definitions) registry.register(definition);
  return registry;
}
