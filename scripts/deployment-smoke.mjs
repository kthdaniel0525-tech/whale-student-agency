import { pathToFileURL } from "node:url";

/** Read-only after deployment; an existing synthetic-account cookie is optional.
 * Never register a user, start an LLM call, or create a payment in production. */
export async function deploymentSmoke({ origin, cookie, operationsToken, fetcher = fetch }) {
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Invalid smoke origin");
  const checks = [];
  async function check(path, headers = {}, expected = 200) {
    const result = await fetcher(new URL(path, url), { headers, redirect: "manual", signal: AbortSignal.timeout(10000) });
    if (result.status !== expected) throw new Error(`Smoke check failed: ${path}`);
    checks.push(path);
    return result;
  }
  await check("/api/health/live");
  await check("/api/health/ready");
  const login = await check("/sign-in");
  if (!login.headers.get("content-security-policy") || login.headers.get("x-content-type-options") !== "nosniff") throw new Error("Missing security headers");
  await check("/api/student/courses", {}, 401);
  await check("/api/operations/metrics", {}, 404);
  if (cookie) {
    const headers = { cookie };
    const session = await check("/api/auth/get-session", headers);
    if (!(await session.json())?.user?.id) throw new Error("Smoke account session expired");
    await check("/student", headers);
    await check("/api/student/courses", headers);
  }
  if (operationsToken) {
    const metrics = await (await check("/api/operations/metrics", { authorization: `Bearer ${operationsToken}` })).json();
    for (const role of ["jobs", "documents"]) if (!metrics.workers?.some(worker => worker.role === role && worker.healthyInstances > 0)) throw new Error("Worker heartbeat missing");
    if (!Array.isArray(metrics.queues) || metrics.queues.length < 1) throw new Error("Background queues unavailable");
  }
  return { passed: checks.length, authenticated: !!cookie, workers: !!operationsToken };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.REQUIRE_AUTHENTICATED_SMOKE === "true" && !process.env.SMOKE_COOKIE) throw new Error("Authenticated staging smoke requires a synthetic-account session");
  try { console.info(JSON.stringify(await deploymentSmoke({ origin: process.env.SMOKE_ORIGIN, cookie: process.env.SMOKE_COOKIE, operationsToken: process.env.OPERATIONS_TOKEN }))); }
  catch { console.error("Deployment smoke failed. Check the safe health/operations endpoints and synthetic-account configuration."); process.exitCode = 1; }
}
