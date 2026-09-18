"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Brain,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  GraduationCap,
  Loader2,
  MessageSquare,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { DocumentLibrary } from "@/features/documents/components/library";
import { EntityForm } from "@/features/student/components/entity-form";
import { CompleteAssignment, DeleteItem } from "@/features/student/components/item-actions";
import type { CourseWorkspace as CourseWorkspaceData, CourseWorkspaceTopic } from "@/server/course-workspace/types";

const tabs = ["overview", "assignments", "exams", "documents", "notes", "progress"] as const;
type Tab = typeof tabs[number];
const tabLabels: Record<Tab, string> = { overview: "Overview", assignments: "Assignments", exams: "Exams", documents: "Documents", notes: "Notes", progress: "Progress" };

type RecommendationAction = {
  target: { type: "agent" | "workflow"; id: string };
  payload: Record<string, string | number | boolean | null>;
};

function assistantUrl(prompt: string, target: { type: "agent" | "workflow"; id: string } | null, values: Record<string, string | null | undefined> = {}) {
  const params = new URLSearchParams({ prompt });
  if (target) params.set(target.type, target.id);
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return `/student/assistant?${params.toString()}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function countdown(value: string) {
  const days = Math.ceil((Date.parse(value) - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days`;
}

function topicUrl(courseId: string, topic: CourseWorkspaceTopic, mode: "review" | "practice" | "recover" | "diagnostic") {
  const values = { courseId, topicId: topic.id, topicName: topic.topic };
  if (mode === "recover") return assistantUrl(`Help me recover my understanding of ${topic.topic}.`, { type: "workflow", id: "weak-topic-recovery" }, values);
  if (mode === "review") return assistantUrl(`Teach me ${topic.topic} using my course and learning context.`, { type: "agent", id: "tutor" }, values);
  return assistantUrl(mode === "diagnostic" ? `Give me a diagnostic quiz on ${topic.topic}.` : `Quiz me on ${topic.topic}.`, { type: "agent", id: "quiz" }, values);
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The course workspace could not be refreshed.");
  return body;
}

function TopicRow({ courseId, topic }: { courseId: string; topic: CourseWorkspaceTopic }) {
  return <article className="course-topic-row">
    <div><strong>{topic.topic}</strong><small>{topic.confidenceLabel} · {topic.trend.replaceAll("-", " ")}</small></div>
    <span className={`course-topic-state ${topic.needsMoreData ? "low-evidence" : ""}`}>{topic.stateLabel}</span>
    <div className="course-topic-mastery"><span>{topic.needsMoreData ? "Estimate pending" : `Mastery ${topic.mastery}`}</span>{!topic.needsMoreData && <Progress value={topic.mastery} aria-label={`${topic.topic} mastery ${topic.mastery}%`} />}</div>
    <div className="course-topic-actions">
      {topic.needsMoreData ? <Button asChild size="sm" variant="outline"><Link href={topicUrl(courseId, topic, "diagnostic")}>Diagnostic quiz</Link></Button> : <>
        <Button asChild size="sm" variant="outline"><Link href={topicUrl(courseId, topic, "review")}>Review</Link></Button>
        <Button asChild size="sm" variant="outline"><Link href={topicUrl(courseId, topic, "practice")}>Practice</Link></Button>
        {topic.stateLabel === "Weak" && <Button asChild size="sm"><Link href={topicUrl(courseId, topic, "recover")}>Start recovery</Link></Button>}
      </>}
    </div>
  </article>;
}

