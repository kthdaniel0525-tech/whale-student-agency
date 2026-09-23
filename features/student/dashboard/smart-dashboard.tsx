"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  GraduationCap,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  SkipForward,
  Sparkles,
  Target,
  TrendingUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EntityForm } from "@/features/student/components/entity-form";
import type {
  DashboardRecommendation,
  DashboardStudyTask,
  StudentDashboard,
} from "@/server/dashboard/types";

type RecommendationAction = {
  target: { type: "agent" | "workflow"; id: string };
  payload: Record<string, string | number | boolean | null>;
};

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The dashboard could not be updated.");
  return body;
}

function assistantUrl(
  prompt: string,
  target?: { type: "agent" | "workflow"; id: string },
  payload: Record<string, string | number | boolean | null> = {},
) {
  const query = new URLSearchParams({ prompt });
  if (target) query.set(target.type, target.id);
  for (const key of ["courseId", "topicId", "topicName", "examId", "assignmentId", "documentId", "studyPlanId"] as const) {
    const value = payload[key];
    if (typeof value === "string") query.set(key, value);
  }
  return `/student/assistant?${query.toString()}`;
}

function taskTarget(task: DashboardStudyTask): { type: "agent" | "workflow"; id: string } {
  if (task.activityType === "quiz" || task.activityType === "practice" || task.activityType === "mixed-practice")
    return { type: "agent", id: "quiz" };
  if (task.activityType === "notes-review") return { type: "agent", id: "notes" };
  if (task.activityType === "exam-review" && task.examId) return { type: "workflow", id: "exam-preparation" };
  if (task.activityType === "assignment" && task.assignmentId) return { type: "workflow", id: "assignment-support" };
  return { type: "agent", id: "tutor" };
}

function taskPrompt(task: DashboardStudyTask) {
  if (task.activityType === "quiz" || task.activityType === "practice" || task.activityType === "mixed-practice")
    return `Quiz me for this study task: ${task.title}.`;
  if (task.activityType === "notes-review") return `Help me review notes for this study task: ${task.title}.`;
  if (task.activityType === "exam-review") return `Continue exam preparation for this study task: ${task.title}.`;
  if (task.activityType === "assignment") return `Help me work on this assignment task: ${task.title}.`;
  return `Help me start this study task: ${task.title}.`;
}

function priorityClass(priority: DashboardRecommendation["priority"]) {
  return priority === "critical" || priority === "high" ? "is-high" : priority === "medium" ? "is-medium" : "is-low";
}

function readinessLabel(value: StudentDashboard["examReadiness"][number]["readinessLevel"]) {
  return value === "insufficient-data" ? "Needs more data" : value[0].toUpperCase() + value.slice(1);
}

