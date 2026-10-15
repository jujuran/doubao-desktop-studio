import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "release");
const currentOutput = path.join(releaseRoot, "current");
const distributableExtensions = new Set([".dmg", ".exe", ".zip"]);

if (path.dirname(currentOutput) !== releaseRoot) {
  throw new Error("拒绝整理 release/current 之外的目录");
}

const entries = await readdir(currentOutput, { withFileTypes: true });
for (const entry of entries) {
  const entryPath = path.join(currentOutput, entry.name);
  if (entry.isDirectory() || !distributableExtensions.has(path.extname(entry.name).toLowerCase())) {
    await rm(entryPath, { recursive: true, force: true });
  }
}

const artifacts = (await readdir(currentOutput, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && distributableExtensions.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .sort();

if (artifacts.length === 0) {
  throw new Error("没有找到可发布的安装包");
}

const checksumLines = [];
for (const artifact of artifacts) {
  const contents = await readFile(path.join(currentOutput, artifact));
  const digest = createHash("sha256").update(contents).digest("hex").toUpperCase();
  checksumLines.push(`${digest}  ${artifact}`);
}

await writeFile(path.join(currentOutput, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`, "utf8");
console.log(`已保留 ${artifacts.length} 个安装包并生成 SHA256SUMS.txt`);
