# External account integration boundary

OAuth adapters, provider registry, encrypted token storage, account ownership,
refresh/revocation and sync metadata live here. Public account DTOs contain no
credentials. Runtime modules are server-only; background jobs use trusted user IDs.

See [Integration & OAuth Foundation](../../docs/integrations-oauth.md) for setup,
security design, lifecycle behavior, API/Settings flow and verification. The broader
[module architecture](../../docs/student-agency/ARCHITECTURE.md) remains unchanged.
