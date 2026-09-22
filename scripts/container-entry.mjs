import { spawn } from "node:child_process";
const role = process.argv[2];
const ts = ["--conditions=react-server", "--import", "tsx"];
const commands = {
  web: ["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"],
  jobs: [...ts, "scripts/background-worker.ts"],
  documents: ["scripts/document-worker.mjs"],
  bootstrap: [...ts, "scripts/production-bootstrap.ts"],
  embeddings: [...ts, "scripts/prepare-embeddings.ts"],
  migrate: [...ts, "scripts/production-migrate.ts"],
  validate: [...ts, "scripts/validate-runtime.ts"],
};
if (!commands[role]) throw new Error("Unknown container role");
async function run(args) {
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const forward = signal => child.kill(signal);
  const term = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
  process.on("SIGTERM", term); process.on("SIGINT", interrupt);
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { process.off("SIGTERM", term); process.off("SIGINT", interrupt); resolve(code ?? (signal ? 1 : 0)); });
  });
}
// Explicit preparation command alone may download the pinned model. Serving
// processes always validate with downloads disabled before they bind a port.
const valid = await run([...ts, "scripts/validate-runtime.ts"]);
process.exitCode = valid === 0 ? await run(commands[role]) : valid;
