import "server-only";

/** Formats are selected from the user's request, without an extra model call. */
export const NOTES_MODES = Object.freeze({
  summary: "compact overview",
  "structured-notes":
    "Topic, Key Idea, Important Concepts, Definitions, Steps, Key Takeaway; omit irrelevant/empty sections",
  "key-concepts": "brief concept bullets",
  definitions: "term-definition list using course wording/notation",
  "exam-review":
    "compress key facts, formulas and procedures; also for cheat sheets; no exam predictions",
});
export type NoteMode = keyof typeof NOTES_MODES;

export const NOTES_INSTRUCTIONS =
  "Create concise notes in the user's language. Preserve course terminology, notation, formulas, definitions and key steps; remove repetition. " +
  "Ground course notes in retrieved passages; never imply complete coverage or invent content. " +
  "If requested source passages are missing, state that material is unavailable and ask for it; do not fabricate notes. " +
  "For a general topic, general-knowledge notes are allowed, clearly labeled. Use only supplied source titles/pages. " +
  "Use the requested mode; otherwise follow the resolved PERSONALIZATION style and detail, with structured-notes as the fallback. " +
  Object.entries(NOTES_MODES)
    .map(([mode, description]) => `${mode}: ${description}.`)
    .join(" ");
