import "server-only";
import { z } from "zod";
import { auth } from "../auth/config";
import { db } from "../db/client";
import { NotFoundError } from "../services/academic";
import { careerProfileSchema, projectSchema, skillSchema } from "./schemas";

export class CareerDataError extends Error {
  constructor(readonly code: "UNAUTHENTICATED" | "INVALID_REQUEST" | "STORAGE_FAILURE") {
    super({ UNAUTHENTICATED: "Sign in to manage career information.", INVALID_REQUEST: "Check the career information fields.", STORAGE_FAILURE: "Unable to save or load career information." }[code]);
    this.name = "CareerDataError";
  }
}
const idSchema = z.string().min(1).max(100);
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CareerDataError("INVALID_REQUEST");
  return result.data;
}

/** Public server boundary: identity always comes from the session, never a body field.
 * Save methods are explicit user actions; analysis never calls them. */
export class CareerDataService {
  private async run<T>(headers: Headers, operation: (userId: string) => Promise<T>): Promise<T> {
    try {
      const session = await auth().api.getSession({ headers, query: { disableRefresh: true } });
      if (!session) throw new CareerDataError("UNAUTHENTICATED");
      return await operation(session.user.id);
    } catch (error) {
      if (error instanceof CareerDataError || error instanceof NotFoundError) throw error;
      throw new CareerDataError("STORAGE_FAILURE");
    }
  }
  getProfile(headers: Headers) {
    return this.run(headers, (userId) => db().careerProfile.findUnique({ where: { userId } }));
  }
  saveProfile(input: unknown, headers: Headers) {
    return this.run(headers, (userId) => {
      const update = parse(careerProfileSchema.partial(), input);
      const create = parse(careerProfileSchema, input);
      return db().careerProfile.upsert({ where: { userId }, create: { ...create, userId }, update });
    });
  }
  deleteProfile(headers: Headers) {
    return this.run(headers, (userId) => db().careerProfile.deleteMany({ where: { userId } }));
  }
  listProjects(headers: Headers) {
    return this.run(headers, (userId) => db().project.findMany({ where: { userId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 100 }));
  }
  getProject(id: string, headers: Headers) {
    return this.run(headers, async (userId) => {
      const row = await db().project.findFirst({ where: { id: parse(idSchema, id), userId } });
      if (!row) throw new NotFoundError();
      return row;
    });
  }
  saveProject(input: unknown, headers: Headers, id?: string) {
    return this.run(headers, async (userId) => {
      const data = parse(projectSchema, input);
      const projectId = id === undefined ? undefined : parse(idSchema, id);
      return db().$transaction(async (tx) => {
        if (projectId && !(await tx.project.findFirst({ where: { id: projectId, userId }, select: { id: true } }))) throw new NotFoundError();
        if (data.courseId && !(await tx.course.findUnique({ where: { id_userId: { id: data.courseId, userId } }, select: { id: true } }))) throw new NotFoundError();
        if (!projectId) return tx.project.create({ data: { ...data, userId } });
        return tx.project.update({ where: { id: projectId, userId }, data });
      });
    });
  }
  deleteProject(id: string, headers: Headers) {
    return this.run(headers, async (userId) => {
      const result = await db().project.deleteMany({ where: { id: parse(idSchema, id), userId } });
      if (!result.count) throw new NotFoundError();
      return result;
    });
  }
  listSkills(headers: Headers) {
    return this.run(headers, (userId) => db().skill.findMany({ where: { userId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 100 }));
  }
  saveSkill(input: unknown, headers: Headers, id?: string) {
    return this.run(headers, async (userId) => {
      const data = parse(skillSchema, input);
      if (id === undefined) return db().skill.create({ data: { ...data, userId } });
      const skillId = parse(idSchema, id);
      const result = await db().skill.updateMany({ where: { id: skillId, userId }, data });
      if (!result.count) throw new NotFoundError();
      return db().skill.findFirstOrThrow({ where: { id: skillId, userId } });
    });
  }
  deleteSkill(id: string, headers: Headers) {
    return this.run(headers, async (userId) => {
      const result = await db().skill.deleteMany({ where: { id: parse(idSchema, id), userId } });
      if (!result.count) throw new NotFoundError();
      return result;
    });
  }
}
