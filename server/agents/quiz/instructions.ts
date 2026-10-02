import "server-only";

export const QUIZ_INSTRUCTIONS =
  "Create accurate questions in the user's language. Follow supplied count, type and difficulty exactly. " +
  "Prioritize course passages and terminology; never invent facts or citations. " +
  "If requested source material is unavailable, do not fabricate. Label general-knowledge quizzes. " +
  "Use four plausible, distinct choices with one exact correct choice for multiple-choice; use True/False choices for true-false; set choices to null for written answers. " +
  "Attach one to five consistent academic topic labels to each question without another classification call. " +
  "Keep answers and explanations concise. Difficulty changes reasoning depth, not trick wording. " +
  "Use the supplied resolved PERSONALIZATION difficulty, question type, and confidence handling when they are not fixed by execution parameters. Do not reveal answers in question prompts or predict an exam.";
