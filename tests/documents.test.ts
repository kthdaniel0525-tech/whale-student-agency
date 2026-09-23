import "dotenv/config";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID, createHmac } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { documentConfig } from "@/server/documents/config";
import { db } from "@/server/db/client";
import { processNextDocument } from "@/server/documents/processor";
import {
  embeddingProvider,
  type EmbeddingProvider,
} from "@/server/documents/embeddings";
import { storage } from "@/server/documents/storage/local";
import { cleanupFiles } from "@/server/documents/cleanup";
import {
  documentSections,
  fullDocumentText,
  neighboringChunks,
} from "@/server/documents/retrieval";
import { inductionPages, textPdf } from "./fixtures/documents";
import type { DocumentItem, SearchResult } from "@/features/documents/types";
const base = process.env.BETTER_AUTH_URL || "http://localhost:3000";
type Actor = { id: string; email: string; cookie: string };
const actors: Actor[] = [];
let a: Actor,
  b: Actor,
  math: string,
  biology: string,
  foreign: string,
  pdfId: string;
async function api(
  path: string,
  actor?: Actor,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  return fetch(base + path, {
    method,
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(actor ? { Cookie: actor.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json<T = DocumentItem>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<T>;
}
async function signup() {
  const email = `docs-${randomUUID()}@example.test`;
  const response = await api("/api/auth/sign-up/email", undefined, {
    name: "Documents Test",
    email,
    password: "Long-documents-test-passphrase!",
  });
  const data = await json<{ user: { id: string } }>(response);
  const actor = {
    id: data.user.id,
    email,
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
  actors.push(actor);
  await json(
    await api(
      "/api/student/profile",
      actor,
      {
        name: "Documents Test",
        school: "Test University",
        program: "Mathematics",
        currentYear: 1,
        semester: "Fall 2026",
        academicGoal: "Understand induction",
        studySessionMinutes: 45,
        explanationDifficulty: "INTERMEDIATE",
        timezone: "America/Winnipeg",
      },
      "PUT",
    ),
  );
  return actor;
}
async function course(actor: Actor, code: string) {
  return (
    await json(
      await api("/api/student/courses", actor, {
        courseCode: code,
        courseName: code,
        professor: "",
        semester: "Fall 2026",
        description: "",
      }),
    )
  ).id as string;
}
async function upload(
  actor: Actor | undefined,
  courseId?: string,
  bytes = textPdf(inductionPages),
  filename = "lecture.pdf",
  extras?: Record<string, string>,
) {
  const form = new FormData();
  form.set("file", new Blob([Buffer.from(bytes)]), filename);
  form.set("title", filename);
  if (courseId) form.set("courseId", courseId);
  for (const [key, value] of Object.entries(extras || {})) form.set(key, value);
  return fetch(base + "/api/student/documents", {
    method: "POST",
    headers: { Origin: base, ...(actor ? { Cookie: actor.cookie } : {}) },
    body: form,
  });
}
async function txt(
  actor: Actor,
  courseId?: string,
  content = "Mathematical induction uses a base case and an inductive step.",
) {
  return (
    await json(
      await upload(
        actor,
        courseId,
        new TextEncoder().encode(content),
        "notes.md",
      ),
    )
  ).id as string;
}
async function search(actor: Actor, request: Record<string, unknown>) {
  return json<{ results: SearchResult[] }>(
    await api("/api/student/rag/search", actor, request),
  );
}
beforeAll(async () => {
  a = await signup();
  b = await signup();
  math = await course(a, "MATH 1240");
  biology = await course(a, "BIO 1000");
  foreign = await course(b, "OTHER 1000");
}, 60000);
afterAll(async () => {
  for (const actor of actors) {
    await db().user.deleteMany({ where: { id: actor.id, email: actor.email } });
    await cleanupFiles(actor.id);
    for (const action of [
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
    ]) {
      const key =
        "credential:" +
        createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
          .update(`${action}:${actor.email}`)
          .digest("hex");
      await db().rateLimit.deleteMany({ where: { key } });
    }
  }
  await db().$disconnect();
});
describe.sequential(
  "real private documents, PostgreSQL vectors and local neural embeddings",
  () => {
    it("runs the actual local neural embedding model", async () => {
      const vector = await embeddingProvider.generateEmbedding(
        "Mathematical induction proves a statement using a base case.",
      );
      expect(vector).toHaveLength(384);
      expect(vector.every(Number.isFinite)).toBe(true);
    }, 90000);
    it("authorizes uploads and rejects foreign courses, forged owners and large multipart bodies", async () => {
      expect((await upload(undefined, math)).status).toBe(401);
      expect((await upload(b, math)).status).toBe(404);
      expect(
        (await upload(a, math, undefined, undefined, { userId: b.id })).status,
      ).toBe(400);
      expect(
        (
          await upload(
            a,
            math,
            new TextEncoder().encode("Not a PDF"),
            "fake.pdf",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await upload(
            a,
            math,
            new Uint8Array(10 * 1024 * 1024 + 1),
            "large.txt",
          )
        ).status,
      ).toBe(413);
      const response = await upload(a, math);
      const document = await json(response);
      pdfId = document.id;
      expect(document).toMatchObject({
        courseId: math,
        processingStatus: "UPLOADED",
        _count: { chunks: 0 },
      });
      for (const field of ["storageKey", "leaseToken", "userId"])
        expect(document).not.toHaveProperty(field);
      expect(response.headers.get("cache-control")).toContain("no-store");
    });
    it("indexes a real PDF into pages, chunks and 384-dimensional pgvector values", async () => {
      expect(await processNextDocument(embeddingProvider, pdfId)).toBe(true);
      const document = await json(
        await api(`/api/student/documents/${pdfId}`, a),
      );
      expect(document).toMatchObject({
        processingStatus: "READY",
        pageCount: 2,
      });
      expect(document._count.chunks).toBeGreaterThan(0);
      const vectors = await db().$queryRaw<
        { dimensions: number; model: string }[]
      >`SELECT vector_dims(embedding) AS dimensions,"embeddingModel" AS model FROM "DocumentChunk" WHERE "documentId"=${pdfId}`;
      expect(
        vectors.every(
          (v) => v.dimensions === 384 && v.model === embeddingProvider.id,
        ),
      ).toBe(true);
      const pages = await documentSections(a.id, pdfId, 2, 2);
      expect(pages.pages).toHaveLength(1);
      expect(pages.pages[0].content).toContain("inductive hypothesis");
      expect((await fullDocumentText(a.id, pdfId)).content).toContain(
        "falling dominoes",
      );
      expect((await neighboringChunks(a.id, pdfId, 0)).length).toBeGreaterThan(
        0,
      );
      expect(await processNextDocument(embeddingProvider, pdfId)).toBe(false);
      const download = await api(`/api/student/documents/${pdfId}/download`, a);
      expect(download.headers.get("content-disposition")).toContain(
        "attachment",
      );
      expect(download.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(
        textPdf(inductionPages),
      );
    }, 90000);
    it("retrieves semantic paraphrases with citations and rejects an irrelevant query", async () => {
      const result = await search(a, {
        query: "What assumption about k lets us prove the next integer?",
        courseId: math,
      });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]).toMatchObject({
        documentId: pdfId,
        documentTitle: "lecture.pdf",
        courseId: math,
        pageNumber: 1,
        pageEnd: 2,
      });
      expect(result.results[0].content).toContain("inductive hypothesis");
      expect(result.results[0].similarityScore).toBeGreaterThanOrEqual(0.35);
      for (const query of [
        "inductive hypothesis",
        "Why are falling dominoes a useful mental model for this proof method?",
      ]) {
        const grounded = await search(a, { query, courseId: math });
        expect(grounded.results[0]).toMatchObject({
          documentId: pdfId,
          documentTitle: "lecture.pdf",
          courseId: math,
        });
      }
      expect(
        (
          await search(a, {
            query: "How long should I roast chicken with garlic and potatoes?",
          })
        ).results,
      ).toEqual([]);
    }, 90000);
    it("filters courses and documents before ranking and never retrieves another owner", async () => {
      const bioId = await txt(
        a,
        biology,
        "Photosynthesis converts sunlight, water and carbon dioxide into sugar. Chlorophyll absorbs light in plant chloroplasts. Oxygen is released.",
      );
      await processNextDocument(embeddingProvider, bioId);
      const privateId = await txt(
        b,
        foreign,
        "The inductive hypothesis assumes the proposition for k to establish k plus one. PRIVATE OTHER STUDENT MATERIAL.",
      );
      await processNextDocument(embeddingProvider, privateId);
      expect(
        (
          await search(a, {
            query: "How do plants turn sunlight into energy?",
            courseId: biology,
          })
        ).results[0].documentId,
      ).toBe(bioId);
      expect(
        (
          await search(a, {
            query: "What is the inductive hypothesis?",
            courseId: biology,
          })
        ).results,
      ).toEqual([]);
      const own = await search(a, {
        query: "What is the inductive hypothesis?",
      });
      expect(own.results.length).toBeGreaterThan(0);
      expect(
        own.results.every(
          (r: { documentId: string }) => r.documentId !== privateId,
        ),
      ).toBe(true);
      expect(
        (
          await search(a, {
            query: "What is the inductive hypothesis?",
            documentIds: [pdfId],
          })
        ).results.every((r: { documentId: string }) => r.documentId === pdfId),
      ).toBe(true);
      expect(
        (
          await api("/api/student/rag/search", a, {
            query: "inductive hypothesis",
            courseId: foreign,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await api("/api/student/rag/search", a, {
            query: "inductive hypothesis",
            documentIds: [privateId],
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await api("/api/student/rag/search", a, {
            query: "inductive hypothesis",
            courseId: biology,
            documentIds: [pdfId],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await api("/api/student/rag/search", a, {
            query: "inductive hypothesis",
            userId: b.id,
          })
        ).status,
      ).toBe(400);
      for (const suffix of ["", "/download", "/sections"])
        expect(
          (await api(`/api/student/documents/${pdfId}${suffix}`, b)).status,
        ).toBe(404);
      expect(
        (await api(`/api/student/documents/${pdfId}/retry`, b, {})).status,
      ).toBe(404);
      expect(
        (await api(`/api/student/documents/${pdfId}`, b, undefined, "DELETE"))
          .status,
      ).toBe(404);
      await expect(fullDocumentText(b.id, pdfId)).rejects.toThrow();
      await expect(neighboringChunks(b.id, pdfId, 0)).rejects.toThrow();
    }, 90000);
    it("marks damaged PDFs and provider failures safely, and retries without duplicate jobs", async () => {
      const bad = (
        await json(
          await upload(
            a,
            math,
            new TextEncoder().encode("%PDF-invalid"),
            "damaged.pdf",
          ),
        )
      ).id;
      await processNextDocument(embeddingProvider, bad);
      const failed = await json(await api(`/api/student/documents/${bad}`, a));
      expect(failed.processingStatus).toBe("FAILED");
      expect(failed.processingError).toContain("encrypted or damaged");
      const id = await txt(a, math);
      const broken: EmbeddingProvider = {
        id: embeddingProvider.id,
        generateEmbedding: async () => {
          throw Error("secret_provider_key");
        },
      };
      await processNextDocument(broken, id);
      const error = await json(await api(`/api/student/documents/${id}`, a));
      expect(error.processingStatus).toBe("FAILED");
      expect(error.processingError).not.toContain("secret_provider_key");
      const retries = await Promise.all([
        api(`/api/student/documents/${id}/retry`, a, {}),
        api(`/api/student/documents/${id}/retry`, a, {}),
      ]);
      expect(retries.map((r) => r.status).sort()).toEqual([200, 409]);
      await processNextDocument(embeddingProvider, id);
      expect(
        (await json(await api(`/api/student/documents/${id}`, a)))
          .processingStatus,
      ).toBe("READY");
      expect(
        await db().documentChunk.count({ where: { documentId: id } }),
      ).toBe(1);
    }, 90000);
    it("bounds stalled providers, recovers expired leases and fences superseded workers", async () => {
      const id = await txt(a);
      const hung: EmbeddingProvider = {
        id: embeddingProvider.id,
        generateEmbedding: () => new Promise(() => {}),
      };
      await processNextDocument(hung, id, 100);
      expect(
        (await db().document.findUniqueOrThrow({ where: { id } }))
          .processingStatus,
      ).toBe("FAILED");
      const next = await txt(a);
      await db().document.update({
        where: { id: next },
        data: {
          processingStatus: "PROCESSING",
          leaseToken: "dead-worker",
          leaseExpiresAt: new Date(0),
          attempts: 1,
        },
      });
      await processNextDocument(embeddingProvider, next);
      expect(
        (await db().document.findUniqueOrThrow({ where: { id: next } }))
          .processingStatus,
      ).toBe("READY");
      const superseded = await txt(a);
      let resume!: (v: number[]) => void;
      let started!: () => void;
      const entered = new Promise<void>((r) => {
        started = r;
      });
      const paused: EmbeddingProvider = {
        id: embeddingProvider.id,
        generateEmbedding: () => {
          started();
          return new Promise((r) => {
            resume = r;
          });
        },
      };
      const work = processNextDocument(paused, superseded);
      await entered;
      expect(await processNextDocument(embeddingProvider, superseded)).toBe(
        false,
      );
      await db().document.update({
        where: { id: superseded },
        data: { leaseToken: "replacement-worker" },
      });
      resume(Array(384).fill(1));
      await work;
      expect(
        await db().documentChunk.count({ where: { documentId: superseded } }),
      ).toBe(0);
      expect(
        (await db().document.findUniqueOrThrow({ where: { id: superseded } }))
          .leaseToken,
      ).toBe("replacement-worker");
    }, 90000);
    it("does not resurrect vectors when deleting an in-flight document", async () => {
      const id = await txt(a);
      const record = await db().document.findUniqueOrThrow({ where: { id } });
      let resume!: (v: number[]) => void;
      let started!: () => void;
      const entered = new Promise<void>((r) => {
        started = r;
      });
      const paused: EmbeddingProvider = {
        id: embeddingProvider.id,
        generateEmbedding: () => {
          started();
          return new Promise((r) => {
            resume = r;
          });
        },
      };
      const work = processNextDocument(paused, id);
      await entered;
      await json(
        await api(`/api/student/documents/${id}`, a, undefined, "DELETE"),
      );
      resume(Array(384).fill(1));
      await work;
      expect(
        await db().documentChunk.count({ where: { documentId: id } }),
      ).toBe(0);
      await expect(storage.get(record.storageKey)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    it("enforces database ownership and deletes documents, pages, vectors and physical files", async () => {
      await expect(
        db().documentPage.create({
          data: {
            documentId: pdfId,
            userId: b.id,
            pageNumber: 9,
            content: "forbidden",
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      const record = await db().document.findUniqueOrThrow({
        where: { id: pdfId },
      });
      await json(
        await api(`/api/student/documents/${pdfId}`, a, undefined, "DELETE"),
      );
      expect(
        await db().documentChunk.count({ where: { documentId: pdfId } }),
      ).toBe(0);
      expect(
        await db().documentPage.count({ where: { documentId: pdfId } }),
      ).toBe(0);
      await expect(storage.get(record.storageKey)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await api(`/api/student/documents/${pdfId}`, a)).status).toBe(
        404,
      );
      const rows = await db().document.findMany({
        where: { userId: a.id, courseId: biology },
      });
      expect(rows.length).toBeGreaterThan(0);
      await json(
        await api(`/api/student/courses/${biology}`, a, undefined, "DELETE"),
      );
      for (const row of rows) {
        expect(
          await db().documentChunk.count({ where: { documentId: row.id } }),
        ).toBe(0);
        await expect(storage.get(row.storageKey)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(await cleanupFiles(a.id)).toBe(0);
    });
    it("persists file cleanup failures and retries the durable outbox", async () => {
      const id = await txt(a);
      const record = await db().document.findUniqueOrThrow({ where: { id } });
      await storage.remove(record.storageKey);
      const location = path.join(documentConfig().storage, record.storageKey);
      await mkdir(location);
      try {
        const response = await json<{
          success: boolean;
          cleanupPending: boolean;
        }>(await api(`/api/student/documents/${id}`, a, undefined, "DELETE"));
        expect(response).toEqual({ success: true, cleanupPending: true });
        expect(
          (
            await db().fileDeletion.findUniqueOrThrow({
              where: { storageKey: record.storageKey },
            })
          ).attempts,
        ).toBe(1);
        expect(await db().document.findUnique({ where: { id } })).toBeNull();
      } finally {
        await rmdir(location);
      }
      await db().fileDeletion.update({
        where: { storageKey: record.storageKey },
        data: { retryAt: new Date(0) },
      });
      expect(await cleanupFiles(a.id)).toBe(0);
    });
  },
);
