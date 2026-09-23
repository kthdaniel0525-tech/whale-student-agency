import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (existsSync(".env")) {
  console.log(".env already exists; no values changed.");
} else {
  const password = randomBytes(24).toString("hex");
  const secret = randomBytes(32).toString("hex");
  writeFileSync(
    ".env",
    `POSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://student:${password}@localhost:5439/student_agency\nBETTER_AUTH_SECRET=${secret}\nBETTER_AUTH_URL=http://localhost:3000\n`,
    { mode: 0o600 },
  );
  console.log(
    "Created local .env with random database and authentication secrets.",
  );
}
