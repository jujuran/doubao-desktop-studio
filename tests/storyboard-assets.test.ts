import { describe, expect, it } from "vitest";
import type { AssetFolderFile } from "../electron/contracts";
import { resolveStoryboardAssets } from "../src/storyboard-assets";
import type { ImportedShot } from "../src/storyboard-import";

const shot = (shotNumber: number, firstFrameImage = "", aspectRatio = "9:16"): ImportedShot => ({
  shotNumber,
  firstFrameSource: "local",
  firstFrameImage,
  imagePrompt: "",
  videoPrompt: "测试",
  model: "Seedance 2.0 mini",
  duration: 10,
  aspectRatio
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
});
