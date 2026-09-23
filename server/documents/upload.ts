import "server-only";
import { DocumentError, MAX_FILE_BYTES } from "./config";
import { uploadDocument } from "./service";
import { validateUploadMime } from "./extraction";
export async function acceptUpload(request: Request, userId: string) {
  const type = request.headers.get("content-type") || "";
  if (!type.startsWith("multipart/form-data;"))
    throw new DocumentError("Choose a file to upload.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new DocumentError("Choose a file.");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > MAX_FILE_BYTES + 65536) {
      await reader.cancel();
      throw new DocumentError("Files must be 10 MB or smaller.", 413);
    }
    parts.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "Content-Type": type },
    }).formData();
  } catch {
    throw new DocumentError("The upload was incomplete. Please try again.");
  }
  const allowed = new Set(["file", "title", "courseId"]);
  for (const key of form.keys())
    if (!allowed.has(key) || form.getAll(key).length !== 1)
      throw new DocumentError("Invalid upload fields.");
  const file = form.get("file");
  if (!(file instanceof File)) throw new DocumentError("Choose a file.");
  validateUploadMime(file.name, file.type);
  const metadata = {
    title: form.get("title") || file.name,
    ...(form.get("courseId") ? { courseId: form.get("courseId") } : {}),
  };
  return uploadDocument(
    userId,
    metadata,
    file.name,
    new Uint8Array(await file.arrayBuffer()),
  );
}
