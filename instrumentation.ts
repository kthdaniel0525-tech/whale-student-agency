export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Production images may be built without deployed runtime secrets. The
    // server startup path always validates them before accepting traffic.
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { validateSecurityConfiguration } = await import("./server/security/startup");
    validateSecurityConfiguration();
  }
}
