import { api } from "@/server/api";
import { originalFile } from "@/server/documents/service";
export function GET(req: Request, c: { params: Promise<{ id: string }> }) {
  return api(req, async (userId) => {
    const { document, bytes } = await originalFile(userId, (await c.params).id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type":
          document.fileType === "PDF"
            ? "application/pdf"
            : "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="document.${document.fileType === "PDF" ? "pdf" : "txt"}"; filename*=UTF-8''${encodeURIComponent(document.originalFileName)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });
}
