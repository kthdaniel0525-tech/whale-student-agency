"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, CircleAlert, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AssistantAction, AssistantQuiz, AssistantQuizEvaluation } from "./types";

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The answer could not be checked.");
  return body;
}

function initialResults(quiz: AssistantQuiz) {
  return Object.fromEntries((quiz.attempt?.evaluations ?? []).map((result) => [result.questionId, result]));
}

function firstOpenQuestion(quiz: AssistantQuiz) {
  const answered = new Set(quiz.attempt?.evaluations.map((item) => item.questionId) ?? []);
  const index = quiz.questions.findIndex((question) => !answered.has(question.id));
  return index === -1 ? Math.max(0, quiz.questions.length - 1) : index;
}

export function QuizCard({ quiz, runId, onComplete, onAction }: {
  quiz: AssistantQuiz;
  runId?: string;
  onComplete?: (quizAttemptId: string) => void | Promise<void>;
  onAction?: (action: AssistantAction) => void | Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries((quiz.attempt?.evaluations ?? []).map((result) => [result.questionId, result.userAnswer ?? ""])));
  const [results, setResults] = useState<Record<string, AssistantQuizEvaluation>>(() => initialResults(quiz));
  const [attemptId, setAttemptId] = useState<string | undefined>(quiz.attempt?.id);
  const [currentIndex, setCurrentIndex] = useState(() => firstOpenQuestion(quiz));
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const feedbackRef = useRef<HTMLDivElement>(null);
  const answered = Object.keys(results).length;
  const complete = quiz.questions.length > 0 && answered === quiz.questions.length;
  const score = useMemo(() => Object.values(results).reduce((sum, result) => sum + result.score, 0), [results]);
  const current = quiz.questions[currentIndex];
  const currentResult = current ? results[current.id] : undefined;

  useEffect(() => {
    if (currentResult) feedbackRef.current?.focus();
  }, [currentResult]);

  async function submit(questionId: string) {
    const userAnswer = answers[questionId]?.trim();
    if (!userAnswer || busyId || results[questionId]) return;
    setBusyId(questionId);
    setError(undefined);
    try {
      const result = await responseJson<AssistantQuizEvaluation>(await fetch(`/api/student/assistant/quizzes/${quiz.id}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, userAnswer, ...(attemptId ? { quizAttemptId: attemptId } : {}), ...(runId ? { runId } : {}) }),
      }));
      const stored = { ...result, userAnswer };
      setAttemptId(result.quizAttemptId);
      const next = { ...results, [questionId]: stored };
      setResults(next);
      if (Object.keys(next).length === quiz.questions.length) await onComplete?.(result.quizAttemptId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The answer could not be checked.");
    } finally {
      setBusyId(undefined);
    }
  }

  if (!current) return null;
  const answer = answers[current.id] ?? "";
  const choices = current.choices ?? (current.type === "true-false" ? ["True", "False"] : null);
  const topics = [...new Set(quiz.questions.flatMap((question) => question.topics))];
  const missedTopics = new Set(quiz.questions.flatMap((question) => results[question.id] && !results[question.id].correct ? question.topics : []));
  const strongTopics = topics.filter((topic) => !missedTopics.has(topic));

  return (
    <section className="assistant-artifact assistant-quiz" aria-label={`${quiz.title} quiz`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Interactive quiz · {quiz.difficulty}</p>
          <h3 className="mt-1 text-lg font-semibold">{quiz.title}</h3>
          {quiz.topic && <p className="text-sm muted">{quiz.topic}</p>}
        </div>
        <span className="assistant-score">{answered}/{quiz.questions.length} answered</span>
      </div>
      <div className="assistant-progress" role="progressbar" aria-label="Quiz progress" aria-valuemin={0} aria-valuemax={quiz.questions.length} aria-valuenow={answered}><span style={{ width: `${quiz.questions.length ? answered / quiz.questions.length * 100 : 0}%` }} /></div>
      {quiz.adapted && <p className="mt-3 text-xs muted">Difficulty adjusted based on your recent performance.</p>}

      <fieldset className="assistant-question mt-5" disabled={Boolean(currentResult)}>
        <legend className="w-full">
          <span className="eyebrow">Question {currentIndex + 1} of {quiz.questions.length} · {current.type.replaceAll("-", " ")}</span>
          <span className="mt-2 block font-medium">{current.prompt}</span>
        </legend>
        {current.topics.length > 0 && <p className="mt-1 text-xs muted">{current.topics.join(" · ")}</p>}
        {choices ? (
          <div className="mt-3 grid gap-2">
            {choices.map((choice) => (
              <label key={choice} className="assistant-choice">
                <input aria-label={choice} type="radio" name={current.id} value={choice} checked={answer === choice} onChange={() => setAnswers((value) => ({ ...value, [current.id]: choice }))} />
                <span>{choice}</span>
              </label>
            ))}
          </div>
        ) : (
          <Textarea className={`mt-3 ${current.type === "long-answer" ? "min-h-40" : "min-h-24"}`} aria-label={`Answer question ${currentIndex + 1}`} placeholder="Write your answer…" value={answer} onChange={(event) => setAnswers((value) => ({ ...value, [current.id]: event.target.value }))} />
        )}
        {!currentResult && <Button className="mt-3" size="sm" disabled={!answer.trim() || Boolean(busyId)} onClick={() => submit(current.id)}>{busyId === current.id && <Loader2 className="animate-spin" />} {busyId === current.id ? "Evaluating…" : "Check answer"}</Button>}
      </fieldset>

      {currentResult && (
        <div ref={feedbackRef} tabIndex={-1} className={`assistant-feedback ${currentResult.correct ? "is-correct" : "is-incorrect"}`} role="status" aria-live="polite">
          {currentResult.correct ? <CheckCircle2 size={18} aria-hidden /> : <CircleAlert size={18} aria-hidden />}
          <div><p className="font-medium">{currentResult.correct ? "Correct" : "Needs another look"} · {Math.round(currentResult.score * 100)}%</p><p className="mt-1 text-sm">{currentResult.feedback}</p><p className="mt-1 text-sm">{currentResult.explanation}</p></div>
        </div>
      )}
      {error && <div className="mt-4 flex flex-wrap items-center gap-2" role="alert"><p className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={() => submit(current.id)}><RotateCcw /> Try again</Button></div>}

      <div className="mt-4 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" disabled={currentIndex === 0 || Boolean(busyId)} onClick={() => { setError(undefined); setCurrentIndex((value) => value - 1); }}><ArrowLeft /> Previous</Button>
        {currentIndex < quiz.questions.length - 1 && <Button variant="outline" size="sm" disabled={!currentResult || Boolean(busyId)} onClick={() => { setError(undefined); setCurrentIndex((value) => value + 1); }}>Next question <ArrowRight /></Button>}
      </div>

      {complete && (
        <section className="assistant-quiz-summary" aria-label="Quiz results">
          <p className="eyebrow">Quiz complete</p>
          <p className="mt-1 text-2xl font-semibold">Score: {Math.round(score / quiz.questions.length * 100)}%</p>
          {topics.length > 0 && <p className="mt-2 text-sm"><strong>Topics tested:</strong> {topics.join(", ")}</p>}
          {missedTopics.size > 0 && <p className="mt-2 text-sm"><strong>Needs attention:</strong> {[...missedTopics].join(", ")}</p>}
          {strongTopics.length > 0 && <p className="mt-1 text-sm"><strong>Strengths:</strong> {strongTopics.join(", ")}</p>}
          <p className="mt-2 text-xs muted">Your graded answers were saved. Learning estimates update only where mapped topic evidence exists.</p>
          {onAction && <div className="assistant-actions mt-4">
            {missedTopics.size > 0 && <Button size="sm" onClick={() => onAction({ id: `quiz-review-${quiz.id}`, label: "Review topic", targetType: "agent", targetId: "tutor", prompt: `Review ${[...missedTopics][0]} based on the mistakes in this quiz.`, payload: { topicName: [...missedTopics][0] }, style: "primary" })}>Review topic</Button>}
            <Button size="sm" variant="outline" onClick={() => onAction({ id: `quiz-retry-${quiz.id}`, label: "Try another quiz", targetType: "agent", targetId: "quiz", prompt: `Create another quiz on ${(quiz.topic ?? topics.join(", ")) || "this material"}.` })}>Try another quiz</Button>
          </div>}
        </section>
      )}
    </section>
  );
}
