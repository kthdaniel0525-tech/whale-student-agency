import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID, createHmac } from "node:crypto";
const base = process.env.BETTER_AUTH_URL || "http://localhost:3000";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID();
const password = "Testing-only-Long-Passphrase!";
type Actor = { cookie: string; id: string; email: string };
const actors: Actor[] = [];
const limitedEmail = `throttle-${suffix}@example.test`;
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  actor?: Actor,
  origin = base,
) {
  return fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(actor ? { Cookie: actor.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function expectPageRedirect(response: Response, destination: string) {
  // Next.js may flush the loading boundary before its server-side redirect.
  if (response.status === 307)
    expect(response.headers.get("location")).toBe(destination);
  else {
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`id="__next-page-redirect"`);
    expect(html).toContain(`content="1;url=${destination}"`);
    expect(html).not.toContain("Test Foundations");
  }
}
async function signup(label: string) {
  const email = `${label}-${suffix}@example.test`;
  const res = await call("/api/auth/sign-up/email", "POST", {
    name: label,
    email,
    password,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user: { id: string } };
  const cookieHeaders = res.headers.getSetCookie();
  expect(cookieHeaders.some((c) => c.toLowerCase().includes("httponly"))).toBe(
    true,
  );
  expect(
    cookieHeaders.some((c) => c.toLowerCase().includes("samesite=lax")),
  ).toBe(true);
  const actor = {
    email,
    id: data.user.id,
    cookie: cookieHeaders.map((c) => c.split(";")[0]).join("; "),
  };
  actors.push(actor);
  return actor;
}
const profile = {
  name: "Test Student",
  school: "Test University",
  program: "Computer Science",
  currentYear: 2,
  semester: "Fall 2026",
  academicGoal: "Build strong foundations",
  studySessionMinutes: 45,
  explanationDifficulty: "INTERMEDIATE",
  timezone: "America/Winnipeg",
};
const courseInput = {
  courseCode: "TEST 100",
  courseName: "Test Foundations",
  professor: "Professor Test",
  semester: "Fall 2026",
  description: "Integration test only",
};
const assignmentInput = {
  title: "Proof exercise",
  description: "Complete the proof",
  dueDate: "2099-10-10T17:00:00Z",
  status: "TODO",
  priority: "HIGH",
  estimatedHours: 2,
};
const examInput = {
  title: "Midterm",
  examDate: "2099-10-20T17:00:00Z",
  topics: ["Induction"],
  notes: "Closed book",
};
let a: Actor, b: Actor, courseId: string, assignmentId: string, examId: string;
async function data(res: Response) {
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}
beforeAll(async () => {
  a = await signup("alpha");
  b = await signup("beta");
});
afterAll(async () => {
  for (const actor of actors)
    await pool.query('DELETE FROM "User" WHERE id = $1 AND email = $2', [
      actor.id,
      actor.email,
    ]);
  for (const email of [...actors.map((actor) => actor.email), limitedEmail]) {
    for (const action of [
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
    ]) {
      const key =
        "credential:" +
        createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
          .update(`${action}:${email}`)
          .digest("hex");
      await pool.query('DELETE FROM "RateLimit" WHERE key=$1', [key]);
    }
  }
  await pool.end();
});
describe.sequential("real PostgreSQL and HTTP foundation", () => {
  it("protects pages and APIs against anonymous and forged identities", async () => {
    await expectPageRedirect(await call("/student"), "/sign-in");
    for (const path of [
      "/api/student/profile",
      "/api/student/courses",
      "/api/student/dashboard",
    ])
      expect((await call(path)).status).toBe(401);
    const forged = await fetch(`${base}/api/student/profile`, {
      headers: {
        Cookie: "better-auth.session_token=forged",
        "oai-authenticated-user-id": a.id,
      },
    });
    expect(forged.status).toBe(401);
    expect(
      (await call("/api/student/courses", "POST", courseInput)).status,
    ).toBe(401);
  });
  it("onboards once and preserves profile preferences", async () => {
    await expectPageRedirect(
      await call("/student", "GET", undefined, a),
      "/onboarding",
    );
    expect(
      (await call("/api/student/courses", "POST", courseInput, a)).status,
    ).toBe(403);
    expect(
      (
        await call(
          "/api/student/profile",
          "PUT",
          { ...profile, currentYear: 0 },
          a,
        )
      ).status,
    ).toBe(400);
    await data(await call("/api/student/profile", "PUT", profile, a));
    await data(
      await call(
        "/api/student/profile",
        "PUT",
        { ...profile, name: "Beta Student" },
        b,
      ),
    );
    await expectPageRedirect(
      await call("/onboarding", "GET", undefined, a),
      "/student",
    );
    const first = await data(
      await call("/api/student/profile", "GET", undefined, a),
    );
    await data(
      await call(
        "/api/student/profile",
        "PUT",
        { ...profile, name: "Updated Name", studySessionMinutes: 60 },
        a,
      ),
    );
    const saved = await data(
      await call("/api/student/profile", "GET", undefined, a),
    );
    expect((saved.profile as Record<string, unknown>).studySessionMinutes).toBe(
      60,
    );
    expect((saved.profile as Record<string, unknown>).onboardedAt).toBe(
      (first.profile as Record<string, unknown>).onboardedAt,
    );
    expect((saved.user as Record<string, unknown>).name).toBe("Updated Name");
  });
  it("creates and edits a persisted owned course", async () => {
    const c = await data(
      await call("/api/student/courses", "POST", courseInput, a),
    );
    courseId = String(c.id);
    expect(c.userId).toBe(a.id);
    const updated = await data(
      await call(
        `/api/student/courses/${courseId}`,
        "PUT",
        { ...courseInput, courseName: "Updated course" },
        a,
      ),
    );
    expect(updated.courseName).toBe("Updated course");
    expect(
      (await call(`/student/courses/${courseId}`, "GET", undefined, a)).status,
    ).toBe(200);
  });
  it("rejects cross-owner reads, mutations, foreign parent links and forged userId", async () => {
    for (const method of ["GET", "PUT", "DELETE"])
      expect(
        (
          await call(
            `/api/student/courses/${courseId}`,
            method,
            method === "PUT" ? courseInput : undefined,
            b,
          )
        ).status,
      ).toBe(404);
    expect(
      (
        await call(
          `/api/student/courses/${courseId}/assignments`,
          "POST",
          assignmentInput,
          b,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          `/api/student/courses/${courseId}/exams`,
          "POST",
          examInput,
          b,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "/api/student/courses",
          "POST",
          { ...courseInput, userId: a.id },
          b,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          "/api/student/profile",
          "PUT",
          { ...profile, userId: a.id },
          b,
        )
      ).status,
    ).toBe(400);
    const list = await (
      await call("/api/student/courses", "GET", undefined, b)
    ).json();
    expect(list).toEqual([]);
    const dash = await data(
      await call("/api/student/dashboard", "GET", undefined, b),
    );
    expect(dash.courses).toEqual([]);
  });
  it("creates, edits, completes and reopens assignments; creates and edits exams", async () => {
    const task = await data(
      await call(
        `/api/student/courses/${courseId}/assignments`,
        "POST",
        assignmentInput,
        a,
      ),
    );
    assignmentId = String(task.id);
    const updated = await data(
      await call(
        `/api/student/assignments/${assignmentId}`,
        "PUT",
        { ...assignmentInput, title: "Updated assignment" },
        a,
      ),
    );
    expect(updated.title).toBe("Updated assignment");
    const done = await data(
      await call(
        `/api/student/assignments/${assignmentId}`,
        "PATCH",
        { status: "COMPLETED" },
        a,
      ),
    );
    expect(done.completedAt).not.toBeNull();
    const repeat = await data(
      await call(
        `/api/student/assignments/${assignmentId}`,
        "PATCH",
        { status: "COMPLETED" },
        a,
      ),
    );
    expect(repeat.completedAt).toBe(done.completedAt);
    const dash = await data(
      await call("/api/student/dashboard", "GET", undefined, a),
    );
    expect(dash.assignments).toEqual([]);
    const reopened = await data(
      await call(
        `/api/student/assignments/${assignmentId}`,
        "PATCH",
        { status: "TODO" },
        a,
      ),
    );
    expect(reopened.completedAt).toBeNull();
    const exam = await data(
      await call(
        `/api/student/courses/${courseId}/exams`,
        "POST",
        examInput,
        a,
      ),
    );
    examId = String(exam.id);
    const changed = await data(
      await call(
        `/api/student/exams/${examId}`,
        "PUT",
        { ...examInput, title: "Updated midterm" },
        a,
      ),
    );
    expect(changed.title).toBe("Updated midterm");
    const upcoming = await data(
      await call("/api/student/dashboard", "GET", undefined, a),
    );
    expect((upcoming.assignments as unknown[]).length).toBe(1);
    expect((upcoming.exams as unknown[]).length).toBe(1);
  });
  it("protects child resources, rejects invalid input and foreign-origin writes", async () => {
    for (const [kind, id, input] of [
      ["assignments", assignmentId, assignmentInput],
      ["exams", examId, examInput],
    ] as const) {
      for (const method of ["GET", "PUT", "DELETE"])
        expect(
          (
            await call(
              `/api/student/${kind}/${id}`,
              method,
              method === "PUT" ? input : undefined,
              b,
            )
          ).status,
        ).toBe(404);
    }
    expect(
      (
        await call(
          `/api/student/assignments/${assignmentId}`,
          "PATCH",
          { status: "COMPLETED" },
          b,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          `/api/student/assignments/${assignmentId}`,
          "PUT",
          { ...assignmentInput, estimatedHours: -1 },
          a,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          "/api/student/courses",
          "POST",
          courseInput,
          a,
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("/api/auth/sign-out", "POST", {}, a, "https://evil.example"))
        .status,
    ).toBe(403);
    const malformed = await fetch(`${base}/api/student/courses`, {
      method: "POST",
      headers: {
        Cookie: a.cookie,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const large = await call(
      "/api/student/courses",
      "POST",
      { ...courseInput, description: "x".repeat(40000) },
      a,
    );
    expect(large.status).toBe(413);
  });
  it("enforces composite ownership foreign keys at the database layer", async () => {
    await expect(
      pool.query(
        'INSERT INTO "Exam" (id,"userId","courseId",title,"examDate",topics,"updatedAt") VALUES ($1,$2,$3,$4,NOW(),ARRAY[]::text[],NOW())',
        [randomUUID(), b.id, courseId, "Forbidden"],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("deletes individual records and cascades course deletion", async () => {
    expect(
      (
        await call(
          `/api/student/assignments/${assignmentId}`,
          "DELETE",
          undefined,
          a,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(`/api/student/exams/${examId}`, "DELETE", undefined, a))
        .status,
    ).toBe(200);
    const t = await data(
      await call(
        `/api/student/courses/${courseId}/assignments`,
        "POST",
        assignmentInput,
        a,
      ),
    );
    const e = await data(
      await call(
        `/api/student/courses/${courseId}/exams`,
        "POST",
        examInput,
        a,
      ),
    );
    expect(
      (await call(`/api/student/courses/${courseId}`, "DELETE", undefined, a))
        .status,
    ).toBe(200);
    expect(
      (await call(`/api/student/assignments/${t.id}`, "GET", undefined, a))
        .status,
    ).toBe(404);
    expect(
      (await call(`/api/student/exams/${e.id}`, "GET", undefined, a)).status,
    ).toBe(404);
  });
  it("hashes passwords, revokes sessions, rejects wrong passwords and signs in again", async () => {
    const account = await pool.query(
      'SELECT password FROM "Account" WHERE "userId"=$1',
      [a.id],
    );
    expect(account.rows[0].password).toBeTruthy();
    expect(account.rows[0].password === password).toBe(false);
    expect((await call("/api/auth/sign-out", "POST", {}, a)).status).toBe(200);
    expect(
      (await call("/api/student/profile", "GET", undefined, a)).status,
    ).toBe(401);
    expect(
      (
        await call("/api/auth/sign-in/email", "POST", {
          email: a.email,
          password: "Wrong-password-long",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/api/auth/sign-in/email", "POST", {
          email: a.email,
          password,
        })
      ).status,
    ).toBe(200);
  });
  it("enforces atomic email throttling even when forwarded IP headers rotate", async () => {
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        fetch(`${base}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            Origin: base,
            "Content-Type": "application/json",
            "x-forwarded-for": `198.51.100.${i + 1}`,
          },
          body: JSON.stringify({
            email: limitedEmail,
            password: "Wrong-password-long",
          }),
        }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 401),
    ).toHaveLength(10);
    const blocked = responses.filter((response) => response.status === 429);
    expect(blocked).toHaveLength(1);
    expect(Number(blocked[0].headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
