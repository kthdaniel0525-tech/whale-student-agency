"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Brain,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  GraduationCap,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EntityForm } from "@/features/student/components/entity-form";
import type {
  ProgressRange,
  ProgressTopic,
  StudentProgress,
} from "@/server/progress/types";

type RecommendationAction = {
  target: { type: "agent" | "workflow"; id: string };
  payload: Record<string, string | number | boolean | null>;
};

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Progress could not be updated.");
  return body;
}

function assistantUrl(
  prompt: string,
  target: { type: "agent" | "workflow"; id: string },
  payload: Record<string, string | null | undefined> = {},
) {
  const query = new URLSearchParams({ prompt, [target.type]: target.id });
  for (const [key, value] of Object.entries(payload)) if (value) query.set(key, value);
  return `/student/assistant?${query.toString()}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatLastPracticed(value: string | null) {
  if (!value) return "Not practiced yet";
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000));
  if (days === 0) return "Practiced today";
  if (days === 1) return "Practiced yesterday";
  return `Practiced ${days} days ago`;
}

function topicUrl(topic: ProgressTopic, action: "review" | "practice" | "recovery" | "diagnostic") {
  const payload = { courseId: topic.courseId, topicId: topic.id, topicName: topic.topic };
  if (action === "review") return assistantUrl(
    `Teach me ${topic.topic}, adapting the explanation to my current learning progress.`,
    { type: "agent", id: "tutor" }, payload,
  );
  if (action === "recovery") return assistantUrl(
    `Help me recover my understanding of ${topic.topic}.`,
    { type: "workflow", id: "weak-topic-recovery" }, payload,
  );
  return assistantUrl(
    action === "diagnostic" ? `Give me a diagnostic quiz on ${topic.topic}.` : `Quiz me on ${topic.topic}.`,
    { type: "agent", id: "quiz" }, payload,
  );
}

function TopicRow({ topic, onSelect }: { topic: ProgressTopic; onSelect: () => void }) {
  return (
    <article className="progress-topic-row">
      <button className="progress-topic-select" type="button" onClick={onSelect} aria-label={`View ${topic.topic} details`}>
        <span>
          <strong>{topic.topic}</strong>
          <small>{topic.courseCode} · {topic.confidenceLabel} · {topic.trendLabel}</small>
        </span>
        <span className={`progress-state state-${topic.status}`}>{topic.stateLabel}</span>
        <ChevronRight aria-hidden="true" />
      </button>
      <div className="progress-topic-score">
        <span>{topic.needsMoreData ? "Estimate pending" : `Mastery ${topic.mastery}`}</span>
        {!topic.needsMoreData && <Progress value={topic.mastery} aria-label={`${topic.topic} mastery ${topic.mastery}%`} />}
      </div>
      <div className="progress-topic-actions">
        {topic.needsMoreData ? (
          <Button asChild size="sm" variant="outline"><Link data-product-event={topic.status === "weak" ? "weak_topic_action_clicked" : undefined} href={topicUrl(topic, "diagnostic")}>Diagnostic quiz</Link></Button>
        ) : <>
          <Button asChild size="sm" variant="outline"><Link data-product-event={topic.status === "weak" ? "weak_topic_action_clicked" : undefined} href={topicUrl(topic, "review")}>Review</Link></Button>
          <Button asChild size="sm" variant="outline"><Link data-product-event={topic.status === "weak" ? "weak_topic_action_clicked" : undefined} href={topicUrl(topic, "practice")}>Practice</Link></Button>
          {topic.status === "weak" && <Button asChild size="sm"><Link data-product-event={topic.status === "weak" ? "weak_topic_action_clicked" : undefined} href={topicUrl(topic, "recovery")}>Start recovery</Link></Button>}
        </>}
      </div>
    </article>
  );
}

function TopicDetail({ topic }: { topic: ProgressTopic }) {
  const action = topic.needsMoreData ? "diagnostic" : topic.status === "weak" ? "recovery" : topic.recommendedAction === "review" ? "review" : "practice";
  return (
    <section className="progress-card topic-detail" aria-labelledby="topic-detail-heading">
      <div className="progress-section-heading">
        <div><p className="eyebrow">Topic detail</p><h2 id="topic-detail-heading">{topic.topic}</h2></div>
        <span className={`progress-state state-${topic.status}`}>{topic.stateLabel}</span>
      </div>
      <p className="progress-subtle">{topic.courseCode} · {formatLastPracticed(topic.lastPracticedAt)}</p>
      <div className="topic-detail-metrics">
        <div><span>Mastery</span><strong>{topic.needsMoreData ? "—" : topic.mastery}</strong></div>
        <div><span>Evidence</span><strong>{topic.confidenceLabel}</strong></div>
        <div><span>Recent accuracy</span><strong>{topic.questionsAttempted ? `${topic.recentAccuracy}%` : "—"}</strong></div>
        <div><span>Attempts</span><strong>{topic.questionsAttempted}</strong></div>
      </div>
      {topic.history.length > 1 ? (
        <div className="mastery-history">
          <div className="progress-mini-heading"><strong>Mastery history</strong><span>{topic.trendLabel}</span></div>
          <div className="mastery-history-bars" role="img" aria-label={`${topic.topic} mastery history: ${topic.history.map((point) => `${formatDate(point.date)} ${point.mastery}%`).join(", ")}`}>
            {topic.history.map((point, index) => <i key={`${point.date}-${index}`} style={{ height: `${Math.max(6, point.mastery)}%` }} title={`${formatDate(point.date)}: ${point.mastery}%`} />)}
          </div>
        </div>
      ) : (
        <div className="progress-inline-note"><CircleHelp /> More completed quizzes will build a useful mastery history.</div>
      )}
      {topic.recentQuizzes.length > 0 && <div className="topic-recent-quizzes">
        <div className="progress-mini-heading"><strong>Recent quiz performance</strong><span>{topic.recentQuizzes.length} sessions</span></div>
        {topic.recentQuizzes.map((quiz, index) => <div key={`${quiz.date}-${index}`}><span>{formatDate(quiz.date)} · {quiz.title}<small>{quiz.difficulty}</small></span><strong>{quiz.accuracy}%</strong></div>)}
      </div>}
      <Button asChild className="mt-4"><Link data-product-event={topic.status === "weak" ? "weak_topic_action_clicked" : undefined} href={topicUrl(topic, action)}>
        {action === "diagnostic" ? "Take diagnostic quiz" : action === "recovery" ? "Start topic recovery" : action === "review" ? "Review with Tutor" : "Practice this topic"}
        <ArrowRight />
      </Link></Button>
    </section>
  );
}

export function ProgressExperience({ initial }: { initial: StudentProgress }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [selectedTopicId, setSelectedTopicId] = useState(initial.weakTopics[0]?.id ?? initial.lowEvidenceTopics[0]?.id ?? initial.topics[0]?.id);
  const [refreshing, setRefreshing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string>();
  const selectedTopic = useMemo(() => data.topics.find((topic) => topic.id === selectedTopicId) ?? data.topics[0], [data.topics, selectedTopicId]);

  async function refresh(range: ProgressRange = data.range) {
    setRefreshing(true);
    setError(undefined);
    try {
      const next = await responseJson<StudentProgress>(await fetch(`/api/student/progress?range=${range}`, { cache: "no-store" }));
      setData(next);
      setSelectedTopicId((current) => next.topics.some((topic) => topic.id === current) ? current : next.topics[0]?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Progress could not be refreshed.");
    } finally {
      setRefreshing(false);
    }
  }

  async function launchRecommendation() {
    if (!data.nextBestAction) return;
    setLaunching(true);
    setError(undefined);
    try {
      const action = await responseJson<RecommendationAction>(await fetch(`/api/student/recommendations/${data.nextBestAction.id}/action`, { method: "POST" }));
      router.push(assistantUrl(`${data.nextBestAction.title}. ${data.nextBestAction.message}`, action.target, Object.fromEntries(Object.entries(action.payload).map(([key, value]) => [key, typeof value === "string" ? value : undefined]))));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This action is no longer available.");
      await refresh();
    } finally {
      setLaunching(false);
    }
  }

  if (!data.hasCourses) {
    return (
      <div className="progress-empty progress-card">
        <span className="progress-empty-icon"><GraduationCap /></span>
        <p className="eyebrow">Learning progress</p>
        <h1>Build your academic foundation</h1>
        <p>Add a course, bring in lecture material, or take a quiz to start measuring learning progress.</p>
        <div className="progress-empty-actions">
          <EntityForm kind="course" semester={data.semester} />
          <Button asChild variant="outline"><Link href="/student/documents">Upload lecture</Link></Button>
          <Button asChild variant="outline"><Link href={assistantUrl("Create a diagnostic quiz for one of my courses.", { type: "agent", id: "quiz" })}>Take quiz</Link></Button>
        </div>
      </div>
    );
  }

  const maxStudyMinutes = Math.max(1, ...data.studyConsistency.days.map((day) => day.plannedMinutes));

  return (
    <div className="progress-page">
      <header className="progress-heading">
        <div><p className="eyebrow">{data.semester}</p><h1>Study &amp; progress</h1><p>A clear view of demonstrated learning, study follow-through, and exam preparation.</p></div>
        <div className="progress-controls">
          <label><span className="sr-only">Progress date range</span><select value={data.range} onChange={(event) => refresh(event.target.value as ProgressRange)} disabled={refreshing}>
            <option value="semester">Current semester</option><option value="30d">Last 30 days</option><option value="7d">Last 7 days</option>
          </select></label>
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh</Button>
        </div>
      </header>

      {error && <div className="progress-error" role="alert"><AlertTriangle /> {error}</div>}
      {data.sectionErrors.length > 0 && <div className="progress-warning" role="status" aria-label={`Unavailable progress sections: ${data.sectionErrors.join(", ")}`}>Some progress details are temporarily unavailable. The remaining sections are current.</div>}

      {data.nextBestAction && <section data-recommendation-id={data.nextBestAction.id} className={`progress-next priority-${data.nextBestAction.priority}`} aria-labelledby="progress-next-title">
        <div><span><Sparkles /> Next best action</span><h2 id="progress-next-title">{data.nextBestAction.title}</h2><p>{data.nextBestAction.message}</p></div>
        <Button size="lg" onClick={launchRecommendation} disabled={launching}>{launching ? <Loader2 className="animate-spin" /> : <ArrowRight />}{data.nextBestAction.actionLabel}</Button>
      </section>}

      <section className="progress-overview" aria-label="Progress overview">
        <article><BookOpen /><div><strong>{data.overview.activeCourses}</strong><span>active courses</span></div></article>
        <article><Brain /><div><strong>{data.overview.topicsTracked}</strong><span>topics tracked</span></div></article>
        <article><Target /><div><strong>{data.overview.averageMastery ?? "—"}{data.overview.averageMastery !== null && <small>%</small>}</strong><span>average mastery</span></div></article>
        <article><CheckCircle2 /><div><strong>{data.overview.completedStudyTasksThisWeek}</strong><span>tasks completed this week</span></div></article>
        <article><CalendarClock /><div><strong>{data.overview.upcomingExams}</strong><span>exams in 14 days</span></div></article>
      </section>

      {!data.hasLearningData ? (
        <section className="progress-card progress-no-data">
          <Brain /><div><h2>No learning data yet</h2><p>Take a quiz to start tracking mastery, confidence, and learning trends.</p></div>
          <Button asChild><Link href={assistantUrl("Create a diagnostic quiz using my current course context.", { type: "agent", id: "quiz" })}>Take quiz</Link></Button>
        </section>
      ) : <>
        <div className="progress-main-grid">
          <section className="progress-card" aria-labelledby="needs-attention-heading">
            <div className="progress-section-heading"><div><p className="eyebrow">Learning state</p><h2 id="needs-attention-heading">Needs attention</h2></div><TrendingDown /></div>
            {data.weakTopics.length ? data.weakTopics.map((topic) => <TopicRow key={topic.id} topic={topic} onSelect={() => setSelectedTopicId(topic.id)} />) : <p className="progress-empty-copy">No topic has enough evidence to be classified as weak.</p>}
            {data.lowEvidenceTopics.length > 0 && <div className="low-evidence-group"><h3>Needs more evidence</h3>{data.lowEvidenceTopics.slice(0, 3).map((topic) => <TopicRow key={topic.id} topic={topic} onSelect={() => setSelectedTopicId(topic.id)} />)}</div>}
          </section>
          {selectedTopic && <TopicDetail topic={selectedTopic} />}
        </div>

        <div className="progress-secondary-grid">
          <section className="progress-card" aria-labelledby="strong-topics-heading">
            <div className="progress-section-heading"><div><p className="eyebrow">Reliable strengths</p><h2 id="strong-topics-heading">Strong topics</h2></div><TrendingUp /></div>
            {data.strongTopics.length ? data.strongTopics.map((topic) => <TopicRow key={topic.id} topic={topic} onSelect={() => setSelectedTopicId(topic.id)} />) : <p className="progress-empty-copy">Strong topics will appear after repeated, consistent evidence.</p>}
          </section>
          <section className="progress-card" aria-labelledby="trends-heading">
            <div className="progress-section-heading"><div><p className="eyebrow">Direction</p><h2 id="trends-heading">Learning trends</h2></div><BarChart3 /></div>
            <div className="trend-groups">
              <div><h3><TrendingUp /> Improving</h3>{data.improvingTopics.length ? data.improvingTopics.map((topic) => <button key={topic.id} onClick={() => setSelectedTopicId(topic.id)}><span>{topic.topic}<small>{topic.courseCode}</small></span><strong>{topic.mastery}</strong></button>) : <p>More evidence is needed.</p>}</div>
              <div><h3><TrendingDown /> Declining</h3>{data.decliningTopics.length ? data.decliningTopics.map((topic) => <button key={topic.id} onClick={() => setSelectedTopicId(topic.id)}><span>{topic.topic}<small>{topic.courseCode}</small></span><strong>{topic.mastery}</strong></button>) : <p>No reliable declining trend.</p>}</div>
            </div>
          </section>
        </div>
      </>}

      <section className="progress-card" aria-labelledby="course-progress-heading">
        <div className="progress-section-heading"><div><p className="eyebrow">Current semester</p><h2 id="course-progress-heading">Course progress</h2></div><BookOpen /></div>
        <div className="course-progress-grid">
          {data.courses.map((course) => <article key={course.id}>
            <div><span className="course-code">{course.courseCode}</span><span className={`course-attention attention-${course.attention}`}>{course.attentionLabel}</span></div>
            <h3>{course.courseName}</h3>
            {course.averageMastery === null ? <p>No quiz evidence yet.</p> : <>
              <div className="course-mastery"><strong>{course.averageMastery}%</strong><span>average mastery · confidence {course.averageConfidence}%</span></div>
              <Progress value={course.averageMastery} aria-label={`${course.courseCode} average mastery ${course.averageMastery}%`} />
              <p>{course.needsAttentionTopic ? `Needs attention: ${course.needsAttentionTopic}` : "No reliable weak topic identified."}</p>
              {course.strongTopic && <p>Strong: {course.strongTopic}</p>}
            </>}
          </article>)}
        </div>
      </section>

      <div className="progress-analytics-grid">
        <section className="progress-card" aria-labelledby="study-consistency-heading">
          <div className="progress-section-heading"><div><p className="eyebrow">This week</p><h2 id="study-consistency-heading">Study consistency</h2></div><Clock3 /></div>
          <div className="study-summary"><div><strong>{data.studyConsistency.completedMinutes}</strong><span>completed minutes</span></div><div><strong>{data.studyConsistency.plannedMinutes}</strong><span>planned minutes</span></div><div><strong>{data.studyConsistency.completionRate === null ? "—" : `${data.studyConsistency.completionRate}%`}</strong><span>task completion</span></div></div>
          <div className="weekly-study-chart" role="img" aria-label={data.studyConsistency.days.map((day) => `${day.label}: ${day.completedMinutes} of ${day.plannedMinutes} planned minutes`).join(", ")}>
            {data.studyConsistency.days.map((day) => <div key={day.date}><span className="weekly-bars"><i className="planned" style={{ height: `${Math.max(day.plannedMinutes ? 5 : 0, day.plannedMinutes / maxStudyMinutes * 100)}%` }} /><i className="completed" style={{ height: `${Math.max(day.completedMinutes ? 5 : 0, day.completedMinutes / maxStudyMinutes * 100)}%` }} /></span><small>{day.label}</small></div>)}
          </div>
          <div className="study-legend"><span><i className="completed" /> Completed</span><span><i className="planned" /> Planned</span><span>{data.studyConsistency.skippedTasks} skipped</span></div>
          {data.studyConsistency.insight && <div className="progress-inline-note"><CircleHelp /> {data.studyConsistency.insight}</div>}
        </section>

        <section className="progress-card" aria-labelledby="quiz-performance-heading">
          <div className="progress-section-heading"><div><p className="eyebrow">Recorded practice</p><h2 id="quiz-performance-heading">Quiz performance</h2></div><ClipboardCheck /></div>
          <div className="quiz-summary"><div><strong>{data.quizSummary.completed}</strong><span>completed quizzes</span></div><div><strong>{data.quizSummary.recentAccuracy === null ? "—" : `${data.quizSummary.recentAccuracy}%`}</strong><span>recent accuracy</span></div></div>
          {data.quizSummary.questionTypes.length > 0 && <div className="question-types"><h3>Question type insight</h3>{data.quizSummary.questionTypes.map((item) => <div key={item.type}><span>{item.label}<small>{item.attempts} answers</small></span><strong>{item.accuracy}%</strong></div>)}</div>}
          <div className="quiz-history"><h3>Recent quizzes</h3>{data.quizSummary.history.length ? data.quizSummary.history.slice(0, 6).map((quiz) => <article key={quiz.id}><span><strong>{quiz.courseCode ? `${quiz.courseCode} — ` : ""}{quiz.topic ?? quiz.title}</strong><small>{formatDate(quiz.completedAt)} · {quiz.difficulty} · {quiz.answered} answers</small></span><b>{quiz.accuracy}%</b></article>) : <p className="progress-empty-copy">No completed quizzes in this range.</p>}</div>
        </section>
      </div>

      <div className="progress-analytics-grid">
        <section className="progress-card" aria-labelledby="study-plan-progress-heading">
          <div className="progress-section-heading"><div><p className="eyebrow">Active schedules</p><h2 id="study-plan-progress-heading">Study plan progress</h2></div><CalendarClock /></div>
          {data.activePlans.length ? <div className="active-plans">{data.activePlans.map((plan) => <article key={plan.id}>
            <div><h3>{plan.title}</h3><span>{plan.daysRemaining} days remaining</span></div>
            <p>{plan.completedTasks} / {plan.completedTasks + plan.remainingTasks} tasks complete · {plan.skippedTasks} skipped</p>
            {plan.completionPercentage !== null && <Progress value={plan.completionPercentage} aria-label={`${plan.title} ${plan.completionPercentage}% complete`} />}
            <div><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Open my current study plan: ${plan.title}.`, { type: "agent", id: "study-planner" }, { studyPlanId: plan.id })}>Open plan</Link></Button><Button asChild size="sm"><Link href={assistantUrl(`Adjust my study plan ${plan.title} using my current progress. Preserve completed tasks.`, { type: "agent", id: "study-planner" }, { studyPlanId: plan.id })}>Adjust plan</Link></Button></div>
          </article>)}</div> : <div className="progress-inline-empty"><div><h3>No active study plan</h3><p>Create a realistic schedule using your deadlines and learning state.</p></div><Button asChild><Link href={assistantUrl("Create a study plan using my current deadlines and learning progress.", { type: "agent", id: "study-planner" })}>Create study plan</Link></Button></div>}
        </section>

        <section className="progress-card" aria-labelledby="exam-readiness-heading">
          <div className="progress-section-heading"><div><p className="eyebrow">Upcoming exams</p><h2 id="exam-readiness-heading">Exam readiness</h2></div><GraduationCap /></div>
          {data.examReadiness.length ? <div className="exam-readiness-list">{data.examReadiness.map((exam) => <article key={exam.examId}>
            <div><span><strong>{exam.courseCode} — {exam.title}</strong><small>{exam.daysRemaining} days remaining</small></span><b className={`readiness-${exam.readinessLevel}`}>{exam.readinessLabel}</b></div>
            {exam.readinessScore !== null && exam.readinessLevel !== "insufficient-data" && <Progress value={exam.readinessScore} aria-label={`${exam.title} readiness ${exam.readinessScore}%`} />}
            <p>{exam.explanation}</p>
            {exam.weakTopics[0] && <p><strong>Key weakness:</strong> {exam.weakTopics[0]}</p>}
            <div className="exam-actions"><Button asChild size="sm"><Link data-product-event="exam_readiness_action_clicked" href={assistantUrl(`Prepare me for ${exam.title}.`, { type: "workflow", id: "exam-preparation" }, { courseId: exam.courseId, examId: exam.examId })}>Prepare for exam</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Update my study plan for ${exam.title}.`, { type: "agent", id: "study-planner" }, { courseId: exam.courseId, examId: exam.examId })}>Update plan</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Give me a practice quiz for ${exam.title}.`, { type: "agent", id: "quiz" }, { courseId: exam.courseId, examId: exam.examId })}>Practice quiz</Link></Button></div>
          </article>)}</div> : <p className="progress-empty-copy">No upcoming exam is available in the current planning window.</p>}
        </section>
      </div>
    </div>
  );
}
