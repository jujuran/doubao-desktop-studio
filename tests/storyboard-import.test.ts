import { describe, expect, it } from "vitest";
import { parseStoryboard } from "../src/storyboard-import";

describe("storyboard import", () => {
  it("parses a JSON storyboard with Chinese aliases", () => {
    const result = parseStoryboard(JSON.stringify({
      项目名称: "雨夜短片",
      分镜: [{
        分镜编号: 1,
        分镜图提示词: "雨夜街道静帧",
        分镜视频提示词: "镜头缓慢向前推进",
        时长: "8秒",
        画幅: "16:9"
      }]
    }));
    expect(result.projectName).toBe("雨夜短片");
    expect(result.shots[0]).toMatchObject({
      shotNumber: 1,
      imagePrompt: "雨夜街道静帧",
      videoPrompt: "镜头缓慢向前推进",
      duration: 8,
      aspectRatio: "16:9",
      model: "Seedance 2.0 mini"
    });
  });

  it("parses multiline Markdown shots", () => {
    const result = parseStoryboard(`
项目名称：柯基短片
### 分镜 1
分镜图提示词：一只柯基站在客厅
暖色电影光
视频提示词：柯基缓慢转头看向镜头
时长：10秒
画幅：9:16

### 分镜 2
分镜图提示词：柯基跑向玄关
视频提示词：低机位跟拍，轻微运动模糊
模型：Seedance 2.5
时长：自动
`);
    expect(result.shots).toHaveLength(2);
    expect(result.shots[0].imagePrompt).toContain("暖色电影光");
    expect(result.shots[1]).toMatchObject({ shotNumber: 2, model: "Seedance 2.5", duration: -1 });
  });

  it("rejects shots without a video prompt", () => {
    expect(() => parseStoryboard("### 分镜 1\n分镜图提示词：只有图片")).toThrow(/缺少视频提示词/);
  });
});
