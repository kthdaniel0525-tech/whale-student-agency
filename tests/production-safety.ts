import "dotenv/config";
export default function setup() {
  if (["staging", "production"].includes(process.env.APP_ENV ?? "")) throw new Error("Integration tests must never run against a deployed environment. Use an isolated test database.");
}
