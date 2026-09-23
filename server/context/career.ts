import "server-only";
import { db } from "../db/client";
import { NotFoundError } from "../services/academic";
import type { CareerContext } from "../career/types";
import type { CategoryInput } from "./categories";

/** Bounded, user-scoped career references. No external links are fetched and no
 * deadline, assignment or document queries are needed for career advice. */
export async function careerContext({ userId, input, clip }: CategoryInput): Promise<CareerContext> {
  const projectWhere = { userId, ...(input.projectIds ? { id: { in: input.projectIds } } : {}), ...(input.courseId ? { courseId: input.courseId } : {}) };
  const [profile, projects, skills, projectCount, skillCount, courses] = await Promise.all([
    db().careerProfile.findUnique({ where: { userId } }),
    db().project.findMany({ where: projectWhere, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 10,
      include: { course: { select: { id: true, userId: true, courseCode: true, courseName: true } } } }),
    db().skill.findMany({ where: { userId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 30 }),
    db().project.count({ where: projectWhere }),
    db().skill.count({ where: { userId } }),
    db().course.findMany({ where: { userId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 8,
      select: { id: true, courseCode: true, courseName: true, description: true, updatedAt: true } }),
  ]);
  if (input.projectIds && projects.length !== input.projectIds.length) throw new NotFoundError();
  const result: CareerContext = { profile: null, projects: [], skills: [], academicEvidence: [], limitations: [] };
  const bounded = (value: string | null, max: number) => value === null ? null : clip(value, max);
  const strings = (values: string[], count: number, length: number) => {
    if (values.length > count) result.limitations.push("Some long lists were shortened.");
    return values.slice(0, count).map((value) => clip(value, length));
  };
  if (profile) result.profile = {
    updatedAt: profile.updatedAt.toISOString(),
    careerGoal: bounded(profile.careerGoal, 800),
    targetRoles: strings(profile.targetRoles, 8, 100),
    targetIndustries: strings(profile.targetIndustries, 8, 100),
    experiences: strings(profile.experiences, 10, 600).map((text, index) => ({ evidenceId: `experience:${index}`, text })),
    portfolioLinks: strings(profile.portfolioLinks, 8, 250),
    resumeText: bounded(profile.resumeText, 8000),
  };
  // Reserve separate budgets so a long resume cannot crowd out project or skill evidence.
  for (const project of projects) {
    if (project.course && project.course.userId !== userId) continue;
    const item: CareerContext["projects"][number] = {
      id: project.id, updatedAt: project.updatedAt.toISOString(), evidenceId: `project:${project.id}`, name: clip(project.name, 160),
      description: clip(project.description, 1800), technologies: strings(project.technologies, 20, 80),
      role: bounded(project.role, 300), outcomes: strings(project.outcomes, 8, 400),
      link: bounded(project.link, 250), repositoryUrl: bounded(project.repositoryUrl, 250),
      course: project.course ? { id: project.course.id, courseCode: clip(project.course.courseCode, 30), courseName: clip(project.course.courseName, 120) } : null,
    };
    if (JSON.stringify([...result.projects, item]).length > 13000) continue;
    result.projects.push(item);
  }
  for (const skill of skills) {
    const item: CareerContext["skills"][number] = {
      id: skill.id, updatedAt: skill.updatedAt.toISOString(), evidenceId: `skill:${skill.id}`, name: clip(skill.name, 100),
      category: bounded(skill.category, 100), selfReportedProficiency: bounded(skill.proficiency, 200),
      evidence: strings(skill.evidence, 6, 300),
    };
    if (JSON.stringify([...result.skills, item]).length > 5000) continue;
    result.skills.push(item);
  }
  result.academicEvidence = courses.map((course) => ({ evidenceId: `course:${course.id}`, courseId: course.id,
    courseCode: clip(course.courseCode, 30), courseName: clip(course.courseName, 120),
    description: bounded(course.description, 500), updatedAt: course.updatedAt.toISOString() }));
  if (result.projects.length < projectCount) result.limitations.push(`Showing ${result.projects.length} of ${projectCount} saved projects, most recently updated first.`);
  if (result.skills.length < skillCount) result.limitations.push(`Showing ${result.skills.length} of ${skillCount} saved skills.`);
  result.limitations = [...new Set(result.limitations)];
  return result;
}
