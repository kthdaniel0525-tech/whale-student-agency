"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowRight, BriefcaseBusiness, Check, CheckCircle2, ChevronDown, CircleAlert,
  ExternalLink, FileText, FolderGit2, GitBranch, Lightbulb, Loader2, Play, RefreshCw,
  SkipForward, Sparkles, Target, WandSparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/student/client";
import type { CareerWorkspace as CareerWorkspaceData } from "@/server/career-workspace/types";
import { CareerProfileForm, ProjectForm, SkillForm } from "./forms";

function assistantUrl(prompt: string, data: CareerWorkspaceData, options: { workflow?: boolean; projectId?: string } = {}) {
  const query = new URLSearchParams({ prompt });
  query.set(options.workflow ? "workflow" : "agent", options.workflow ? "career-preparation" : "career");
  if (data.profile.targetRole) query.set("targetRole", data.profile.targetRole);
  if (data.profile.targetIndustry) query.set("targetIndustry", data.profile.targetIndustry);
  if (data.profile.applicationTimeline) query.set("applicationTimeline", data.profile.applicationTimeline);
  for (const company of data.profile.targetCompanies) query.append("targetCompanies", company);
  if (options.projectId) query.set("projectId", options.projectId);
  return `/student/assistant?${query}`;
}

const date = (value: string | null) => value ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value)) : "No date";
const statusLabel = (value: string) => value.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");

