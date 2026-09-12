import { api, readJson } from "@/server/api";
import { db } from "@/server/db/client";
import { saveProfile } from "@/server/services/academic";
import { profileSchema } from "@/features/student/validation/schemas";
export function GET(req: Request) {
  return api(
    req,
    async (userId) => ({
      profile: await db().profile.findUnique({ where: { userId } }),
      user: await db().user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      }),
    }),
    false,
  );
}
export function PUT(req: Request) {
  return api(
    req,
    async (userId) => saveProfile(userId, await readJson(req, profileSchema)),
    false,
  );
}
