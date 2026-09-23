import { z } from "zod";
export class FormError extends Error {
  constructor(
    message: string,
    public fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 401) {
    window.location.assign("/sign-in");
    throw new FormError("Your session has expired. Please sign in.");
  }
  const data = await response.json();
  if (!response.ok) {
    const error = z
      .object({
        error: z.string().optional(),
        message: z.string().optional(),
        fields: z.record(z.array(z.string())).optional(),
      })
      .safeParse(data);
    throw new FormError(
      error.success
        ? error.data.error || error.data.message || "Unable to save changes."
        : "Unable to save changes.",
      error.success ? error.data.fields : {},
    );
  }
  return data as T;
}
