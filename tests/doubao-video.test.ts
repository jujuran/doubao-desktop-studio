import { describe, expect, it } from "vitest";
import { compareDoubaoVideoSettings, concreteDuration, doubaoAspectRatio, durationToSliderValue, isDoubaoVideoModeActive, normalizeComposerText, normalizedModelName, parseDoubaoImageAspectText, parseDoubaoVideoParameterText } from "../src/doubao-video";

describe("Doubao video setting verification", () => {
  it("normalizes labels shown by Doubao", () => {
    expect(normalizedModelName("模型 Seedance 2.0 Mini ✓")).toBe("seedance 2.0 mini");
    expect(doubaoAspectRatio("adaptive")).toBe("自动");
    expect(concreteDuration(-1)).toBe(10);
  });

  it("parses the parameter labels returned by the real Doubao DOM", () => {
    expect(parseDoubaoVideoParameterText("自动 · 10")).toEqual({ aspectRatio: "自动", duration: 10 });
    expect(parseDoubaoVideoParameterText("16:9 · 6s")).toEqual({ aspectRatio: "16:9", duration: 6 });
    expect(parseDoubaoVideoParameterText("自动播报")).toBeNull();
  });

  it("parses the image aspect-ratio control", () => {
    expect(parseDoubaoImageAspectText("比例 自动")).toBe("自动");
    expect(parseDoubaoImageAspectText("比例\n16:9")).toBe("16:9");
    expect(parseDoubaoImageAspectText("自动")).toBeNull();
  });

  it("maps seconds to Doubao slider indexes from the current observed value", () => {
    expect(durationToSliderValue(6, 10, 6, 0, 11)).toBe(2);
    expect(durationToSliderValue(6, 10, 10, 4, 15)).toBe(6);
    expect(durationToSliderValue(20, 10, 6, 0, 11)).toBeNull();
  });

  it("compares rich-text composer content without layout-only whitespace", () => {
    const prompt = "镜头：小狗奔跑\n动作：抬头看向镜头";
    const richTextValue = "镜头：小狗奔跑\n\n动作：抬头看向镜头\u200B";
    expect(normalizeComposerText(richTextValue)).toBe(normalizeComposerText(prompt));
    expect(normalizeComposerText("镜头：小狗奔跑")).not.toBe(normalizeComposerText(prompt));
  });

  it("reports every setting mismatch before generation", () => {
    expect(compareDoubaoVideoSettings(
      { model: "Seedance 2.0 mini", aspectRatio: "9:16", duration: 10 },
      { model: "Seedance 2.0 Fast", aspectRatio: "16:9", duration: 6 }
    )).toEqual([
      "模型应为 Seedance 2.0 mini，页面为 Seedance 2.0 Fast",
      "比例应为 9:16，页面为 16:9",
      "时长应为 10s，页面为 6s"
    ]);
  });

  it("recognizes the active video chip when visual-only text is missing from the DOM", () => {
    expect(isDoubaoVideoModeActive({
      modeLabels: ["视频生成"],
      composerPlaceholders: [],
      controlTexts: ["模型 Seedance 2.0 Mini", "自动 · 10"]
    })).toBe(true);
  });

  it("does not treat an inactive homepage skill button as active", () => {
    expect(isDoubaoVideoModeActive({
      modeLabels: ["视频生成"],
      composerPlaceholders: ["有什么我能帮你的吗？"],
      controlTexts: []
    })).toBe(false);
  });
});
