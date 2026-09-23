import "server-only";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { documentConfig, DocumentError, MAX_FILE_BYTES } from "../config";
export interface DocumentStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}
const keyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function location(key: string) {
  if (!keyPattern.test(key))
    throw new DocumentError("Invalid document storage reference.", 400);
  return path.join(documentConfig().storage, key);
}
async function removeIfPresent(file: string) {
  try {
    await unlink(file);
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
}
export const storage: DocumentStorage = {
  async put(key, data) {
    const dest = location(key);
    if (!data.length || data.length > MAX_FILE_BYTES)
      throw new DocumentError("Choose a non-empty file up to 10 MB.", 413);
    await mkdir(documentConfig().storage, { recursive: true, mode: 0o700 });
    const file = await open(dest + ".part", "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(dest + ".part", dest);
  },
  async get(key) {
    const file = await open(
      location(key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        throw new DocumentError("This file cannot be read safely.");
      return new Uint8Array(await file.readFile());
    } finally {
      await file.close();
    }
  },
  async remove(key) {
    await removeIfPresent(location(key));
    await removeIfPresent(location(key) + ".part");
  },
};
export async function oldStorageKeys(ageMs = 3600000) {
  await mkdir(documentConfig().storage, { recursive: true, mode: 0o700 });
  const keys = new Set<string>();
  for (const name of await readdir(documentConfig().storage)) {
    const key = name.replace(/\.part$/, "");
    if (!keyPattern.test(key)) continue;
    const stat = await lstat(path.join(documentConfig().storage, name));
    if (stat.isFile() && Date.now() - stat.mtimeMs > ageMs) keys.add(key);
  }
  return [...keys];
}
