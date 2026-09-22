export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Production images may be built without deployed runtime secrets. The
    // server startup path always validates them before accepting traffic.
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { validateRuntimeConfiguration } = await import("./server/operations/config");
    validateRuntimeConfiguration();
    const { initializeMonitoring } = await import("./server/operations/monitoring");
    initializeMonitoring();
  }
}

export async function onRequestError(error: unknown) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportError } = await import("./server/operations/monitoring");
  reportError(error, { event: "next-server-error" });
}
