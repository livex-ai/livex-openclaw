// Usage: node verify-tarball.mjs FILE.tgz sha512-<base64>
// Exits 1 unless the file's sha512 equals the npm dist.integrity value.
import { createHash } from "node:crypto";
import fs from "node:fs";

const [file, expected] = process.argv.slice(2);
if (!file || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(expected ?? "")) {
  console.error("usage: verify-tarball.mjs FILE sha512-<integrity>");
  process.exit(2);
}
const actual = `sha512-${createHash("sha512").update(fs.readFileSync(file)).digest("base64")}`;
if (actual !== expected) {
  console.error(`integrity mismatch for ${file}`);
  process.exit(1);
}
console.log(`integrity ok: ${file}`);
