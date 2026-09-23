# Memory Architecture and Personalization Core

`UserMemory` stores bounded long-term preferences, goals, learning patterns,
successful strategies, and explicit user-defined product memory. It does not
store dynamic mastery or quiz results; those remain in Learning Intelligence.
Values use validated scalar, list, or small-object representations and are
deduplicated by user, category, and normalized key.

Explicit statements become active at confidence 95 and override inferred
values. Inferred and system-derived events enter through `MemoryObservation`.
An idempotent evidence key prevents retries from counting twice. A candidate
requires three compatible observations with at least 60% dominance before it
becomes active. Conflicting evidence lowers confidence; it cannot replace an
explicit memory. Per-memory evidence is capped at 20 observations, and active
plus candidate memory is capped at 100. Capacity pressure archives a weak
inferred record and never silently removes explicit memory.

`retrieveRelevantMemories` combines explicit structured category/key filters,
bounded lexical relevance, semantic similarity for free-text patterns and strategies,
confidence, importance, source, and category-specific staleness. It reuses the
existing 384-dimensional AI embedding provider and pgvector; structured preference
lookups do not embed. Missing embeddings fall back to deterministic ranking. Stale
records remain inspectable but lose ranking priority. Context Builder supplies only the authenticated user ID and agent
specific categories/keys, so Tutor, Notes, Quiz, Study Planner, Academic Manager,
and Career receive different memory slices. The current request is the final
prompt message and explicitly overrides stored preferences.

`MemoryService` authenticates list, create, edit, archive, and delete operations.
Agents cannot write arbitrary permanent memory. Study-task outcomes and
successful workflows create validated observations, and one event never becomes
long-term memory. No model call is used for key/value operations, confidence,
promotion, conflict resolution, staleness, or ranking.
