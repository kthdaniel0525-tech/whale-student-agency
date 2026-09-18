"use client";

import { AssistantActionBar } from "./action-bar";
import { AcademicManagerResult } from "./manager-result";
import { CareerResult } from "./career-result";
import { NotesResult } from "./notes-result";
import { QuizCard } from "./quiz-card";
import { SourceList } from "./source-list";
import { StudyPlanCard } from "./study-plan-card";
import { TutorResult } from "./tutor-result";
import { WorkflowCard } from "./workflow-card";
import type { AIResult, AssistantAction } from "./types";

export function AIResultRenderer({
  result,
  onAction,
  onWorkflowResume,
  onQuizComplete,
  actionBusy,
}: {
  result: AIResult;
  onAction?: (action: AssistantAction) => void | Promise<void>;
  onWorkflowResume?: (runId: string, value: string, kind: "student-work" | "career-data") => Promise<void>;
  onQuizComplete?: (runId: string, attemptId: string) => Promise<void>;
  actionBusy?: boolean;
}) {
  const actions = result.actions ?? [];
  const targetId = result.targetId;
  return (
    <div className="mt-2 space-y-3">
      {result.workflow && (
        <WorkflowCard
          workflow={result.workflow}
          onResume={onWorkflowResume ? (value, kind) => onWorkflowResume(result.workflow!.runId, value, kind) : undefined}
        />
      )}
      {result.quiz && (
        <QuizCard
          quiz={result.quiz}
          runId={result.workflow?.runId}
          onAction={onAction}
          onComplete={result.workflow?.waitingFor?.kind === "quiz" && onQuizComplete
            ? (attemptId) => onQuizComplete(result.workflow!.runId, attemptId)
            : undefined}
        />
      )}
      {result.studyPlan && <StudyPlanCard initialPlan={result.studyPlan} onAction={onAction} />}
      {!result.quiz && !result.studyPlan && !result.workflow && targetId === "tutor" && <TutorResult structuredData={result.structuredData} actions={actions} onAction={onAction} disabled={actionBusy} />}
      {!result.quiz && !result.studyPlan && !result.workflow && targetId === "notes" && <NotesResult structuredData={result.structuredData} actions={actions} onAction={onAction} disabled={actionBusy} />}
      {!result.workflow && targetId === "academic-manager" && <AcademicManagerResult structuredData={result.structuredData} actions={actions} onAction={onAction} disabled={actionBusy} />}
      {!result.workflow && targetId === "career" && <CareerResult structuredData={result.structuredData} actions={actions} onAction={onAction} disabled={actionBusy} />}
      {!result.quiz && !result.studyPlan && !result.workflow && !["tutor", "notes", "academic-manager", "career"].includes(targetId ?? "") && <AssistantActionBar actions={actions} onAction={onAction} disabled={actionBusy} />}
      {result.workflow && <AssistantActionBar actions={actions} onAction={onAction} disabled={actionBusy} />}
      {result.sources?.length ? <SourceList sources={result.sources} /> : null}
    </div>
  );
}