export function CourseWorkspace({ initial, initialTab = "overview" }: { initial: CourseWorkspaceData; initialTab?: string }) {
  const router = useRouter();
  const [refreshed, setRefreshed] = useState<CourseWorkspaceData | null>(null);
  const data = refreshed && Date.parse(refreshed.generatedAt) >= Date.parse(initial.generatedAt)
    ? refreshed
    : initial;
  const [active, setActive] = useState<Tab>(tabs.includes(initialTab as Tab) ? initialTab as Tab : "overview");
  const [refreshing, setRefreshing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string>();
  const course = data.course;
  const courseValues = { courseId: course.id };
  const firstLowEvidence = data.topics.find((topic) => topic.needsMoreData);
  const weakActionTopic = data.weakTopics[0] ?? firstLowEvidence;
  const tabCounts = useMemo(() => ({ assignments: data.assignments.length, exams: data.exams.length, documents: data.documents.length, notes: data.notes.length }), [data]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      setRefreshed(await responseJson<CourseWorkspaceData>(await fetch(`/api/student/courses/${course.id}/workspace`, { cache: "no-store" })));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The course workspace could not be refreshed.");
    } finally { setRefreshing(false); }
  }, [course.id, router]);

  async function launchRecommendation() {
    if (!data.nextBestAction) return;
    setLaunching(true);
    setError(undefined);
    try {
      const action = await responseJson<RecommendationAction>(await fetch(`/api/student/recommendations/${data.nextBestAction.id}/action`, { method: "POST" }));
      const values = Object.fromEntries(Object.entries(action.payload).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []));
      router.push(assistantUrl(`${data.nextBestAction.title}. ${data.nextBestAction.message}`, action.target, values));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This recommendation is no longer available.");
      await refresh();
    } finally { setLaunching(false); }
  }

  function chooseTab(tab: Tab, focus = false) {
    setActive(tab);
    const url = new URL(window.location.href);
    if (tab === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (focus) document.getElementById(`course-tab-${tab}`)?.focus();
  }

  return <div className="course-workspace">
    <Link href="/student/courses" className="course-workspace-back"><ArrowLeft /> All courses</Link>
    <header className="course-workspace-heading">
      <div><div className="flex flex-wrap items-center gap-2"><p className="eyebrow">{course.courseCode}</p><span className={`course-workspace-attention attention-${course.attention}`}>{course.attentionLabel}</span></div><h1>{course.courseName}</h1><p>{course.professor || "No professor added"} · {course.semester}</p></div>
      <div><Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}><RefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh</Button><EntityForm kind="course" initial={{ id: course.id, courseCode: course.courseCode, courseName: course.courseName, professor: course.professor, semester: course.semester, description: course.description }} /><DeleteItem kind="course" id={course.id} /></div>
    </header>

    {error && <div className="course-workspace-error" role="alert"><AlertTriangle /> {error}</div>}
    {data.sectionErrors.length > 0 && <div className="course-workspace-warning" role="status" aria-label={`Unavailable course sections: ${data.sectionErrors.join(", ")}`}>Some course details are temporarily unavailable. Available sections remain current.</div>}

    <nav className="course-tabs" role="tablist" aria-label={`${course.courseCode} workspace sections`} onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const position = tabs.indexOf(active);
      chooseTab(tabs[(position + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length], true);
    }}>
      {tabs.map((tab) => <button id={`course-tab-${tab}`} key={tab} role="tab" aria-selected={active === tab} aria-controls={`course-panel-${tab}`} tabIndex={active === tab ? 0 : -1} onClick={() => chooseTab(tab)}>{tabLabels[tab]}{tab in tabCounts && <span>{tabCounts[tab as keyof typeof tabCounts]}</span>}</button>)}
    </nav>

    {active === "overview" && <main id="course-panel-overview" role="tabpanel" aria-labelledby="course-tab-overview" className="course-workspace-panel">
      <section className="course-overview-hero">
        <div><p className="eyebrow">Course overview</p><h2>{course.description || "Your focused workspace for this course."}</h2><div className="course-overview-signals">
          <span><CalendarClock /> {data.overview.nextAssignment ? `${data.overview.nextAssignment.title} · ${countdown(data.overview.nextAssignment.dueDate)}` : "No open assignment"}</span>
          <span><GraduationCap /> {data.overview.nextExam ? `${data.overview.nextExam.title} · ${data.overview.nextExam.daysRemaining} days` : "No upcoming exam"}</span>
          <span><Brain /> {data.overview.averageMastery === null ? "Learning evidence needed" : `${data.overview.averageMastery}% average mastery · ${data.overview.learningLabel}`}</span>
        </div></div>
        <div className="course-ai-actions"><h3>Course AI actions</h3><div>
          <Button asChild><Link href={assistantUrl(`Help me with ${course.courseCode}.`, null, courseValues)}><MessageSquare /> Ask Course AI</Link></Button>
          {weakActionTopic && <Button asChild variant="outline"><Link href={topicUrl(course.id, weakActionTopic, weakActionTopic.needsMoreData ? "diagnostic" : "recover")}><Brain /> {weakActionTopic.needsMoreData ? "Take diagnostic quiz" : "Study weakest topic"}</Link></Button>}
          <Button asChild variant="outline"><Link href={assistantUrl(`Quiz me using my ${course.courseCode} learning progress.`, { type: "agent", id: "quiz" }, courseValues)}><ClipboardCheck /> Quiz me</Link></Button>
          {data.overview.nextExam && <Button asChild variant="outline"><Link href={assistantUrl(`Prepare me for ${data.overview.nextExam.title}.`, { type: "workflow", id: "exam-preparation" }, { ...courseValues, examId: data.overview.nextExam.id })}><GraduationCap /> Prepare for next exam</Link></Button>}
          {data.overview.latestReadyDocument && <Button asChild variant="outline"><Link href={assistantUrl(`Study ${data.overview.latestReadyDocument.title} as my latest lecture.`, { type: "workflow", id: "lecture-study" }, { ...courseValues, documentId: data.overview.latestReadyDocument.id })}><FileText /> Study latest lecture</Link></Button>}
        </div></div>
      </section>

      {data.nextBestAction && <section className={`course-next-action priority-${data.nextBestAction.priority}`}><div><span><Sparkles /> Next best action</span><h2>{data.nextBestAction.title}</h2><p>{data.nextBestAction.message}</p></div><Button onClick={launchRecommendation} disabled={launching}>{launching ? <Loader2 className="animate-spin" /> : <ArrowRight />}{data.nextBestAction.actionLabel}</Button></section>}

      <div className="course-overview-grid">
        <section className="course-workspace-card-panel"><div className="course-panel-heading"><h2>What’s next</h2><CalendarClock /></div>{data.overview.nextAssignment ? <article><span>Assignment</span><strong>{data.overview.nextAssignment.title}</strong><p>{formatDate(data.overview.nextAssignment.dueDate)} · {data.overview.nextAssignment.priority.toLowerCase()} priority</p><Button variant="outline" size="sm" onClick={() => chooseTab("assignments")}>View assignments</Button></article> : <p className="course-empty-copy">No open assignments.</p>}{data.overview.nextExam && <article><span>Exam</span><strong>{data.overview.nextExam.title}</strong><p>{data.overview.nextExam.daysRemaining} days · {data.overview.nextExam.readinessLabel}</p><Button variant="outline" size="sm" onClick={() => chooseTab("exams")}>View exam</Button></article>}</section>
        <section className="course-workspace-card-panel"><div className="course-panel-heading"><h2>Learning focus</h2><TrendingUp /></div>{data.overview.topWeakTopic ? <><TopicRow courseId={course.id} topic={data.overview.topWeakTopic} /><Button variant="ghost" size="sm" onClick={() => chooseTab("progress")}>View all progress <ArrowRight /></Button></> : <div className="course-inline-empty"><p>No learning data yet.</p><Button asChild size="sm"><Link href={assistantUrl(`Create a diagnostic quiz for ${course.courseCode}.`, { type: "agent", id: "quiz" }, courseValues)}>Take quiz</Link></Button></div>}</section>
        <section className="course-workspace-card-panel"><div className="course-panel-heading"><h2>Study plan</h2><CheckCircle2 /></div>{data.studyPlan ? <div className="course-plan-summary"><h3>{data.studyPlan.title}</h3><strong>{data.studyPlan.completedTasks} / {data.studyPlan.completedTasks + data.studyPlan.remainingTasks} tasks complete</strong>{data.studyPlan.completionPercentage !== null && <Progress value={data.studyPlan.completionPercentage} aria-label={`${data.studyPlan.title} ${data.studyPlan.completionPercentage}% complete`} />}{data.studyPlan.nextTask && <p>Next: {data.studyPlan.nextTask.title} · {data.studyPlan.nextTask.durationMinutes} min</p>}<Button asChild size="sm"><Link href="/student/study-plan">View plan</Link></Button></div> : <div className="course-inline-empty"><p>No active course study plan.</p><Button asChild size="sm"><Link href={assistantUrl(`Create a study plan for ${course.courseCode}.`, { type: "agent", id: "study-planner" }, courseValues)}>Create plan</Link></Button></div>}</section>
      </div>
    </main>}

    {active === "assignments" && <section id="course-panel-assignments" role="tabpanel" aria-labelledby="course-tab-assignments" className="course-workspace-panel course-workspace-card-panel">
      <div className="course-panel-heading"><div><p className="eyebrow">Coursework</p><h2>Assignments</h2></div><EntityForm kind="assignment" courseId={course.id} /></div>
      {data.assignments.length ? <div className="course-assignment-list">{data.assignments.map((assignment) => <article key={assignment.id} className={assignment.status === "COMPLETED" ? "is-complete" : ""}>
        <div className="course-item-main"><div><span className={`course-item-status status-${assignment.status.toLowerCase().replaceAll("_", "-")}`}>{assignment.status.replaceAll("_", " ").toLowerCase()}</span>{assignment.overdue && <span className="course-overdue">Overdue</span>}</div><h3>{assignment.title}</h3><p>{formatDate(assignment.dueDate)} · {assignment.estimatedHours} hours · {assignment.priority.toLowerCase()} priority</p>{assignment.description && <p>{assignment.description}</p>}</div>
        <div className="course-item-controls"><CompleteAssignment id={assignment.id} completed={assignment.status === "COMPLETED"} /><EntityForm kind="assignment" initial={{ id: assignment.id, title: assignment.title, description: assignment.description, dueDate: assignment.dueDate, status: assignment.status, priority: assignment.priority, estimatedHours: assignment.estimatedHours }} /><DeleteItem kind="assignment" id={assignment.id} /></div>
        <div className="course-item-ai"><Button asChild size="sm"><Link href={assistantUrl(`Help me with ${assignment.title}.`, { type: "workflow", id: "assignment-support" }, { ...courseValues, assignmentId: assignment.id })}>Get help</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Plan the work for ${assignment.title}.`, { type: "workflow", id: "assignment-support" }, { ...courseValues, assignmentId: assignment.id })}>Plan work</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Review my draft for ${assignment.title}.`, { type: "workflow", id: "assignment-support" }, { ...courseValues, assignmentId: assignment.id })}>Review draft</Link></Button></div>
      </article>)}</div> : <div className="course-inline-empty"><div><h3>No assignments</h3><p>Use “Add assignment” above to add your first course deadline.</p></div></div>}
    </section>}

    {active === "exams" && <section id="course-panel-exams" role="tabpanel" aria-labelledby="course-tab-exams" className="course-workspace-panel course-workspace-card-panel">
      <div className="course-panel-heading"><div><p className="eyebrow">Assessment</p><h2>Exams</h2></div><EntityForm kind="exam" courseId={course.id} /></div>
      {data.exams.length ? <div className="course-exam-list">{data.exams.map((exam) => <article key={exam.id}>
        <div className="course-exam-heading"><div><h3>{exam.title}</h3><p>{formatDate(exam.examDate)} · {exam.daysRemaining} days remaining</p></div><span className={`course-readiness readiness-${exam.readinessLevel}`}>{exam.readinessLabel}</span></div>
        {exam.readinessScore !== null && exam.readinessLevel !== "insufficient-data" && <Progress value={exam.readinessScore} aria-label={`${exam.title} readiness ${exam.readinessScore}%`} />}
        <p>Evidence confidence {exam.readinessConfidence}%{exam.planCompletion !== null ? ` · Study plan ${exam.planCompletion}% complete` : ""}</p>
        {exam.topics.length > 0 && <div className="course-topic-chips">{exam.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>}
        {exam.weakTopics[0] && <p><strong>Key weakness:</strong> {exam.weakTopics[0]}</p>}
        <div className="course-item-ai"><Button asChild size="sm"><Link href={assistantUrl(`Prepare me for ${exam.title}.`, { type: "workflow", id: "exam-preparation" }, { ...courseValues, examId: exam.id })}>Prepare for exam</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Create a practice quiz for ${exam.title}.`, { type: "agent", id: "quiz" }, { ...courseValues, examId: exam.id })}>Practice quiz</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Update my study plan for ${exam.title}.`, { type: "agent", id: "study-planner" }, { ...courseValues, examId: exam.id })}>Update plan</Link></Button><EntityForm kind="exam" initial={{ id: exam.id, title: exam.title, examDate: exam.examDate, topics: exam.topics, notes: exam.notes }} /><DeleteItem kind="exam" id={exam.id} /></div>
      </article>)}</div> : <div className="course-inline-empty"><div><h3>No exams</h3><p>Use “Add exam” above to track readiness and prepare with AI.</p></div></div>}
    </section>}

    {active === "documents" && <section id="course-panel-documents" role="tabpanel" aria-labelledby="course-tab-documents" className="course-workspace-panel course-workspace-card-panel"><DocumentLibrary courses={[course]} courseId={course.id} initial={data.documents} aiActions onDocumentsChanged={refresh} /></section>}

    {active === "notes" && <section id="course-panel-notes" role="tabpanel" aria-labelledby="course-tab-notes" className="course-workspace-panel course-workspace-card-panel">
      <div className="course-panel-heading"><div><p className="eyebrow">Saved AI outputs</p><h2>Notes</h2></div><Button asChild><Link href={assistantUrl(`Create course notes for ${course.courseCode}.`, { type: "agent", id: "notes" }, courseValues)}>Create notes</Link></Button></div>
      {data.notes.length ? <div className="course-notes-list">{data.notes.map((note) => <details key={note.id}><summary><span><strong>{note.title}</strong><small>{formatDate(note.createdAt)}{note.documentIds.length ? ` · ${note.documentIds.length} source document${note.documentIds.length === 1 ? "" : "s"}` : ""}</small></span><BookOpen /></summary><p>{note.content}</p><div><Button asChild size="sm"><Link href={assistantUrl(`Continue working with my notes: ${note.title}.`, { type: "agent", id: "notes" }, courseValues)}>Continue in AI</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Create a quiz from my notes: ${note.title}.`, { type: "agent", id: "quiz" }, courseValues)}>Turn into quiz</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Explain the most important concept in my notes: ${note.title}.`, { type: "agent", id: "tutor" }, courseValues)}>Explain concept</Link></Button></div></details>)}</div> : <div className="course-inline-empty"><div><h3>No saved notes</h3><p>Notes generated for this course will appear here.</p></div><Button asChild><Link href={assistantUrl(`Create structured notes for ${course.courseCode}.`, { type: "agent", id: "notes" }, courseValues)}>Create notes</Link></Button></div>}
    </section>}

    {active === "progress" && <section id="course-panel-progress" role="tabpanel" aria-labelledby="course-tab-progress" className="course-workspace-panel">
      <div className="course-progress-layout"><section className="course-workspace-card-panel"><div className="course-panel-heading"><div><p className="eyebrow">Learning intelligence</p><h2>Topic progress</h2></div><Brain /></div>{data.topics.length ? <div>{data.topics.map((topic) => <TopicRow key={topic.id} courseId={course.id} topic={topic} />)}</div> : <div className="course-inline-empty"><div><h3>No learning data</h3><p>Take a quiz to begin tracking course mastery.</p></div><Button asChild><Link href={assistantUrl(`Create a diagnostic quiz for ${course.courseCode}.`, { type: "agent", id: "quiz" }, courseValues)}>Take quiz</Link></Button></div>}</section>
      <section className="course-workspace-card-panel"><div className="course-panel-heading"><div><p className="eyebrow">Practice history</p><h2>Recent quizzes</h2></div><ClipboardCheck /></div>{data.recentQuizzes.length ? <div className="course-quiz-history">{data.recentQuizzes.map((quiz) => <details key={quiz.id}><summary><span><strong>{quiz.topic ?? quiz.title}</strong><small>{formatDate(quiz.completedAt)} · {quiz.difficulty}</small></span><b>{quiz.accuracy}%</b></summary><p>{quiz.answered} questions answered in {quiz.title}.</p><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Review my ${quiz.title} result and help me improve.`, { type: "agent", id: "tutor" }, courseValues)}>Review result</Link></Button></details>)}</div> : <p className="course-empty-copy">No completed quizzes for this course.</p>}</section></div>
    </section>}
  </div>;
}
