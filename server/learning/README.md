# Learning Intelligence Core

This server-only layer turns persisted quiz answer evidence into course-owned
topic summaries. It uses deterministic calculations and makes no AI calls.

Quiz generation adds one to five exact topic labels to every question. For a
course-scoped quiz, normalized labels are upserted as `LearningTopic` records
and connected through `QuizQuestionTopic`. Unicode NFKC, whitespace collapse,
and lowercase are the only duplicate rules; punctuation and word forms remain
distinct. Unscoped quizzes retain labels but do not create course topics.
When no course is supplied, an exact topic set already belonging to one and
only one course can resolve that scope safely; ambiguous topics stay unscoped.

When an answer is graded, `recordQuestionEvaluation` stores it in the latest
owned `QuizAttempt`, updates every mapped topic equally, and completes the
attempt after every quiz question has an answer. Regrading the same question in
the same attempt replaces its evidence instead of increasing counts. Removing
an attempt through `deleteQuizAttempt` rebuilds only its affected topics.
Clients must pass `startNewAttempt: true` on the first graded answer of an
intentional retake. Otherwise completed attempts are also reused, preventing
replayed final submissions from creating false practice sessions. An identical
answer and grading result does not refresh evidence timestamps or aggregates.

Mastery uses a 50% Bayesian prior with four virtual medium questions. The last
eight answers receive up to 60% of the estimate, decay with a 30-day half-life,
and use modest difficulty weights of 0.8, 1.0, and 1.2. A maximum eight-point
staleness penalty begins after 30 days. Confidence separately combines attempt
count, distinct quiz sessions, difficulty diversity, evidence time span, and
freshness. Trend compares the latest five answers with the previous five and
requires two sessions and a meaningful accuracy and correct-answer difference.

`getWeakTopics`, `getStrongTopics`, `getRecommendedPracticeTopics`, and
`getLearningOverview` read aggregate rows only. Unpracticed or low-confidence
topics can be recommended but are not asserted as weak or strong. Context
Builder calls the overview with its authenticated user and returns bounded
summaries instead of raw attempts or answers.
