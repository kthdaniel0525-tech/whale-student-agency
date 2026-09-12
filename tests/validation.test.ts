import { describe, expect, it } from "vitest";
import {
  assignmentSchema,
  courseSchema,
  examSchema,
  profileSchema,
} from "../features/student/validation/schemas";
import { countdown } from "../lib/student/dates";
describe("request validation and local dates", () => {
  it("rejects forged ownership and whitespace-only names", () => {
    expect(
      courseSchema.safeParse({
        courseCode: "MATH",
        courseName: "Math",
        semester: "Fall",
        userId: "other",
      }).success,
    ).toBe(false);
    expect(
      courseSchema.safeParse({
        courseCode: " ",
        courseName: "Math",
        semester: "Fall",
      }).success,
    ).toBe(false);
  });
  it("rejects invalid dates, hours and enums", () => {
    expect(
      assignmentSchema.safeParse({
        title: "A",
        dueDate: "bad",
        status: "TODO",
        priority: "HIGH",
        estimatedHours: 1,
      }).success,
    ).toBe(false);
    expect(
      assignmentSchema.safeParse({
        title: "A",
        dueDate: "2026-10-01T12:00:00Z",
        status: "TODO",
        priority: "HIGH",
        estimatedHours: -1,
      }).success,
    ).toBe(false);
    expect(
      examSchema.safeParse({ title: "Exam", examDate: "invalid", topics: [] })
        .success,
    ).toBe(false);
    expect(
      profileSchema.safeParse({
        name: "a",
        school: "b",
        program: "c",
        currentYear: 0,
        semester: "d",
        academicGoal: "e",
        studySessionMinutes: 5,
        explanationDifficulty: "X",
        timezone: "bad",
      }).success,
    ).toBe(false);
  });
  it("counts calendar days across a DST change in the profile timezone", () => {
    expect(
      countdown(
        "2026-11-02T12:00:00Z",
        "America/Winnipeg",
        new Date("2026-10-31T12:00:00Z"),
      ),
    ).toBe("In 2 days");
    expect(
      countdown(
        "2026-09-10T04:00:00Z",
        "America/Winnipeg",
        new Date("2026-09-09T12:00:00Z"),
      ),
    ).toBe("Today");
  });
});