export function SmartDashboard({ initial }: { initial: StudentDashboard }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  async function refresh() {
    setRefreshing(true);
    try {
      setData(await responseJson<StudentDashboard>(await fetch("/api/student/dashboard", { cache: "no-store" })));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The dashboard could not be refreshed.");
    } finally {
      setRefreshing(false);
    }
  }

  async function launchRecommendation(item: DashboardRecommendation) {
    setBusy(`recommendation:${item.id}`);
    setError(undefined);
    try {
      const action = await responseJson<RecommendationAction>(await fetch(`/api/student/recommendations/${item.id}/action`, { method: "POST" }));
      router.push(assistantUrl(`${item.title}. ${item.message}`, action.target, action.payload));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This action is no longer available.");
      await refresh();
    } finally {
      setBusy(undefined);
    }
  }

  async function dismissRecommendation(id: string) {
    setBusy(`dismiss:${id}`);
    setError(undefined);
    try {
      await responseJson(await fetch(`/api/student/recommendations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      }));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The recommendation could not be dismissed.");
    } finally {
      setBusy(undefined);
    }
  }

  async function updateTask(task: DashboardStudyTask, status: "in-progress" | "completed" | "skipped", launch = false) {
    setBusy(`task:${task.id}`);
    setError(undefined);
    try {
      await responseJson(await fetch(`/api/student/assistant/study-tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }));
      if (launch) {
        router.push(assistantUrl(taskPrompt(task), taskTarget(task), {
          ...(task.courseId ? { courseId: task.courseId } : {}),
          ...(task.topicId ? { topicId: task.topicId } : {}),
          ...(task.topic ? { topicName: task.topic } : {}),
          ...(task.examId ? { examId: task.examId } : {}),
          ...(task.assignmentId ? { assignmentId: task.assignmentId } : {}),
        }));
        return;
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The study task could not be updated.");
    } finally {
      setBusy(undefined);
    }
  }

  const nextExam = data.upcomingDeadlines.find((item) => item.kind === "exam");
  const weakest = data.weakTopics[0];

  if (!data.hasCourses) {
    return (
      <div className="dashboard-empty panel">
        <span className="dashboard-empty-icon"><GraduationCap /></span>
        <p className="eyebrow">Welcome</p>
        <h1>Start with your first course</h1>
        <p>Add a course to organize deadlines, study plans, learning progress, and personalized AI support.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <EntityForm kind="course" semester={data.semester} />
          <Button asChild variant="outline"><Link href="/student/assistant"><MessageSquare /> Ask AI</Link></Button>
        </div>
      </div>
    );
  }

  return (
    <div className="smart-dashboard">
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">{data.semester}</p>
          <h1>{data.greeting}</h1>
          <p>{data.summary}</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing} aria-label="Refresh dashboard">
          <RefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh
        </Button>
      </header>

      {error && <div className="dashboard-error" role="alert"><AlertTriangle /> <span>{error}</span></div>}
      {data.sectionErrors.length > 0 && (
        <div className="dashboard-section-warning" role="status">
          Some dashboard details are temporarily unavailable. The available sections remain current.
        </div>
      )}

      <section data-recommendation-id={data.nextBestAction?.id} className={`dashboard-next ${data.nextBestAction ? priorityClass(data.nextBestAction.priority) : "is-caught-up"}`} aria-labelledby="next-action-title">
        <div className="dashboard-next-copy">
          <div className="flex flex-wrap items-center gap-2">
            <span className="dashboard-priority"><Sparkles /> {data.nextBestAction ? `${data.nextBestAction.priority} priority` : "On track"}</span>
            {data.nextBestAction?.courseLabel && <span className="dashboard-course-pill">{data.nextBestAction.courseLabel}</span>}
          </div>
          <h2 id="next-action-title">{data.nextBestAction?.title ?? "You’re caught up"}</h2>
          <p>{data.nextBestAction?.message ?? (data.upcomingDeadlines[0] ? `Your next item is ${data.upcomingDeadlines[0].courseCode} ${data.upcomingDeadlines[0].title} — ${data.upcomingDeadlines[0].dateLabel.toLowerCase()}.` : "No urgent academic action is supported by your current data.")}</p>
        </div>
        {data.nextBestAction ? (
          <Button data-product-event="next_best_action_clicked" size="lg" onClick={() => launchRecommendation(data.nextBestAction!)} disabled={Boolean(busy)}>
            {busy === `recommendation:${data.nextBestAction.id}` ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            {data.nextBestAction.actionLabel}
          </Button>
        ) : (
          <Button asChild size="lg"><Link data-product-event="study_now_clicked" href={assistantUrl("What should I study right now?", { type: "agent", id: "study-planner" })}><Play /> Study now</Link></Button>
        )}
      </section>

      <section className="dashboard-quick-actions" aria-label="Quick AI actions">
        <Link href="/student/assistant"><MessageSquare /> Ask AI</Link>
        <Link data-product-event="study_now_clicked" href={assistantUrl("What should I study right now?", { type: "agent", id: "study-planner" })}><Play /> Study now</Link>
        <Link href={assistantUrl("Quiz me on what I most need to practice.", { type: "agent", id: "quiz" }, weakest ? { courseId: weakest.courseId, topicId: weakest.id, topicName: weakest.topic } : {})}><Target /> Quiz me</Link>
        {nextExam && <Link href={assistantUrl(`Prepare me for ${nextExam.title}.`, { type: "workflow", id: "exam-preparation" }, { courseId: nextExam.courseId, examId: nextExam.id })}><CalendarDays /> Prepare for exam</Link>}
        {weakest && <Link href={assistantUrl(`Help me review ${weakest.topic}.`, { type: "agent", id: weakest.needsMoreData ? "quiz" : "tutor" }, { courseId: weakest.courseId, topicId: weakest.id, topicName: weakest.topic })}><Brain /> Review weakest topic</Link>}
      </section>

      <div className="dashboard-primary-grid">
        <section className="dashboard-section" aria-labelledby="today-focus-title">
          <div className="dashboard-section-heading">
            <div><p className="eyebrow">Today</p><h2 id="today-focus-title">Today’s focus</h2></div>
            <span>{data.todayTasks.reduce((sum, task) => task.status === "skipped" ? sum : sum + task.durationMinutes, 0)} min</span>
          </div>
          {data.todayTasks.length ? (
            <div className="dashboard-task-list">
              {data.todayTasks.map((task) => (
                <article className={`dashboard-task is-${task.status}`} key={task.id}>
                  <span className="dashboard-task-icon">{task.status === "completed" ? <CheckCircle2 /> : task.status === "skipped" ? <SkipForward /> : <Circle />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3>{task.title}</h3><span className="dashboard-activity">{task.activityType}</span>{(task.status === "completed" || task.status === "skipped") && <span className="dashboard-task-state">{task.status === "completed" ? "Completed" : "Skipped"}</span>}</div>
                    <p>{task.courseCode ?? task.topic ?? "Study plan"} · {task.durationMinutes} min</p>
                    <small>{task.reason}</small>
                  </div>
                  {task.status !== "completed" && task.status !== "skipped" && (
                    <div className="dashboard-task-actions">
                      <Button size="sm" onClick={() => updateTask(task, "in-progress", true)} disabled={Boolean(busy)}><Play /> Start</Button>
                      <Button size="icon-sm" variant="outline" aria-label={`Complete ${task.title}`} onClick={() => updateTask(task, "completed")} disabled={Boolean(busy)}><Check /></Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Skip ${task.title}`} onClick={() => updateTask(task, "skipped")} disabled={Boolean(busy)}><SkipForward /></Button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="dashboard-inline-empty">
              <CalendarDays /><div><h3>No study tasks scheduled today</h3><p>Build a realistic plan around your courses and availability.</p></div>
              <Button asChild variant="outline"><Link href={assistantUrl("Create a study plan for me.", { type: "agent", id: "study-planner" })}>Create with AI</Link></Button>
            </div>
          )}
        </section>

        <section className="dashboard-section" aria-labelledby="upcoming-title">
          <div className="dashboard-section-heading"><div><p className="eyebrow">Deadlines</p><h2 id="upcoming-title">Upcoming</h2></div><span>Next {data.upcomingDeadlines.length}</span></div>
          {data.upcomingDeadlines.length ? <div className="dashboard-deadlines">{data.upcomingDeadlines.map((item) => (
            <Link data-product-event="upcoming_deadline_opened" href={`/student/courses/${item.courseId}`} key={`${item.kind}-${item.id}`}>
              <span className={`dashboard-deadline-icon is-${item.kind}`}>{item.kind === "exam" ? <GraduationCap /> : <BookOpen />}</span>
              <span className="min-w-0 flex-1"><small>{item.courseCode} · {item.kind}</small><strong>{item.title}</strong></span>
              <span className={item.dateLabel === "Overdue" || item.dateLabel === "Today" ? "is-urgent" : ""}>{item.dateLabel}</span>
            </Link>
          ))}</div> : <div className="dashboard-inline-empty"><CheckCircle2 /><div><h3>No upcoming deadlines</h3><p>Your recorded assignments and exams are clear.</p></div></div>}
        </section>
      </div>

      <div className="dashboard-secondary-grid">
        <section className="dashboard-section" aria-labelledby="recommendations-title">
          <div className="dashboard-section-heading"><div><p className="eyebrow">Personalized</p><h2 id="recommendations-title">Recommendations</h2></div></div>
          {data.recommendations.length ? <div className="dashboard-recommendations">{data.recommendations.map((item) => (
            <article key={item.id} data-recommendation-id={item.id}>
              <div className="min-w-0 flex-1"><span className={`dashboard-small-priority ${priorityClass(item.priority)}`}>{item.priority}</span><h3>{item.title}</h3><p>{item.message}</p></div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="outline" onClick={() => launchRecommendation(item)} disabled={Boolean(busy)}>{busy === `recommendation:${item.id}` ? <Loader2 className="animate-spin" /> : <ArrowRight />} Start</Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Dismiss ${item.title}`} onClick={() => dismissRecommendation(item.id)} disabled={Boolean(busy)}>{busy === `dismiss:${item.id}` ? <Loader2 className="animate-spin" /> : <X />}</Button>
              </div>
            </article>
          ))}</div> : <div className="dashboard-inline-empty"><CheckCircle2 /><div><h3>You’re caught up</h3><p>No additional high-value recommendation is active.</p></div></div>}
        </section>

        <section className="dashboard-section" aria-labelledby="plan-progress-title">
          <div className="dashboard-section-heading"><div><p className="eyebrow">Study plan</p><h2 id="plan-progress-title">This week</h2></div></div>
          {data.studyPlanProgress ? <div className="dashboard-plan-progress">
            <div className="flex items-end justify-between gap-3"><div><strong>{data.studyPlanProgress.completed} / {data.studyPlanProgress.completed + data.studyPlanProgress.remaining}</strong><p>tasks completed</p></div><span>{data.studyPlanProgress.percentage}%</span></div>
            <Progress value={data.studyPlanProgress.percentage} aria-label={`${data.studyPlanProgress.percentage}% of active study plans complete`} />
            <div className="dashboard-plan-counts"><span><CheckCircle2 /> {data.studyPlanProgress.completed} completed</span><span><Clock3 /> {data.studyPlanProgress.remaining} remaining</span><span><SkipForward /> {data.studyPlanProgress.skipped} skipped</span></div>
          </div> : <div className="dashboard-inline-empty"><CalendarDays /><div><h3>No active study plan</h3><p>Create one with AI using your deadlines and learning state.</p></div><Button asChild variant="outline"><Link href={assistantUrl("Create a study plan for me.", { type: "agent", id: "study-planner" })}>Create with AI</Link></Button></div>}
        </section>
      </div>

      <div className="dashboard-insight-grid">
        <section className="dashboard-section" aria-labelledby="learning-title">
          <div className="dashboard-section-heading"><div><p className="eyebrow">Learning</p><h2 id="learning-title">Learning progress</h2></div><TrendingUp /></div>
          {data.weakTopics.length || data.strongTopics.length || data.improvingTopics.length ? (
            <div className="dashboard-learning-groups">
              {data.weakTopics.length > 0 && <div><h3>Needs attention</h3>{data.weakTopics.map((item) => <article key={item.id}><div><strong>{item.topic}</strong><small>{item.courseCode} · {item.stateLabel}</small></div><span>{item.needsMoreData ? "—" : item.mastery}</span>{!item.needsMoreData && <Progress value={item.mastery} aria-label={`${item.topic} mastery ${item.mastery}%`} />}</article>)}</div>}
              {data.improvingTopics.length > 0 && <div><h3>Improving</h3>{data.improvingTopics.map((item) => <article key={item.id}><div><strong>{item.topic}</strong><small>{item.courseCode} · Improving</small></div><span>{item.mastery}</span><Progress value={item.mastery} aria-label={`${item.topic} mastery ${item.mastery}%`} /></article>)}</div>}
              {data.strongTopics.length > 0 && <div><h3>Strong</h3>{data.strongTopics.map((item) => <article key={item.id}><div><strong>{item.topic}</strong><small>{item.courseCode} · Strong</small></div><span>{item.mastery}</span><Progress value={item.mastery} aria-label={`${item.topic} mastery ${item.mastery}%`} /></article>)}</div>}
            </div>
          ) : <div className="dashboard-inline-empty"><Brain /><div><h3>Build your learning picture</h3><p>Complete a quiz to start tracking topic mastery and confidence.</p></div><Button asChild variant="outline"><Link href={assistantUrl("Quiz me to measure my current understanding.", { type: "agent", id: "quiz" })}>Take a quiz</Link></Button></div>}
        </section>

        <section className="dashboard-section" aria-labelledby="readiness-title">
          <div className="dashboard-section-heading"><div><p className="eyebrow">Exams</p><h2 id="readiness-title">Exam readiness</h2></div><GraduationCap /></div>
          {data.examReadiness.length ? <div className="dashboard-readiness">{data.examReadiness.map((exam) => (
            <article key={exam.examId}>
              <div className="flex items-start justify-between gap-3"><div><small>{exam.courseCode} · {exam.daysRemaining === 0 ? "Today" : `${exam.daysRemaining} days`}</small><h3>{exam.title}</h3></div><span className={`readiness-${exam.readinessLevel}`}>{readinessLabel(exam.readinessLevel)}</span></div>
              {exam.readinessScore !== null && exam.readinessLevel !== "insufficient-data" && <Progress value={exam.readinessScore} aria-label={`${exam.title} readiness ${exam.readinessScore}%`} />}
              <p>{exam.weakTopics.length ? `Weakest: ${exam.weakTopics[0]}` : exam.readinessLevel === "insufficient-data" ? "Complete relevant quizzes to establish readiness." : "No high-confidence weak exam topic identified."}</p>
            </article>
          ))}</div> : <div className="dashboard-inline-empty"><CalendarDays /><div><h3>No upcoming exam readiness yet</h3><p>Add an exam with topics to connect practice evidence.</p></div></div>}
        </section>
      </div>

      {data.risks.length > 0 && <section className="dashboard-risks" aria-labelledby="risks-title"><div><p className="eyebrow">Attention</p><h2 id="risks-title">Academic risks</h2></div><div>{data.risks.map((risk) => <article key={risk.id}><AlertTriangle /><span><strong>{risk.level === "high" ? "High priority" : "Needs attention"}</strong>{risk.reason}</span></article>)}</div></section>}

      <section className="dashboard-courses" aria-labelledby="courses-title">
        <div className="dashboard-section-heading"><div><p className="eyebrow">Courses</p><h2 id="courses-title">Course overview</h2></div><Link href="/student/courses">View all <ArrowRight /></Link></div>
        <div className="dashboard-course-grid">{data.courses.map((course) => <Link href={`/student/courses/${course.id}`} key={course.id}><div className="flex items-start justify-between gap-3"><span className="dashboard-course-code">{course.courseCode}</span><span className={`dashboard-attention is-${course.attention}`}>{course.attentionLabel}</span></div><h3>{course.courseName}</h3>{course.nextDeadline ? <p><CalendarDays /> {course.nextDeadline.title} · {course.nextDeadline.dateLabel}</p> : <p><CheckCircle2 /> No near deadline</p>}</Link>)}</div>
      </section>
    </div>
  );
}
