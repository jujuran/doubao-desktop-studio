import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "release");
const currentOutput = path.join(releaseRoot, "current");

if (path.dirname(currentOutput) !== releaseRoot) {
  throw new Error("拒绝清理 release/current 之外的目录");
}

await rm(currentOutput, { recursive: true, force: true });
await mkdir(currentOutput, { recursive: true });

console.log(`已清理 ${currentOutput}`);
