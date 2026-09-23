import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

const image = `registry.example.test/agency@sha256:${"a".repeat(64)}`;
// Run the real release CLI; only the external Docker command is substituted.
async function rollback(labels: string, options: { beta?: boolean; inspectFails?: boolean; validateFails?: boolean; reviewed?: boolean } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "release-boundary-"));
  try {
    const secretDir = join(folder, "secrets"); await mkdir(secretDir);
    const commands = join(folder, "commands.jsonl");
    await writeFile(join(secretDir, "runtime.env"), `APP_ENV=staging\nAPP_URL=https://agency.example.test\nBETTER_AUTH_URL=https://agency.example.test\nBETA_MODE=${options.beta === false ? "false" : "true"}\n`);
    const config = join(folder, "compose.env");
    await writeFile(config, `DEPLOY_ENVIRONMENT=staging\nAPP_DOMAIN=agency.example.test\nCOMPOSE_PROJECT_NAME=release-fixture\nDEPLOY_SECRETS_DIR=${secretDir}\n`);
    await writeFile(join(folder, "docker"), `#!${process.execPath}\nconst fs = require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(commands)},JSON.stringify(args)+'\\n');if(args[0]==='image'){process.stdout.write(${JSON.stringify(labels)});process.exit(${options.inspectFails ? 2 : 0});}if(args.includes('validate'))process.exit(${options.validateFails ? 2 : 0});if(args.includes('up'))process.exit(7);\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["scripts/deploy-release.mjs", "rollback", config, image], { encoding: "utf8", env: { ...process.env, PATH: `${folder}${delimiter}${process.env.PATH}`, SCHEMA_COMPATIBILITY_REVIEWED: options.reviewed === false ? "false" : "true" } });
    const calls = await readFile(commands, "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line) as string[])).catch(() => [] as string[][]);
    return { status: result.status, stderr: result.stderr, calls };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
describe("rollback preserves beta authorization", () => {
  it.each(["null", "{}", '{"io.student-agency.access-policy":"pre-beta"}', "malformed"])("refuses unverified target labels %s before replacing any role", async labels => {
    const result = await rollback(labels);
    expect(result.status).toBe(1); expect(result.stderr).toContain("reviewed beta access policy");
    expect(result.calls.some(args => args.includes("up") || args.includes("migrate"))).toBe(false);
  });
  it("fails closed when image inspection fails even if stdout claims compatibility", async () => {
    const result = await rollback('{"io.student-agency.access-policy":"beta-v1"}', { inspectFails: true });
    expect(result.calls.some(args => args.includes("up"))).toBe(false);
  });
  it("checks current runtime before replacement and never runs migrations or bootstrap on rollback", async () => {
    const result = await rollback('{"io.student-agency.access-policy":"beta-v1"}');
    expect(result.calls.some(args => args.includes("validate"))).toBe(true);
    expect(result.calls.findIndex(args => args.includes("validate"))).toBeLessThan(result.calls.findIndex(args => args.includes("up")));
    expect(result.calls.some(args => args.includes("migrate") || args.includes("bootstrap"))).toBe(false);
    // Fake Docker stops at replacement; this test never calls a real deployment.
    expect(result.stderr).toContain("Release command failed");
  });
  it("does not replace roles after runtime validation failure", async () => {
    const result = await rollback('{"io.student-agency.access-policy":"beta-v1"}', { validateFails: true });
    expect(result.calls.some(args => args.includes("up"))).toBe(false);
  });
  it("still requires schema review independently of the policy marker", async () => {
    const result = await rollback('{"io.student-agency.access-policy":"beta-v1"}', { reviewed: false });
    expect(result.stderr).toContain("compatibility before rollback"); expect(result.calls).toEqual([]);
  });
});
