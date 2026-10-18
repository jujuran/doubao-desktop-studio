import { describe, expect, it } from "vitest";
import {
  aspectRatioLabel,
  DEFAULT_VIDEO_MODEL,
  durationLabel,
  durationOptions,
  VIDEO_MODEL_OPTIONS
} from "../src/video-options";

describe("video task options", () => {
  it("exposes the complete Seedance 2.5 duration range", () => {
    const seedance25 = VIDEO_MODEL_OPTIONS.find((model) => model.value === "Seedance 2.5");
    expect(seedance25).toBeDefined();
    const options = durationOptions(seedance25!);

    expect(options).toEqual(Array.from({ length: 27 }, (_, index) => index + 4));
  });

  it("includes the current Seedance model family and applies model-specific limits", () => {
    expect(VIDEO_MODEL_OPTIONS.map((model) => model.value)).toEqual([
      "Seedance 2.5",
      "Seedance 2.0",
      "Seedance 2.0 fast",
      "Seedance 2.0 mini"
    ]);
    expect(DEFAULT_VIDEO_MODEL.value).toBe("Seedance 2.0 mini");
    expect(durationOptions(VIDEO_MODEL_OPTIONS[1]).at(-1)).toBe(15);
  });

  it("uses friendly labels for adaptive values", () => {
    expect(durationLabel(-1)).toBe("自动");
    expect(durationLabel(10)).toBe("10 秒");
    expect(aspectRatioLabel("adaptive")).toBe("自适应");
    expect(aspectRatioLabel("9:16")).toBe("9:16");
  });
});
