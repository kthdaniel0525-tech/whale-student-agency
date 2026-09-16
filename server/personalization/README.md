# Personalization Engine

The engine builds a temporary, read-only behavioral profile from the authenticated
`UserContext`. It performs no database writes and no model call.

Field conflicts use this order: current request, hard task constraint, explicit
profile, explicit memory, inferred memory, learning adaptation, default. Inferred
signals at 80 or above apply normally, 60–79 are soft, and lower signals are
ignored. Quiz `recommendedDifficulty` is learning-aware while preserving the
stored `quizDifficulty` preference; an explicit request always wins.

Context Builder owns factual data. AgentExecutor resolves personalization once,
removes duplicated behavioral profile/memory fields from the model reference,
and supplies the compact agent-specific profile to every direct or workflow call.
