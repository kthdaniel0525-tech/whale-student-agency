import { validateRuntimeConfiguration } from "../server/operations/config";
try { validateRuntimeConfiguration(); }
catch { console.error(JSON.stringify({ level: "error", event: "runtime-configuration-invalid" })); process.exitCode = 1; }
