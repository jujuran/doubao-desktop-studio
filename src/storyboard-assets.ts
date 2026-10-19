import type { AssetFolderFile } from "../electron/contracts.js";
import type { ImportedShot } from "./storyboard-import.js";

export interface ResolvedStoryboardAsset {
  shotNumber: number;
  file: AssetFolderFile | null;
  error: string;
  warning: string;
}

export interface StoryboardAssetResolution {
  shots: ResolvedStoryboardAsset[];
  unusedFiles: AssetFolderFile[];
  hasErrors: boolean;
}

export interface ProjectReferenceResolution {
  files: AssetFolderFile[];
  missing: string[];
  hasErrors: boolean;
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

export function resolveStoryboardAssets(shots: ImportedShot[], files: AssetFolderFile[]): StoryboardAssetResolution {
  const used = new Set<string>();
  const resolved = shots.map((shot) => {
    if (shot.firstFrameSource !== "local") return { shotNumber: shot.shotNumber, file: null, error: "", warning: "" };
    const candidates = findCandidates(shot, files);
    if (!candidates.length) {
      const expected = shot.firstFrameImage || `分镜 ${shot.shotNumber} 对应的图片`;
      return { shotNumber: shot.shotNumber, file: null, error: `未找到 ${expected}`, warning: "" };
    }
    if (candidates.length > 1) {
      return {
        shotNumber: shot.shotNumber,
        file: null,
        error: `匹配到多张图片：${candidates.map((file) => file.name).join("、")}`,
        warning: ""
      };
    }
    const file = candidates[0];
    used.add(file.path);
    return {
      shotNumber: shot.shotNumber,
      file,
      error: "",
      warning: aspectWarning(file, shot.aspectRatioExplicit ? shot.aspectRatio : inferAspectRatio(file.width, file.height))
    };
  });
  return {
    shots: resolved,
    unusedFiles: files.filter((file) => !used.has(file.path)),
    hasErrors: resolved.some((item) => Boolean(item.error))
  };
}

export function resolveProjectReferenceAssets(names: string[], files: AssetFolderFile[]): ProjectReferenceResolution {
  const resolved: AssetFolderFile[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (isAbsolutePath(name)) {
      const match = files.find((file) => normalizePath(file.path) === normalizePath(name));
      resolved.push(match ?? { name: normalizeName(name), path: name, width: 0, height: 0, thumbnailUrl: "" });
      continue;
    }
    const matches = files.filter((file) => normalizeName(file.name) === normalizeName(name));
    if (matches.length === 1) resolved.push(matches[0]);
    else missing.push(matches.length ? `${name}（匹配到多张）` : name);
  }
  return { files: resolved, missing, hasErrors: missing.length > 0 };
}

function findCandidates(shot: ImportedShot, files: AssetFolderFile[]) {
  if (isAbsolutePath(shot.firstFrameImage)) {
    const normalized = normalizePath(shot.firstFrameImage);
    const matches = files.filter((file) => normalizePath(file.path) === normalized);
    return matches.length ? matches : [{
      name: normalizeName(shot.firstFrameImage),
      path: shot.firstFrameImage,
      width: 0,
      height: 0,
      thumbnailUrl: ""
    }];
  }
  if (shot.firstFrameImage) {
    const wanted = normalizeName(shot.firstFrameImage);
    return files.filter((file) => normalizeName(file.name) === wanted);
  }
  const n = String(shot.shotNumber);
  const padded = n.padStart(2, "0");
  const stems = new Set([n, padded, `分镜${n}`, `分镜${padded}`, `shot${n}`, `shot${padded}`, `shot_${n}`, `shot_${padded}`]);
  return files.filter((file) => stems.has(fileStem(file.name).replace(/\s+/g, "").toLowerCase()));
}

function aspectWarning(file: AssetFolderFile, aspectRatio: string) {
  if (!file.width || !file.height || aspectRatio === "adaptive") return "";
  const [width, height] = aspectRatio.split(":").map(Number);
  if (!width || !height) return "";
  const delta = Math.abs(file.width / file.height - width / height) / (width / height);
  return delta > 0.03 ? `图片 ${file.width}×${file.height} 与目标画幅 ${aspectRatio} 不一致` : "";
}

export function inferAspectRatio(width: number, height: number) {
  if (!width || !height) return "9:16";
  const value = width / height;
  const ratios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
  return ratios
    .map((ratio) => {
      const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
      return { ratio, delta: Math.abs(value - ratioWidth / ratioHeight) };
    })
    .sort((left, right) => left.delta - right.delta)[0].ratio;
}

function normalizeName(value: string) {
  return value.trim().replace(/\\/g, "/").split("/").pop()!.toLowerCase();
}

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isSupportedImageName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

function fileStem(name: string) {
  const base = normalizeName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function isAbsolutePath(value: string) {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith("/");
}
