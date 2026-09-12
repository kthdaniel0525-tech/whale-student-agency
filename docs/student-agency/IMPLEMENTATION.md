# Implementation status

The follow-up request defines the current boundary: architecture + application foundation, including academic CRUD. The original phase numbering has not been used to omit requested CRUD or to introduce AI work.

## Completed foundation
- [x] Modular UI, shared validation, authentication and server services.
- [x] PostgreSQL 17 and Prisma 7 connection, schema validation and client generation.
- [x] Six domain models plus four authentication support tables.
- [x] Reviewed and applied initial migration, indexes, composite ownership foreign keys and CHECK constraints.
- [x] Signup, signin, signout, persistent sessions, protected pages/APIs and credential throttling.
- [x] Onboarding, returning-user redirect, editable academic profile and preferences.
- [x] Authenticated responsive shell and light/dark theme.
- [x] Database-backed dashboard with honest empty states.
- [x] Course, assignment and exam CRUD; assignment completion/reopening.
- [x] Validation, loading/error states, success feedback and deletion confirmations.
- [x] Real HTTP/PostgreSQL ownership and authentication tests.
- [x] Browser journey including mobile navigation and persisted settings.
- [x] Fresh-database migration verification.

See FOUNDATION.md for commands, validation results and known deployment limits.

## Deliberately deferred
- [ ] Production deployment and operational setup.
- [ ] Email verification/password recovery delivery.
- [ ] Document upload, parsing, embeddings and RAG.
- [ ] AI provider, agents, orchestration and chat.
- [ ] Quizzes, mastery and study plans.
- [ ] AI recommendations and workflow automation.
- [ ] Explicit editable/deletable AI memory UI.

No future-feature tables, vector extension, mock AI responses or dummy student data are deployed.
