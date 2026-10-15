import { describe, expect, it } from "vitest";
import type { ProjectStyleProfile } from "../electron/contracts";
import { composeProjectPrompt, hasProjectStyle } from "../src/prompt-compose";

const profile: ProjectStyleProfile = {
  projectName: "测试短片",
  stylePrompt: "暖色低饱和电影风格",
  characterPrompt: "保持人物脸型和服装一致",
  scenePrompt: "保持客厅布局一致",
  continuityPrompt: "延续上一镜光线方向",
  negativePrompt: "禁止换装和文字水印",
  characterReferencePath: "C:\\refs\\character.png",
  sceneReferencePath: null,
  styleReferencePath: "C:\\refs\\style.png",
  lockedModel: "Seedance 2.0 mini",
  lockedAspectRatio: "9:16",
  updatedAt: "2026-10-15T00:00:00.000Z"
};

describe("project prompt composition", () => {
  it("combines project constraints with a shot prompt", () => {
    const prompt = composeProjectPrompt("video", "人物缓慢转头", profile);
    expect(prompt).toContain("【项目固定风格】\n暖色低饱和电影风格");
    expect(prompt).toContain("【本分镜视频】\n人物缓慢转头");
    expect(prompt).toContain("人物定妆图");
    expect(prompt).toContain("风格参考图");
    expect(prompt).toContain("【禁止项】");
  });

  it("keeps the raw prompt when no project style exists", () => {
    expect(composeProjectPrompt("image", "  单独提示词  ", null)).toBe("单独提示词");
    expect(hasProjectStyle(null)).toBe(false);
    expect(hasProjectStyle(profile)).toBe(true);
  });
});
