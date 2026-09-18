"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarCheck2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/features/student/components/empty-state";
import { StudyPlanCard } from "@/features/student/assistant/study-plan-card";
import type { AssistantAction, AssistantStudyPlan } from "@/features/student/assistant/types";

function actionUrl(action: AssistantAction) {
  const query = new URLSearchParams({ prompt: action.prompt });
  query.set(action.targetType, action.targetId);
  const payload = action.payload ?? {};
  for (const key of ["courseId", "assignmentId", "examId", "topicId", "topicName", "studyPlanId"] as const) {
    const value = payload[key];
    if (value) query.set(key, value);
  }
  for (const documentId of payload.documentIds ?? []) query.append("documentId", documentId);
  return `/student/assistant?${query.toString()}`;
}

export function StudyPlanExperience({ initialPlan }: { initialPlan?: AssistantStudyPlan }) {
  const router = useRouter();
  const [plan, setPlan] = useState(initialPlan);

  if (!plan) {
    return <div className="study-plan-page">
      <header className="study-plan-heading">
        <div><p className="eyebrow">Your schedule</p><h1>Study Plan</h1><p>Turn deadlines and learning progress into focused study sessions.</p></div>
      </header>
      <section className="study-plan-empty panel">
        <EmptyState title="Create your first study plan" description="The Study Planner will use your deadlines, available time, and learning progress to build a realistic schedule.">
          <Button asChild><Link href="/student/assistant?agent=study-planner&prompt=Create+a+realistic+study+plan+using+my+current+deadlines+and+learning+progress."><Sparkles /> Create study plan</Link></Button>
        </EmptyState>
      </section>
    </div>;
  }

  const completed = plan.days?.flatMap((day) => day.sessions).filter((task) => task.status === "completed").length ?? 0;
  const total = plan.days?.flatMap((day) => day.sessions).length ?? 0;
  return <div className="study-plan-page">
    <header className="study-plan-heading">
      <div><p className="eyebrow">Your schedule</p><h1>Study Plan</h1><p>Keep the plan current as deadlines, availability, and mastery change.</p></div>
      <Button asChild variant="outline"><Link href={`/student/assistant?agent=study-planner&studyPlanId=${encodeURIComponent(plan.id ?? "")}&prompt=Update+my+current+study+plan+using+my+latest+progress+and+deadlines.`}><Sparkles /> Update plan</Link></Button>
    </header>
    <section className="study-plan-overview" aria-label="Plan overview">
      <div><CalendarCheck2 /><span><strong>{completed} of {total}</strong><small>sessions completed</small></span></div>
      <p>Start a session to open the right AI support with its course and topic context already attached.</p>
    </section>
    <StudyPlanCard initialPlan={plan} onPlanChange={setPlan} onAction={(action) => router.push(actionUrl(action))} />
  </div>;
}
