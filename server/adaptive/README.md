# Adaptive Behavior

`buildAdaptiveStrategy` is the shared deterministic behavior resolver for the
six Student agents. It consumes owned Context Builder data, the resolved
Personalization profile, recent conversation state, and compact recent outcomes.
It never recalculates mastery or mutates preferences.

`AdaptiveOutcome` stores only bounded strategy and outcome signals. It never
stores prompts or full Agent responses. Explicit success can create a
`MemoryObservation`; the existing repeated-evidence rules decide whether that
candidate becomes active long-term memory. One interaction therefore changes
the current strategy but cannot silently rewrite a permanent preference.

AgentExecutor injects one `[ADAPTATION]` block for every normal and structured
execution, so workflows inherit the same behavior without a workflow-specific
adaptation system. Numeric thresholds, bounded difficulty changes, plan
completion bands, and explicit-request precedence remain deterministic.
