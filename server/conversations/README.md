# Conversation Memory and Context Compression

Conversation history is user-owned raw data. It is never copied wholesale into a
prompt and is never promoted to permanent `UserMemory` by compression.

AgentExecutor assembles conversation context from a structured rolling summary,
a configurable recent window, and bounded lexical/semantic retrieval of older
messages. Summaries update incrementally from the prior summary plus newly
compressible messages. Exact source message IDs, deterministic constraint and
correction safeguards, and retained raw messages limit summary drift.

The current request and domain context keep priority. Under pressure, duplicate
or low-relevance historical messages are removed first, then older recent
messages already represented in the summary. The latest recent turns are always
retained. Workflow state remains persisted in `WorkflowRun.context`; conversation
context is supporting evidence only.
