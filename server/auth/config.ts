import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { db } from "@/server/db/client";
import { getEnv } from "@/server/env";
function createAuth() {
  const env = getEnv();
  return betterAuth({
    appName: "Student Agency",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
    databaseHooks: {
      user: { create: { after: async (user) => { await (await import("../entitlements/service")).ensureDefaultSubscription(user.id); } } },
      session: { create: { before: async (session) => {
        const { assertActiveUser, AccountUnavailableError } = await import("../privacy/account-state");
        try { await assertActiveUser(session.userId); }
        catch (error) { if (error instanceof AccountUnavailableError) return false; throw error; }
      } } },
    },
    database: prismaAdapter(db(), { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    // Account deletion must use the application cleanup boundary, not an ORM-only delete.
    user: { deleteUser: { enabled: false } },
    advanced: { useSecureCookies: new URL(env.BETTER_AUTH_URL).protocol === "https:", defaultCookieAttributes: { httpOnly: true, sameSite: "lax" } },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 10 },
      },
    },
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function auth() {
  return (instance ??= createAuth());
}
