import "server-only";
import { z } from "zod";
const schema = z.object({
  DATABASE_URL: z.string().url(),
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
  if (
    process.env.NODE_ENV === "production" &&
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(origin.hostname)
  ) {
    throw new Error("Production authentication requires an HTTPS origin.");
  }
  return parsed.data;
}
