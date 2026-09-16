# Quiz Agent

`QuizAgentService` is the server-side Quiz domain boundary. It uses the existing
Agent Router to select `quiz`, Agent Executor to build authenticated context, and
AIProvider structured output for question generation.

## Generation

```ts
const service = createQuizAgentService();
const quiz = await service.generateQuiz(
  {
    request: "Create five hard multiple-choice questions from Lecture 5",
    courseId,
    documentIds: [documentId],
    count: 5,
    questionType: "multiple-choice",
    difficulty: "hard",
  },
  request.headers,
);
```

Supported question types are `multiple-choice`, `true-false`, `short-answer`,
`long-answer`, and `mixed`. The default count is 5, the valid range is 1–20,
and the default difficulty is `medium`. When the request omits difficulty, a
relevant saved preference may replace that default; an explicit current choice
always wins. `adaptive` can use bounded Learning
Context to select `easy`, `medium`, or `hard`; without learning evidence its
validated fallback is `medium`. A mixed quiz with more than one question must
contain at least two question types.

Generation is accepted only after the structured question schema validates the
count, requested type, choices, correct answers, explanations, topic labels,
and difficulty.
Public quiz results omit correct answers and explanations. Retrieved document
metadata is copied from Context Builder output and is never model-authored.

## Grading

Call `evaluateAnswer({ quizId, questionId, userAnswer }, headers)`. Multiple
choice and true/false answers use deterministic normalized comparison without
an AI call. Short and long answers use AIProvider structured output with only
the question, stored expected answer, and submitted answer.

## Persistence and security

`Quiz` stores quiz metadata and ownership. `QuizQuestion` stores ordered
questions, choices, answers, explanations, topic labels, and optional retrieved
source metadata. Course-scoped labels map to normalized learning topics without
a second AI request. An omitted course can be inferred only when all generated
topics already identify one unambiguous owned course. Grading stores an owned
quiz/question attempt and updates the mapped `LearningProgress` aggregates;
unscoped quizzes safely skip progress.

Every read, write, and grade operation derives the user from the server session
and scopes the database query by that user. Course and document ownership is
enforced by the existing Context Builder. API keys and provider details remain
server-side.
