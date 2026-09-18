import type { CareerReadinessLevel } from "../workflows/career-policy";

export type CareerWorkspaceReadiness = {
  id: "technicalFoundation" | "projectStrength" | "resumeQuality" | "portfolioQuality" | "interviewPreparation" | "applicationReadiness";
  label: string;
  level: CareerReadinessLevel;
  reason: string;
  evidence: string[];
};

export type CareerWorkspace = {
  isEmpty: boolean;
  generatedAt: string;
  evidenceUpdatedAt: string | null;
  analysis: { source: "persisted-career-workflow" | "current-data"; current: boolean; updatedAt: string | null };
  profile: {
    careerGoal: string | null;
    targetRole: string | null;
    targetIndustry: string | null;
    targetRoles: string[];
    targetIndustries: string[];
    targetCompanies: string[];
    applicationTimeline: string | null;
    experiences: string[];
    portfolioLinks: string[];
    resumeText: string | null;
  };
  overview: {
    targetRole: string | null;
    currentFocus: string | null;
    topGap: string | null;
    nextAction: string | null;
  };
  readiness: CareerWorkspaceReadiness[];
  skillGroups: Array<{
    category: string;
    skills: Array<{
      id: string;
      name: string;
      proficiency: string | null;
      evidence: string[];
      projectEvidence: Array<{ id: string; name: string }>;
      courseEvidence: Array<{ id: string; label: string }>;
    }>;
  }>;
  gaps: Array<{
    id: string;
    category: string;
    title: string;
    detail: string;
    priority: "critical" | "high" | "medium";
    projectId: string | null;
  }>;
  projects: Array<{
    id: string;
    name: string;
    description: string;
    technologies: string[];
    role: string | null;
    outcomes: string[];
    link: string | null;
    repositoryUrl: string | null;
    course: { id: string; label: string } | null;
    status: "evidence-ready" | "developing";
    priority: "high" | "medium" | "low";
    priorityReason: string;
    strengths: string[];
    improvements: string[];
  }>;
  resume: {
    status: "missing" | "needs-work" | "ready";
    text: string | null;
    improvements: string[];
    bullets: Array<{ evidenceId: string; original: string; improved: string; rationale: string }>;
    checks: Array<{ label: string; met: boolean; detail: string }>;
  };
  portfolio: {
    status: "missing" | "needs-work" | "ready";
    links: string[];
    improvements: string[];
    gaps: string[];
  };
  careerPlan: null | {
    id: string;
    targetRole: string;
    targetIndustry: string | null;
    startDate: string;
    targetDate: string | null;
    weeklyAvailableMinutes: number;
    totalPlannedMinutes: number;
    summary: string;
    status: "active" | "completed" | "archived";
    tasks: Array<{
      id: string;
      projectId: string | null;
      projectName: string | null;
      weekNumber: number;
      category: string;
      title: string;
      description: string;
      priority: number;
      durationMinutes: number;
      status: "planned" | "in-progress" | "completed" | "skipped";
      targetDate: string | null;
    }>;
  };
  recommendations: Array<{
    id: string;
    title: string;
    message: string;
    priority: "low" | "medium" | "high" | "critical";
  }>;
  nextAction: null | {
    title: string;
    message: string;
    kind: "recommendation" | "career-task" | "gap" | "setup";
    recommendationId?: string;
    projectId?: string;
  };
  limitations: string[];
};
