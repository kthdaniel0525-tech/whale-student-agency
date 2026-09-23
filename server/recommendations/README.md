# Proactive Recommendations

The recommendation engine reads existing owned academic, learning, planning,
document, career and adaptive-outcome data. `detectRecommendationCandidates`
and ranking are deterministic and make no AI calls. The database stores only
short user-facing cards, structured targets and reason evidence.

`evaluateRecommendations` serializes refreshes per user, keeps one active card
per recommendation scope, expires stale cards and suppresses recently dismissed
or completed cards until their state fingerprint materially changes. Starting a
card returns a validated Agent or Workflow launch descriptor; it never executes
the action automatically.
