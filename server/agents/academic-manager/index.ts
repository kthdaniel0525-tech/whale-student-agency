import "server-only";
export { getAcademicManagerAgentDefinition } from "./definition";
export { ACADEMIC_MANAGER_INSTRUCTIONS } from "./instructions";
export { executeAcademicManager, academicManagerMode, type AcademicManagerResponse } from "./execution";
export { buildAcademicSnapshot, calculateExamReadiness, READINESS_CONFIG } from "../../academic/snapshot";
export type * from "../../academic/types";
