// Import only binding types. Loading Workers' entire global runtime alongside
// Node/DOM types shadows Buffer and crypto APIs in the Next application.
// Drizzle's D1 adapter expects these four binding names in the global scope.
type D1Database = import("@cloudflare/workers-types").D1Database;
type D1PreparedStatement = import("@cloudflare/workers-types").D1PreparedStatement;
type D1Response = import("@cloudflare/workers-types").D1Response;
type D1Result<T = unknown> = import("@cloudflare/workers-types").D1Result<T>;
declare namespace Cloudflare {
  interface Env {
    DB?: import("@cloudflare/workers-types").D1Database;
    BUCKET?: import("@cloudflare/workers-types").R2Bucket;
  }
}

// The legacy Sites database adapter uses this runtime-provided module. Keep its
// actual typed binding surface without introducing Worker globals into Node.
declare module "cloudflare:workers" {
  const env: Cloudflare.Env;
  export { env };
}
