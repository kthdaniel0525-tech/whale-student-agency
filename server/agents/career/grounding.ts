import type { CareerContext } from "../../career/types";

export function careerEvidence(career: CareerContext, request: string): Map<string, string> {
  const evidence = new Map<string, string>([["request", request]]);
  if (career.profile?.resumeText) evidence.set("resume", career.profile.resumeText);
  for (const item of career.profile?.experiences ?? []) evidence.set(item.evidenceId, item.text);
  for (const project of career.projects) evidence.set(project.evidenceId,
    [project.name, project.description, project.role, ...project.technologies, ...project.outcomes].filter(Boolean).join("\n"));
  for (const skill of career.skills) evidence.set(skill.evidenceId,
    [skill.name, skill.selfReportedProficiency, ...skill.evidence].filter(Boolean).join("\n"));
  for (const course of career.academicEvidence) evidence.set(course.evidenceId,
    [course.courseCode, course.courseName, course.description].filter(Boolean).join("\n"));
  return evidence;
}
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const quantity = /(?<![\p{L}\p{N}])(?:\d[\d,]*(?:\.\d+)?(?:\s*[%％x×+])?|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|dozen|doubled|tripled|halved|twice|tenfold)(?![\p{L}\p{N}]))/giu;
const connector = /^(?:and|or|to|by|with|using|for|in|on|of|a|an|the)$/i;

/** Conservative quantity guard, not a semantic fact checker. A quantity and its
 * following unit must occur verbatim in its cited source. This also prevents
 * reusing a technology version as a count of users. Recommendations may propose
 * future numeric goals; factual assertions and resume achievements may not. */
export function hasUnsupportedMetrics(text: string, source: string): boolean {
  const original = normalize(source);
  const output = normalize(text);
  for (const match of output.matchAll(quantity)) {
    const token = match[0];
    const unit = output.slice(match.index! + token.length).match(/^\s*([\p{L}][\p{L}-]*)/u);
    const phrase = unit && !connector.test(unit[1]) && !/[%％x×+]$/.test(token) ? token + unit[0] : token;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(original)) return true;
  }
  return false;
}
