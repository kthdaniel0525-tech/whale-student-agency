import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parse } from "dotenv";
import path from "node:path";
const [mode, configFile, image] = process.argv.slice(2);
if (!["deploy", "rollback", "check"].includes(mode) || !configFile || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image ?? "")) throw new Error("Use deploy-release.mjs deploy|rollback|check /absolute/compose.env immutable-image-digest");
const config = parse(await readFile(configFile));
if (!["production", "staging"].includes(config.DEPLOY_ENVIRONMENT) || !config.COMPOSE_PROJECT_NAME || !path.isAbsolute(config.DEPLOY_SECRETS_DIR ?? "")) throw new Error("Invalid deployment configuration");
const runtime = parse(await readFile(path.join(config.DEPLOY_SECRETS_DIR, "runtime.env")));
if (runtime.APP_ENV !== config.DEPLOY_ENVIRONMENT || runtime.APP_URL !== `https://${config.APP_DOMAIN}` || runtime.BETTER_AUTH_URL !== runtime.APP_URL) throw new Error("Environment/domain mismatch");
if (mode === "deploy" && config.DEPLOY_ENVIRONMENT === "production") {
  // Receipt points to operator-verified DB AND document-volume backup evidence;
  // a pathname alone cannot certify an off-host backup or successful restore.
  if (!process.env.BACKUP_RECEIPT_FILE) throw new Error("Production deployment requires a reviewed backup receipt");
  await access(process.env.BACKUP_RECEIPT_FILE);
}
if (mode === "rollback" && process.env.SCHEMA_COMPATIBILITY_REVIEWED !== "true") throw new Error("Review old-image/new-schema compatibility before rollback");
const env = { ...process.env, APP_IMAGE: image };
const prefix = ["compose", "--env-file", configFile, "-f", "compose.production.yaml"];
function run(args) {
  const result = spawnSync("docker", [...prefix, ...args], { env, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Release command failed; preserve previous image and inspect safe logs");
}
run(["config", "--quiet"]);
if (mode !== "check") {
  run(["pull", "web", "jobs", "documents", "proxy"]);
  if (runtime.BETA_MODE === "true") {
    const inspected = spawnSync("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", image], { env, encoding: "utf8" });
    let labels;
    try { labels = JSON.parse(inspected.stdout ?? ""); } catch { /* Fail closed on absent/invalid image metadata. */ }
    if (inspected.status !== 0 || labels?.["io.student-agency.access-policy"] !== "beta-v1") {
      throw new Error("Target image lacks the reviewed beta access policy; no application or worker replacement was performed");
    }
  }
  // Rollbacks must also accept the current runtime configuration before restart.
  run(["run", "--rm", "--no-deps", "web", "validate"]);
  if (mode === "deploy") {
    // Deterministic synthetic evals with the deployed model catalog/config. No
    // --live flag: this gate never consumes user content or provider quota.
    run(["run", "--rm", "--no-deps", "--entrypoint", "node", "web", "--env-file=/run/secrets/runtime.env", "--conditions=react-server", "--import", "tsx", "scripts/run-evals.ts", "--mode", "FAST_SMOKE"]);
    run(["up", "-d", "--wait", "postgres"]);
    run(["run", "--rm", "volumes-init"]);
    run(["run", "--rm", "migrate"]);
    run(["run", "--rm", "bootstrap"]);
    run(["run", "--rm", "embeddings"]);
  }
  // Compose replaces the two workers gracefully; leases/retries survive. A V1
  // single web replica has a short restart window, not a zero-downtime guarantee.
  run(["up", "-d", "--wait", "--wait-timeout", "180", "web", "jobs", "documents", "proxy"]);
  const result = spawnSync(process.execPath, ["scripts/deployment-smoke.mjs"], { env: { ...process.env, SMOKE_ORIGIN: runtime.APP_URL, OPERATIONS_TOKEN: runtime.OPERATIONS_TOKEN }, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Post-deploy smoke failed; deployment requires operator attention");
  console.info(JSON.stringify({ event: mode === "rollback" ? "application-rolled-back" : "release-complete", image, environment: config.DEPLOY_ENVIRONMENT }));
}
