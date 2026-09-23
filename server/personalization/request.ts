import type {
  AnswerLength,
  ExplanationDepth,
  ExplanationRigor,
  ExplanationStructure,
  NoteStyle,
  PlanningIntensity,
  QuizDifficultyRecommendation,
} from "./types";

export interface ExplicitRequestPreferences {
  explanationDepth?: ExplanationDepth;
  answerLength?: AnswerLength;
  explanationStructure?: ExplanationStructure;
  explanationRigor?: ExplanationRigor;
  quizDifficulty?: QuizDifficultyRecommendation;
  questionTypes?: readonly string[];
  noteStyle?: NoteStyle;
  planningIntensity?: PlanningIntensity;
  availableMinutes?: number;
}

/** Extracts only clear temporary instructions. Ambiguous language is left alone. */
export function parseExplicitRequestPreferences(
  request: string,
): ExplicitRequestPreferences {
  const text = request.normalize("NFKC").toLocaleLowerCase();
  const result: ExplicitRequestPreferences = {};
  if (/\b(?:simply|simple|beginner(?:-friendly)?)\b|쉽게|초보자(?:용)?/.test(text))
    result.explanationDepth = "beginner";
  else if (/\b(?:advanced|expert-level)\b|고급(?:으로)?/.test(text))
    result.explanationDepth = "advanced";

  if (/\b(?:keep (?:it )?short|brief|concise)\b|짧게|간단히|간결하게/.test(text))
    result.answerLength = "concise";
  else if (/\b(?:detailed|in[- ]depth|thorough)\b|자세히|상세히/.test(text))
    result.answerLength = "detailed";

  if (/\b(?:step[- ]by[- ]step)\b|단계별/.test(text))
    result.explanationStructure = "step-by-step";
  else if (/\b(?:example first|start with (?:an )?example)\b|예시(?:부터|를 먼저)/.test(text))
    result.explanationStructure = "example-first";
  else if (/\b(?:theory first|start with (?:the )?theory)\b|이론(?:부터|을 먼저)/.test(text))
    result.explanationStructure = "theory-first";

  if (/\b(?:formal|rigorous)\b|엄밀하게|형식적으로/.test(text))
    result.explanationRigor = "formal";
  else if (/\b(?:intuitive|intuition)\b|직관적으로/.test(text))
    result.explanationRigor = "intuitive";

  if (/\b(?:hard|difficult)(?:er)?\b|어려운|어렵게|고난도/.test(text))
    result.quizDifficulty = "hard";
  else if (/\b(?:easy|easier)\b|쉬운|쉽게/.test(text) && /\bquiz\b|퀴즈|문제/.test(text))
    result.quizDifficulty = "easy";
  else if (/\b(?:normal|medium|moderate)\b|보통(?: 난이도)?|중간 난이도/.test(text) && /\bquiz\b|퀴즈|문제/.test(text))
    result.quizDifficulty = "medium";

  const questionTypes: string[] = [];
  if (/\bmultiple[ -]choice\b|객관식/.test(text)) questionTypes.push("multiple-choice");
  if (/\btrue[ /-]false\b|참거짓|진위형/.test(text)) questionTypes.push("true-false");
  if (/\bshort[ -]answer\b|단답형/.test(text)) questionTypes.push("short-answer");
  if (/\b(?:long[ -]answer|essay)\b|서술형|논술형/.test(text)) questionTypes.push("long-answer");
  if (/\bmixed\b|혼합형|섞어서/.test(text)) questionTypes.push("mixed");
  if (questionTypes.length) result.questionTypes = questionTypes;

  const noteStyles: Array<[RegExp, NoteStyle]> = [
    [/\bexam[- ]focused\b|시험(?:용| 중심)/, "exam-focused"],
    [/\bdefinitions? first\b|정의(?:부터| 중심)/, "definitions-first"],
    [/\bconcept first\b|개념(?:부터| 중심)/, "concept-first"],
    [/\bstructured notes?\b|구조화(?:된)? 노트/, "structured"],
  ];
  result.noteStyle = noteStyles.find(([pattern]) => pattern.test(text))?.[1];
  if (/\bnotes?\b|노트|요약/.test(text)) {
    if (/\b(?:brief|concise)\b|간결|짧게/.test(text)) result.noteStyle = "concise";
    else if (/\b(?:detailed|thorough)\b|자세|상세/.test(text)) result.noteStyle = "detailed";
  }

  if (/\b(?:intensive|intense)\b|집중적|빡세게/.test(text))
    result.planningIntensity = "intensive";
  else if (/\b(?:light|relaxed)\b|가볍게|여유롭게/.test(text))
    result.planningIntensity = "light";

  const minutes = text.match(/\b(?:only\s+)?(?:have\s+)?(\d{1,3})\s*(?:minutes?|mins?)\b|(?:딱\s*)?(\d{1,3})\s*분(?:만)?/);
  if (minutes) result.availableMinutes = Math.max(1, Math.min(720, Number(minutes[1] ?? minutes[2])));
  const hours = text.match(/\b(?:only\s+)?(?:have\s+)?(\d(?:\.\d)?)\s*hours?\b|(\d(?:\.\d)?)\s*시간(?:만)?/);
  if (!result.availableMinutes && hours)
    result.availableMinutes = Math.max(1, Math.min(720, Math.round(Number(hours[1] ?? hours[2]) * 60)));
  return result;
}
