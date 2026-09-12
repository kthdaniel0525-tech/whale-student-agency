import { fork } from "node:child_process";
// A separate watchdog can stop a CPU-bound parser even when its event loop stalls.
// The database lease recovers an interrupted attempt; no in-memory jobs are lost.
let stopped = false;
let child;
let shutdownTimer;
function stop() {
  stopped = true;
  if (child) {
    child.kill("SIGTERM");
    shutdownTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
while (!stopped) {
  const code = await new Promise((resolve) => {
    child = fork(
      new URL("./document-worker.ts", import.meta.url),
      process.argv.slice(2),
      {
        execArgv: [
          "--max-old-space-size=512",
          "--conditions=react-server",
          "--import",
          "tsx",
        ],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
    );
    let deadline;
    function heartbeat() {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        console.error(
          "Document worker stalled; restarting. Interrupted jobs will recover from their leases.",
        );
        child?.kill("SIGKILL");
      }, 180000);
    }
    heartbeat();
    child.on("message", (message) => {
      if (message?.type === "progress") heartbeat();
    });
    child.on("exit", (code) => {
      clearTimeout(deadline);
      clearTimeout(shutdownTimer);
      child = undefined;
      resolve(code ?? 1);
    });
  });
  if (process.argv.includes("--once")) {
    process.exitCode = code;
    break;
  }
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
}
