import type { WorkflowId } from "../workflows/types";

type Rule = { id: WorkflowId; pattern: RegExp; reason: string };

// Keep only high-signal, end-to-end goals here. Specialist intent stays in AgentRouter.
const workflowRules: readonly Rule[] = [
  { id: "exam-preparation", pattern: /\b(?:(?:prepare|preparing|get ready|getting ready)(?: me)?(?: for)? .{0,70}(?:exam|midterm|final)|(?:exam|midterm|final).{0,70}(?:preparation|get ready))\b/i, reason: "The request asks for end-to-end exam preparation." },
  { id: "weak-topic-recovery", pattern: /\b(?:keep|always|repeatedly)\b.{0,55}\b(?:get(?:ting)? .{0,25} wrong|fail(?:ing)?|struggl\w*)\b|\b(?:fix|recover|improve)\b.{0,45}\b(?:weak(?:est)? (?:topic|area)|weakness)\b/i, reason: "The request asks to repair a recurring learning difficulty." },
  { id: "lecture-study", pattern: /\b(?:teach|study|summarize|go through|understand)\b.{0,70}\b(?:lecture|pdf|slides?|material)\b.{0,80}\b(?:quiz|test|practice|afterward|with me)\b|\b(?:lecture|pdf|slides?)\b.{0,70}\b(?:teach|study|go through)\b.{0,60}\b(?:quiz|test|with me)\b/i, reason: "The request combines learning lecture material with follow-up practice." },
  { id: "assignment-support", pattern: /\b(?:help me (?:with|finish|complete|start|work through) .{0,45}assignment|(?:finish|complete|start|plan|review|work through) .{0,45}assignment)\b/i, reason: "The request asks for coordinated assignment support." },
  { id: "career-preparation", pattern: /\b(?:prepare me for .{0,55}internships?|prepare for (?:internship|job) applications?|career preparation plan|strengthen my profile .{0,45}recruiting|improve my resume and portfolio|skills? and projects? .{0,25}missing|want to become (?:an? )?.{0,45}(?:engineer|developer|scientist|analyst|designer|researcher|product manager))\b/i, reason: "The request asks for a multi-step career preparation outcome." },
];

export function workflowRuleMatches(request: string) {
  return workflowRules.filter((rule) => rule.pattern.test(request));
}

export function contextualWorkflow(request: string, selected: { assignment: boolean; documents: boolean; exam: boolean; topic: boolean }) {
  const candidates: { id: WorkflowId; reason: string }[] = [];
  if (selected.assignment && /\b(?:help me with this|finish|complete|start|work through|check my work|review my answer)\b/i.test(request)) candidates.push({ id: "assignment-support", reason: "The selected assignment supplies the request scope." });
  if (selected.documents && /\b(?:study this|teach me this|go through this|learn this)\b/i.test(request)) candidates.push({ id: "lecture-study", reason: "The selected document supplies the lecture scope." });
  if (selected.exam && /\b(?:help me with this|prepare|get ready|study for this|master .{0,60} before)\b/i.test(request)) candidates.push({ id: "exam-preparation", reason: "The selected exam supplies the preparation scope." });
  if (selected.topic && /\b(?:help me with this|fix this|improve this|master this|keep getting|struggl\w*)\b/i.test(request)) candidates.push({ id: "weak-topic-recovery", reason: "The selected topic supplies the recovery scope." });
  return candidates;
}

export function complexitySignals(request: string) {
  const actions = [/(?:plan|schedule)/i, /(?:explain|teach|understand)/i, /(?:quiz|test|practice)/i, /(?:notes?|summarize)/i, /(?:review|improve|fix)/i]
    .filter((pattern) => pattern.test(request)).length;
  return {
    endToEndGoal: /\b(?:prepare me|get me ready|from start to finish|completely|work through|plan and)\b/i.test(request),
    multipleActions: actions >= 2,
    improvementOverTime: /\b(?:keep getting|repeatedly|over time|before .{0,30}(?:exam|applications?|recruiting))\b/i.test(request),
  };
}

export function careerTargetRoleHint(request: string) {
  const title = (value: string) => value.split(/\s+/).map((word) => word === word.toUpperCase() ? word : word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
  const internship = request.match(/\bprepare(?: me)? for (?:an? )?([\p{L}\p{N}+#./ -]{2,70}?)\s+internships?(?:\s+applications?)?\b/iu)?.[1]?.trim();
  if (internship && !/^(?:job|career|general)$/i.test(internship)) return `${title(internship)} Intern`;
  const role = request.match(/\b(?:want to become|become|work as|target(?:ing)?(?: a)?(?: role as)?)\s+(?:an?\s+)?([\p{L}\p{N}+#./ -]{2,70}?)(?:[.!?,]|$)/iu)?.[1]?.trim();
  return role && !/^(?:better|successful|ready)$/i.test(role) ? title(role) : undefined;
}
