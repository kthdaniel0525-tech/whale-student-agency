import { existsSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { spawnSync } from "node:child_process";
const desktop = "/Applications/Docker.app/Contents/Resources/bin/docker";
const executable =
  process.platform === "darwin" && existsSync(desktop) ? desktop : "docker";
const result = spawnSync(executable, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    PATH:
      executable === desktop
        ? `${dirname(desktop)}${delimiter}${process.env.PATH || ""}`
        : process.env.PATH,
  },
});
if (result.error)
  console.error(
    "Docker is unavailable. Install and start Docker Desktop, then try again.",
  );
process.exitCode = result.status ?? 1;
