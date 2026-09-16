"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AssistantQuiz, AssistantQuizEvaluation } from "./types";

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The answer could not be checked.");
  return body;
}

export function QuizCard({ quiz, runId, onComplete }: {
  quiz: AssistantQuiz;
  runId?: string;
  onComplete?: (quizAttemptId: string) => void | Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, AssistantQuizEvaluation>>({});
  const [attemptId, setAttemptId] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const answered = Object.keys(results).length;
  const score = useMemo(() => Object.values(results).reduce((sum, result) => sum + result.score, 0), [results]);

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
      setAttemptId(result.quizAttemptId);
      const next = { ...results, [questionId]: result };
      setResults(next);
      if (Object.keys(next).length === quiz.questions.length) await onComplete?.(result.quizAttemptId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The answer could not be checked.");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="assistant-artifact" aria-label={`${quiz.title} quiz`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Interactive quiz · {quiz.difficulty}</p>
          <h3 className="mt-1 text-lg font-semibold">{quiz.title}</h3>
          {quiz.topic && <p className="text-sm muted">{quiz.topic}</p>}
        </div>
        <span className="assistant-score">{answered}/{quiz.questions.length} answered</span>
      </div>
      <div className="mt-5 space-y-5">
        {quiz.questions.map((question, index) => {
          const result = results[question.id];
          const answer = answers[question.id] ?? "";
          return (
            <fieldset key={question.id} className="assistant-question" disabled={Boolean(result)}>
              <legend className="font-medium"><span className="muted mr-2">{index + 1}.</span>{question.prompt}</legend>
              {question.topics.length > 0 && <p className="mt-1 text-xs muted">{question.topics.join(" · ")}</p>}
              {question.choices ? (
                <div className="mt-3 grid gap-2">
                  {question.choices.map((choice) => (
                    <label key={choice} className="assistant-choice">
                      <input type="radio" name={question.id} value={choice} checked={answer === choice} onChange={() => setAnswers((current) => ({ ...current, [question.id]: choice }))} />
                      <span>{choice}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <Textarea className="mt-3 min-h-24" aria-label={`Answer question ${index + 1}`} placeholder="Write your answer…" value={answer} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />
              )}
              {!result && (
                <Button className="mt-3" size="sm" disabled={!answer.trim() || Boolean(busyId)} onClick={() => submit(question.id)}>
                  {busyId === question.id && <Loader2 className="animate-spin" />} Check answer
                </Button>
              )}
              {result && (
                <div className={`assistant-feedback ${result.correct ? "is-correct" : "is-incorrect"}`} role="status">
                  {result.correct ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
                  <div><p className="font-medium">{result.feedback}</p><p className="mt-1 text-sm">{result.explanation}</p></div>
                </div>
              )}
            </fieldset>
          );
        })}
      </div>
      {error && <p className="mt-4 text-sm text-destructive" role="alert">{error}</p>}
      {answered === quiz.questions.length && <p className="mt-5 font-medium" aria-live="polite">Score: {Math.round(score / quiz.questions.length * 100)}%</p>}
    </section>
  );
}
