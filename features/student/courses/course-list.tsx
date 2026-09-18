"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight, CalendarClock, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { CourseCard } from "@/server/course-workspace/types";

function dateLabel(date: string, overdue = false) {
  if (overdue) return "Overdue";
  const days = Math.ceil((Date.parse(date) - Date.now()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days} days`;
}

export function CourseList({ courses }: { courses: CourseCard[] }) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return courses;
    return courses.filter((course) => `${course.courseCode} ${course.courseName} ${course.professor ?? ""}`.toLowerCase().includes(normalized));
  }, [courses, query]);

  return <>
    {courses.length > 4 && <div className="course-search field">
      <label htmlFor="course-search">Find a course</label>
      <div><Search /><Input id="course-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search code, name or professor" /></div>
    </div>}
    <div className="course-workspace-grid">
      {visible.map((course) => <Link key={course.id} href={`/student/courses/${course.id}`} className="course-workspace-card">
        <div><span className="eyebrow">{course.courseCode}</span><span className={`course-workspace-attention attention-${course.attention}`}>{course.attentionLabel}</span></div>
        <h2>{course.courseName}</h2>
        <p>{course.professor || "No professor added"} · {course.semester}</p>
        <div className="course-workspace-next">
          {course.nextDeadline && <span><CalendarClock /><span><small>Next deadline</small><strong>{course.nextDeadline.title}</strong> {dateLabel(course.nextDeadline.date, course.nextDeadline.overdue)}</span></span>}
          {course.nextExam && <span><CalendarClock /><span><small>Next exam</small><strong>{course.nextExam.title}</strong> {dateLabel(course.nextExam.date)}</span></span>}
          {!course.nextDeadline && !course.nextExam && <span><CalendarClock /><span>No upcoming deadline</span></span>}
        </div>
        <span className="course-open">Open workspace <ArrowUpRight /></span>
      </Link>)}
    </div>
    {!visible.length && <div className="course-filter-empty">No courses match “{query}”.</div>}
  </>;
}
