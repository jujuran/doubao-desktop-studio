import type { AssetFolderFile } from "../electron/contracts";
import type { ImportedShot } from "./storyboard-import";

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
      warning: aspectWarning(file, shot.aspectRatio)
    };
  });
  return {
    shots: resolved,
    unusedFiles: files.filter((file) => !used.has(file.path)),
    hasErrors: resolved.some((item) => Boolean(item.error))
  };
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
