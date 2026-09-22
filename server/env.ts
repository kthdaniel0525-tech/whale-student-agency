import "server-only";
import { z } from "zod";
const schema = z.object({
  DATABASE_URL: z.string().url().refine(value => ["postgres:", "postgresql:"].includes(new URL(value).protocol)),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
});
export function getEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success)
    throw new Error(
      "Server configuration is incomplete. Check DATABASE_URL and BETTER_AUTH settings.",
    );
  const origin = new URL(parsed.data.BETTER_AUTH_URL);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Authentication requires an HTTP(S) origin without credentials, paths, or query parameters.");
  }
  if (
    process.env.NODE_ENV === "production" &&
    origin.protocol !== "https:"
  ) {
    throw new Error("Production authentication requires an HTTPS origin.");
  }
  if (process.env.NODE_ENV === "production" && (/replace[-_ ]with|change[-_ ]?me|development[-_ ]?secret|example[-_ ]?secret/i.test(parsed.data.BETTER_AUTH_SECRET) || new Set(parsed.data.BETTER_AUTH_SECRET).size < 8)) {
    throw new Error("Production authentication requires a randomly generated session secret.");
  }
  return parsed.data;
}
