import "server-only";
import { DocumentError } from "@/server/documents/config";
import { z } from "zod";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { NotFoundError } from "@/server/services/academic";
const noStore = { "Cache-Control": "private, no-store" };
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function checkOrigin(request: Request) {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    request.headers.get("origin") !== new URL(getEnv().BETTER_AUTH_URL).origin
  ) {
    throw new RequestError(
      "Please submit this request from the application.",
      403,
    );
  }
}
export async function readJson<Output, Input>(
  request: Request,
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
): Promise<Output> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new RequestError("JSON is required.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("Request body is required.", 400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 32768) {
      await reader.cancel();
      throw new RequestError("Request is too large.", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RequestError("Invalid JSON.", 400);
  }
  return schema.parse(json);
}
export async function api(
  request: Request,
  operation: (userId: string) => Promise<unknown>,
  needsProfile = true,
) {
  try {
    checkOrigin(request);
    const session = await auth().api.getSession({ headers: request.headers });
    if (!session) throw new RequestError("Please sign in to continue.", 401);
    if (
      needsProfile &&
      !(await db().profile.findUnique({
        where: { userId: session.user.id },
        select: { id: true },
      }))
    ) {
      throw new RequestError("Complete onboarding first.", 403);
    }
    const result = await operation(session.user.id);
    if (result instanceof Response) {
      result.headers.set("Cache-Control", "private, no-store");
      return result;
    }
    return Response.json(result ?? { success: true }, { headers: noStore });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: "Check the highlighted fields.",
          fields: error.flatten().fieldErrors,
        },
        { status: 400, headers: noStore },
      );
    if (
      error instanceof RequestError ||
      error instanceof DocumentError ||
      error instanceof NotFoundError
    ) {
      return Response.json(
        { error: error.message },
        {
          status:
            error instanceof RequestError || error instanceof DocumentError
              ? error.status
              : 404,
          headers: noStore,
        },
      );
    }
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "P2003" || code === "P2025")
      return Response.json(
        { error: "This item is no longer available. Refresh and try again." },
        { status: 404, headers: noStore },
      );
    console.error("Student API request failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      { error: "Unable to save or load your data. Please try again." },
      { status: 500, headers: noStore },
    );
  }
}
