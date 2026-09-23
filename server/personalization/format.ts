import "server-only";
import type { PersonalizationProfile, PersonalizedValue } from "./types";

function value<T>(input: PersonalizedValue<T> | undefined): T | undefined {
  return input?.value;
}

/** Compact behavior guidance. Source/conflict metadata stays server-side. */
export function formatPersonalizationForAI(
  profile: PersonalizationProfile,
  options: { omitResolvedBehavior?: boolean } = {},
): string {
  const sections: string[] = [];
  const explanation = {
    style: value(profile.explanationStyle),
    depth: value(profile.explanationDepth),
    length: value(profile.preferredAnswerLength),
    structure: value(profile.explanationStructure),
    rigor: value(profile.explanationRigor),
    examples: value(profile.examplePreference),
  };
  const quiz = {
    preferredDifficulty: value(profile.quizDifficulty),
    recommendedDifficulty: value(profile.recommendedDifficulty),
    questionTypes: value(profile.preferredQuestionTypes),
  };
  const learning = {
    confidenceHandling: value(profile.confidenceHandling),
    weakTopicBehavior: value(profile.weakTopicBehavior),
  };
  const study = {
    preferredSessionMinutes: value(profile.studySessionMinutes),
    maxContinuousMinutes: value(profile.maxContinuousMinutes),
    intensity: value(profile.planningIntensity),
    preferredTime: value(profile.preferredStudyTime),
    strategies: value(profile.learningStrategies),
    goals: value(profile.academicGoals),
  };
  const notes = {
    style: value(profile.noteStyle),
    structure: value(profile.noteStructure),
    detail: value(profile.noteDetail),
  };
  const career = value(profile.careerGoals);
  const communication = value(profile.communicationPreferences);
  const add = (label: string, data: Record<string, unknown> | undefined) => {
    if (!data) return;
    const compact = Object.fromEntries(Object.entries(data).filter(([, item]) =>
      item !== undefined && (!Array.isArray(item) || item.length > 0),
    ));
    if (Object.keys(compact).length) sections.push(`${label}=${JSON.stringify(compact)}`);
  };
  if (!options.omitResolvedBehavior) {
    add("explanation", explanation);
    add("quiz", quiz);
    add("learning", learning);
    add("study", study);
    add("notes", notes);
  } else {
    add("study-background", {
      preferredTime: study.preferredTime,
      strategies: study.strategies,
      goals: study.goals,
    });
  }
  if (career && Object.keys(career).length) sections.push(`career=${JSON.stringify(career)}`);
  if (communication?.length) sections.push(`communication=${JSON.stringify(communication)}`);
  return sections.length ? `[PERSONALIZATION]\n${sections.join("\n")}` : "";
}
