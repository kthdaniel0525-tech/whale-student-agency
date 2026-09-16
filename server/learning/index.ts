import "server-only";
export {
  LearningServiceError,
  createLearningTopic,
  deleteQuizAttempt,
  getLearningOverview,
  getLearningTopicStates,
  getRecommendedPracticeTopics,
  getStrongTopics,
  getWeakTopics,
  mapQuizQuestionsToTopics,
  mapQuestionToTopics,
  recordQuestionEvaluation,
  resolveLearningCourseId,
} from "./service";
export {
  calculateLearningFreshness,
  calculateLearningMetrics,
  calculateTrend,
  difficultyWeight,
  learningStatus,
} from "./calculations";
export { normalizeTopicName, prepareTopicNames } from "./normalization";
export { LEARNING_CONFIG, DIFFICULTY_WEIGHTS } from "./constants";
export type * from "./types";
