import { describe, expect, it } from "vitest";
import type { AssetFolderFile } from "../electron/contracts";
import { inferAspectRatio, resolveProjectReferenceAssets, resolveStoryboardAssets } from "../src/storyboard-assets";
import type { ImportedShot } from "../src/storyboard-import";

const shot = (shotNumber: number, firstFrameImage = "", aspectRatio = "9:16"): ImportedShot => ({
  shotNumber,
  shotName: "",
  narration: "",
  notes: "",
  generationCount: 1,
  firstFrameSource: "local",
  firstFrameImage,
  imagePrompt: "",
  videoPrompt: "测试",
  model: "Seedance 2.0 mini",
  modelExplicit: false,
  duration: 10,
  durationExplicit: false,
  aspectRatio,
  aspectRatioExplicit: false
});

const file = (name: string, width = 900, height = 1600): AssetFolderFile => ({
  name,
  path: `C:\\assets\\${name}`,
  width,
  height,
  thumbnailUrl: "data:image/png;base64,test"
});

describe("storyboard asset matching", () => {
  it("matches explicit filenames and common shot-number patterns", () => {
    const result = resolveStoryboardAssets([shot(1, "cover.png"), shot(2)], [file("cover.png"), file("shot_02.jpg")]);
    expect(result.hasErrors).toBe(false);
    expect(result.shots.map((item) => item.file?.name)).toEqual(["cover.png", "shot_02.jpg"]);
  });

  it("reports missing, duplicate, unused and aspect-ratio issues", () => {
    const result = resolveStoryboardAssets([shot(1), shot(2, "missing.png")], [file("01.png", 1600, 900), file("1.jpg"), file("extra.png")]);
    expect(result.hasErrors).toBe(true);
    expect(result.shots[0].error).toMatch(/多张/);
    expect(result.shots[1].error).toMatch(/未找到/);
    expect(result.unusedFiles).toHaveLength(3);
  });

  it("infers the nearest Doubao ratio from a first frame", () => {
    expect(inferAspectRatio(1080, 1920)).toBe("9:16");
    expect(inferAspectRatio(1600, 900)).toBe("16:9");
    expect(inferAspectRatio(1000, 1000)).toBe("1:1");
  });

  it("uses the inferred first-frame ratio in import preview when ratio is not explicit", () => {
    const inferred = resolveStoryboardAssets([shot(1, "wide.png")], [file("wide.png", 1600, 900)]);
    expect(inferred.shots[0].warning).toBe("");

    const explicit = shot(1, "wide.png", "9:16");
    explicit.aspectRatioExplicit = true;
    const mismatched = resolveStoryboardAssets([explicit], [file("wide.png", 1600, 900)]);
    expect(mismatched.shots[0].warning).toMatch(/9:16/);
  });

  it("resolves project character references from the same asset folder", () => {
    const result = resolveProjectReferenceAssets(
      ["front.png", "side.png"],
      [file("front.png"), file("other.png")]
    );
    expect(result.files.map((item) => item.name)).toEqual(["front.png"]);
    expect(result.missing).toEqual(["side.png"]);
    expect(result.hasErrors).toBe(true);
  });

  it("uses the same exact filename lookup for first frames and character references", () => {
    const assets = [file("正面照.png", 1600, 900)];
    const frame = resolveStoryboardAssets([shot(1, "正面照.png")], assets);
    const references = resolveProjectReferenceAssets(["正面照.png"], assets);
    expect(frame.shots[0].file?.path).toBe(assets[0].path);
    expect(references.files[0].path).toBe(assets[0].path);
    expect(references.missing).toEqual([]);
  });
});