export function CareerWorkspace({ initial }: { initial: CareerWorkspaceData }) {
  const router = useRouter();
  const [busyTask, setBusyTask] = useState<string>();
  const [usingBullet, setUsingBullet] = useState<string>();

  async function updateTask(id: string, status: "in-progress" | "completed" | "skipped") {
    setBusyTask(id);
    try { await request(`/api/student/career/tasks/${id}`, "PATCH", { status }); toast.success(`Career task ${status === "completed" ? "completed" : status}.`); router.refresh(); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "Unable to update the task."); }
    finally { setBusyTask(undefined); }
  }

  async function applyBullet(original: string, improved: string) {
    setUsingBullet(original);
    try {
      const current = initial.profile.resumeText ?? "";
      const next = current.includes(original) ? current.replace(original, improved) : [current.trim(), improved].filter(Boolean).join("\n");
      await request("/api/student/career/profile", "PUT", {
        careerGoal: initial.profile.careerGoal, targetRoles: initial.profile.targetRoles, targetIndustries: initial.profile.targetIndustries,
        targetCompanies: initial.profile.targetCompanies, applicationTimeline: initial.profile.applicationTimeline,
        experiences: initial.profile.experiences, portfolioLinks: initial.profile.portfolioLinks, resumeText: next,
      });
      toast.success("Resume text updated."); router.refresh();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Unable to update the resume."); }
    finally { setUsingBullet(undefined); }
  }

  if (initial.isEmpty) return <div className="career-page career-empty">
    <section><span className="career-empty-icon"><BriefcaseBusiness /></span><p className="eyebrow">Career workspace</p><h1>Start your career profile</h1><p>Choose a target role, add projects, and record skills with evidence. Your workspace will use these details without running AI in the background.</p>
      <ol><li><strong>1</strong> Choose a target role</li><li><strong>2</strong> Add projects</li><li><strong>3</strong> Add skills and evidence</li></ol>
      <div className="career-actions"><CareerProfileForm profile={initial.profile} compact /><ProjectForm /><SkillForm /></div>
    </section>
  </div>;

  const highGap = initial.gaps[0];
  const buildPlanUrl = assistantUrl(`Build or update my career preparation plan${initial.profile.targetRole ? ` for ${initial.profile.targetRole}` : ""}. Use my current saved evidence and avoid inventing experience.`, initial, { workflow: true });
  return <div className="career-page">
    <header className="career-heading"><div><p className="eyebrow">Career workspace</p><h1>Build evidence for your next role</h1><p>Manage your goals, proof of work, resume, and the next practical step.</p></div><div className="career-actions"><CareerProfileForm profile={initial.profile} /><Button asChild><Link href={buildPlanUrl}><Sparkles /> Build / update career plan</Link></Button></div></header>

    {initial.limitations.length > 0 && <div className="career-notice" role="status"><CircleAlert /> <span>{initial.limitations[0]}</span></div>}

    <section className="career-hero" aria-labelledby="career-overview-title">
      <div><p className="eyebrow">Career overview</p><h2 id="career-overview-title">{initial.profile.targetRole ?? "Target role not set"}</h2><p>{initial.profile.careerGoal ?? "Add a target role and career goal to focus the workspace."}</p>
        <dl><div><dt>Current focus</dt><dd>{initial.overview.currentFocus ?? "Add career evidence"}</dd></div><div><dt>Top gap</dt><dd>{initial.overview.topGap ?? "No current high-value gap"}</dd></div><div><dt>Industry</dt><dd>{initial.profile.targetIndustry ?? "Not set"}</dd></div><div><dt>Timeline</dt><dd>{initial.profile.applicationTimeline ?? "Not set"}</dd></div>{initial.profile.targetCompanies.length > 0 && <div><dt>Target companies</dt><dd>{initial.profile.targetCompanies.join(", ")}</dd></div>}</dl>
      </div>
      <aside><span>Next action</span><h3>{initial.nextAction?.title ?? "Review your career profile"}</h3><p>{initial.nextAction?.message ?? "Keep projects, skills, and resume evidence current."}</p><Button asChild><Link href={initial.nextAction?.projectId ? assistantUrl(`Help me complete this next career action: ${initial.nextAction.title}.`, initial, { projectId: initial.nextAction.projectId }) : buildPlanUrl}>Start next action <ArrowRight /></Link></Button></aside>
    </section>

    <nav className="career-section-nav" aria-label="Career workspace sections"><a href="#readiness">Readiness</a><a href="#skills">Skills</a><a href="#projects">Projects</a><a href="#resume">Resume</a><a href="#portfolio">Portfolio</a><a href="#plan">Career plan</a></nav>

    <section id="readiness" className="career-section" aria-labelledby="readiness-title"><div className="career-section-heading"><div><p className="eyebrow">Evidence, not a score</p><h2 id="readiness-title">Career readiness</h2><p>Qualitative signals based only on the information you saved.</p></div><Target /></div>
      <div className="readiness-grid">{initial.readiness.map((item) => <article key={item.id}><div><h3>{item.label}</h3><Badge variant="outline" className={`career-level level-${item.level}`}>{statusLabel(item.level)}</Badge></div><p>{item.reason}</p><ul>{item.evidence.map((evidence) => <li key={evidence}><Check /> {evidence}</li>)}</ul></article>)}</div>
    </section>

    <div className="career-two-column">
      <section id="skills" className="career-section" aria-labelledby="skills-title"><div className="career-section-heading"><div><p className="eyebrow">Supported capabilities</p><h2 id="skills-title">Skills &amp; evidence</h2></div><SkillForm /></div>
        {initial.skillGroups.length ? <div className="skill-groups">{initial.skillGroups.map((group) => <div key={group.category}><h3>{group.category}</h3>{group.skills.map((skill) => <article key={skill.id}><div><strong>{skill.name}</strong><SkillForm skill={{ ...skill, category: group.category }} /></div>{skill.proficiency && <small>Self-reported: {skill.proficiency}</small>}<ul>{skill.evidence.map((item) => <li key={item}>{item}</li>)}{skill.projectEvidence.map((item) => <li key={item.id}>Project: {item.name}</li>)}{skill.courseEvidence.map((item) => <li key={item.id}>Course: {item.label}</li>)}</ul>{!skill.evidence.length && !skill.projectEvidence.length && !skill.courseEvidence.length && <p>No supporting evidence added yet.</p>}</article>)}</div>)}</div> : <p className="career-empty-copy">Add a skill and connect it to real project, course, or experience evidence.</p>}
      </section>
      <section className="career-section career-gaps" aria-labelledby="gaps-title"><div className="career-section-heading"><div><p className="eyebrow">High-value gaps</p><h2 id="gaps-title">Needs attention</h2></div><Lightbulb /></div>
        {initial.gaps.length ? initial.gaps.map((gap) => <article key={gap.id}><span className={`gap-priority priority-${gap.priority}`}>{statusLabel(gap.priority)}</span><h3>{gap.title}</h3><p>{gap.detail}</p><Button asChild variant="outline" size="sm"><Link href={assistantUrl(`Help me address this career gap: ${gap.title}. ${gap.detail}`, initial, gap.projectId ? { projectId: gap.projectId } : {})}>Improve with Career AI</Link></Button></article>) : <p className="career-empty-copy">No current high-value gap is supported by the saved evidence.</p>}
      </section>
    </div>

    <section id="projects" className="career-section" aria-labelledby="projects-title"><div className="career-section-heading"><div><p className="eyebrow">Proof of work</p><h2 id="projects-title">Projects</h2><p>Priorities come from the latest current career analysis or from missing evidence checks.</p></div><ProjectForm /></div>
      <div className="career-projects">{initial.projects.length ? initial.projects.map((project) => <article id={`project-${project.id}`} key={project.id} className={`project-card priority-${project.priority}`}><div className="project-card-top"><div><span>{statusLabel(project.priority)} priority</span><h3>{project.name}</h3></div><ProjectForm project={project} /></div><p>{project.description}</p><div className="project-tags">{project.technologies.map((technology) => <span key={technology}>{technology}</span>)}</div><p className="project-reason"><strong>Why now:</strong> {project.priorityReason}</p>
        <details><summary>Open project details <ChevronDown /></summary><div className="project-detail"><dl><div><dt>Role</dt><dd>{project.role ?? "Not added"}</dd></div><div><dt>Status</dt><dd>{statusLabel(project.status)}</dd></div>{project.course && <div><dt>Course evidence</dt><dd>{project.course.label}</dd></div>}</dl><div><h4>Outcomes</h4>{project.outcomes.length ? <ul>{project.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul> : <p>No outcomes added.</p>}</div><div><h4>Current strengths</h4><ul>{project.strengths.map((item) => <li key={item}>{item}</li>)}</ul></div><div><h4>Recommended improvements</h4><ul>{project.improvements.map((item) => <li key={item}>{item}</li>)}</ul></div><div className="project-links">{project.repositoryUrl && <a href={project.repositoryUrl} target="_blank" rel="noreferrer"><GitBranch /> Repository <ExternalLink /></a>}{project.link && <a href={project.link} target="_blank" rel="noreferrer"><ExternalLink /> Live project</a>}</div></div></details>
        <div className="project-actions"><Button asChild size="sm"><Link href={assistantUrl(`Review ${project.name} and suggest the highest-impact truthful improvements.`, initial, { projectId: project.id })}>Improve project</Link></Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Generate truthful resume bullets for ${project.name} using only its saved evidence.`, initial, { projectId: project.id })}>Resume bullets</Link></Button><Button asChild size="sm" variant="ghost"><Link href={assistantUrl(`Review the portfolio value of ${project.name} for my target role.`, initial, { projectId: project.id })}>Portfolio value</Link></Button></div>
      </article>) : <p className="career-empty-copy">No projects saved yet.</p>}</div>
    </section>

    <div className="career-two-column">
      <section id="resume" className="career-section" aria-labelledby="resume-title"><div className="career-section-heading"><div><p className="eyebrow">Resume workspace</p><h2 id="resume-title">Resume · {statusLabel(initial.resume.status)}</h2></div><FileText /></div>
        <div className="resume-checks">{initial.resume.checks.map((check) => <div key={check.label} className={check.met ? "is-met" : "needs-work"}>{check.met ? <CheckCircle2 /> : <CircleAlert />}<span><strong>{check.label}</strong><small>{check.detail}</small></span></div>)}</div>
        {initial.resume.text ? <details className="resume-text"><summary>View saved resume text <ChevronDown /></summary><pre>{initial.resume.text}</pre></details> : <p className="career-empty-copy">Add resume text in your career profile to begin an evidence-based review.</p>}
        <ul className="career-improvements">{initial.resume.improvements.map((item) => <li key={item}>{item}</li>)}</ul>
        {initial.resume.bullets.map((bullet) => <article className="resume-bullet" key={`${bullet.evidenceId}:${bullet.original}`}><span>Original</span><p>{bullet.original}</p><span>Improved</span><p>{bullet.improved}</p><small>{bullet.rationale}</small><div><Button size="sm" onClick={() => applyBullet(bullet.original, bullet.improved)} disabled={usingBullet === bullet.original}>{usingBullet === bullet.original ? <Loader2 className="animate-spin" /> : <Check />} Use this</Button><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`Make this truthful resume bullet more technical without inventing metrics: ${bullet.improved}`, initial)}>Make more technical</Link></Button><Button asChild size="sm" variant="ghost"><Link href={assistantUrl(`Shorten this truthful resume bullet without changing its claim: ${bullet.improved}`, initial)}>Shorten</Link></Button></div></article>)}
        <div className="career-actions"><CareerProfileForm profile={initial.profile} /><Button asChild variant="outline"><Link href={assistantUrl("Review my saved resume for clarity, technical specificity, and target-role relevance. Do not invent metrics.", initial)}><WandSparkles /> Improve resume</Link></Button></div>
      </section>
      <section id="portfolio" className="career-section" aria-labelledby="portfolio-title"><div className="career-section-heading"><div><p className="eyebrow">Selected evidence</p><h2 id="portfolio-title">Portfolio · {statusLabel(initial.portfolio.status)}</h2></div><FolderGit2 /></div>
        {initial.portfolio.links.length ? <ul className="portfolio-links">{initial.portfolio.links.map((link) => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link}<ExternalLink /></a></li>)}</ul> : <p className="career-empty-copy">No portfolio link is saved.</p>}
        <div className="portfolio-gaps"><h3>Portfolio gaps</h3>{initial.portfolio.gaps.length ? initial.portfolio.gaps.map((gap) => <p key={gap}><CircleAlert /> {gap}</p>) : <p>No current project-level gap is identified.</p>}</div>
        <ul className="career-improvements">{initial.portfolio.improvements.map((item) => <li key={item}>{item}</li>)}</ul>
        <Button asChild variant="outline"><Link href={assistantUrl("Review my saved portfolio evidence and recommend concrete improvements for my target role.", initial)}>Review portfolio</Link></Button>
      </section>
    </div>

    <section id="plan" className="career-section career-plan" aria-labelledby="plan-title"><div className="career-section-heading"><div><p className="eyebrow">Preparation roadmap</p><h2 id="plan-title">{initial.careerPlan?.targetRole ? `${initial.careerPlan.targetRole} plan` : "Career plan"}</h2><p>{initial.careerPlan?.summary ?? "Build a plan with the existing Career Preparation workflow."}</p></div><Button asChild><Link href={buildPlanUrl}><RefreshCw /> {initial.careerPlan ? "Update plan" : "Build plan"}</Link></Button></div>
      {initial.careerPlan ? <><dl className="plan-overview"><div><dt>Timeline</dt><dd>{date(initial.careerPlan.startDate)} – {date(initial.careerPlan.targetDate)}</dd></div><div><dt>Weekly availability</dt><dd>{initial.careerPlan.weeklyAvailableMinutes} minutes</dd></div><div><dt>Total planned</dt><dd>{initial.careerPlan.totalPlannedMinutes} minutes</dd></div></dl><div className="career-tasks">{initial.careerPlan.tasks.map((task) => <article key={task.id} className={`task-${task.status}`}><div className="task-status-icon">{task.status === "completed" ? <CheckCircle2 /> : task.status === "in-progress" ? <Play /> : task.status === "skipped" ? <SkipForward /> : <span>{task.weekNumber}</span>}</div><div><span>{statusLabel(task.category)} · {task.durationMinutes} min · {date(task.targetDate)}</span><h3>{task.title}</h3><p>{task.description}</p>{task.projectName && <small>Project: {task.projectName}</small>}<div className="task-actions">{task.status === "planned" && <Button size="sm" variant="outline" onClick={() => updateTask(task.id, "in-progress")} disabled={busyTask === task.id}><Play /> Start task</Button>}{!(["completed", "skipped"] as string[]).includes(task.status) && <Button size="sm" onClick={() => updateTask(task.id, "completed")} disabled={busyTask === task.id}><Check /> Mark complete</Button>}{task.status !== "completed" && task.status !== "skipped" && <Button size="sm" variant="ghost" onClick={() => updateTask(task.id, "skipped")} disabled={busyTask === task.id}>Skip task</Button>}{task.projectId && <Button asChild size="sm" variant="ghost"><a href={`#project-${task.projectId}`}>View related project</a></Button>}<Button asChild size="sm" variant="ghost"><Link href={assistantUrl(`Help me complete this career plan task: ${task.title}. ${task.description}`, initial, task.projectId ? { projectId: task.projectId } : {})}>Ask Career AI</Link></Button></div></div></article>)}</div></> : <div className="career-plan-empty"><BriefcaseBusiness /><p>No active career plan yet. The Career Preparation workflow can create one from your current evidence.</p></div>}
    </section>

    {initial.recommendations.length > 0 && <section className="career-section" aria-labelledby="career-recommendations-title"><div className="career-section-heading"><div><p className="eyebrow">Current priorities</p><h2 id="career-recommendations-title">Recommended next actions</h2><p>Only active career recommendations are shown here.</p></div><Lightbulb /></div><div className="career-recommendations">{initial.recommendations.map((recommendation) => <article key={recommendation.id}><span className={`gap-priority priority-${recommendation.priority}`}>{statusLabel(recommendation.priority)}</span><h3>{recommendation.title}</h3><p>{recommendation.message}</p><Button asChild size="sm" variant="outline"><Link href={assistantUrl(`${recommendation.title}. ${recommendation.message}`, initial)}>Continue with Career AI</Link></Button></article>)}</div></section>}

    <section className="career-section" aria-labelledby="career-ai-title"><div className="career-section-heading"><div><p className="eyebrow">Focused help</p><h2 id="career-ai-title">Career AI actions</h2></div><Sparkles /></div><div className="career-ai-grid">
      <Link href={assistantUrl("Review my current career profile using only saved evidence.", initial)}><strong>Review my profile</strong><span>Check strengths and missing evidence.</span></Link>
      <Link href={assistantUrl("Improve my saved resume without inventing metrics or experience.", initial)}><strong>Improve resume</strong><span>Clarify truthful experience and projects.</span></Link>
      <Link href={assistantUrl("Analyze the highest-value skill gaps for my target role using current evidence.", initial)}><strong>Analyze skill gaps</strong><span>Focus on useful, supported gaps.</span></Link>
      <Link href={assistantUrl(highGap?.projectId ? `Improve the highest-priority project gap: ${highGap.title}` : "Review my projects and identify the highest-impact improvement.", initial, highGap?.projectId ? { projectId: highGap.projectId } : {})}><strong>Improve projects</strong><span>Strengthen proof of work.</span></Link>
      <Link href={buildPlanUrl}><strong>Build career plan</strong><span>Launch the existing preparation workflow.</span></Link>
    </div></section>
  </div>;
}
