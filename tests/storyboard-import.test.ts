import { describe, expect, it } from "vitest";
import { parseStoryboard } from "../src/storyboard-import";

describe("storyboard import", () => {
  it("parses a JSON storyboard with Chinese aliases", () => {
    const result = parseStoryboard(JSON.stringify({
      项目名称: "雨夜短片",
      全局提示词: "统一雨夜动画风格",
      分镜: [{
        分镜编号: 1,
        分镜图提示词: "雨夜街道静帧",
        分镜视频提示词: "镜头缓慢向前推进",
        时长: "8秒",
        画幅: "16:9"
      }]
    }));
    expect(result.projectName).toBe("雨夜短片");
    expect(result.globalPrompt).toBe("统一雨夜动画风格");
    expect(result.shots[0]).toMatchObject({
      shotNumber: 1,
      imagePrompt: "雨夜街道静帧",
      videoPrompt: "镜头缓慢向前推进",
      duration: 8,
      aspectRatio: "16:9",
      model: "Seedance 2.0 mini",
      firstFrameSource: "generated"
    });
  });

  it("parses local and text-only first-frame routes", () => {
    const result = parseStoryboard(`
项目名称：首帧测试
全局视频提示词：保持吉卜力宠物动画风格
### 分镜 1
首帧来源：本地图片
首帧图：01.png
视频提示词：小狗转头
### 分镜 2
首帧来源：无
视频提示词：纯文字生成远景
`);
    expect(result.videoGlobalPrompt).toContain("吉卜力");
    expect(result.shots[0]).toMatchObject({ firstFrameSource: "local", firstFrameImage: "01.png" });
    expect(result.shots[1].firstFrameSource).toBe("none");
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

  it("keeps body labels inside prompts without noisy warnings", () => {
    const result = parseStoryboard(`
全局视频提示词：保持统一风格
禁止：文字和水印
### 分镜 1
镜头名：小狗回头
视频提示词：小狗向镜头回头
0–3秒：缓慢转头
镜头：轻微推进
口播：今天也要开心
备注：后期加环境音
`);
    expect(result.videoGlobalPrompt).toContain("禁止：文字和水印");
    expect(result.shots[0].videoPrompt).toContain("0–3秒：缓慢转头\n镜头：轻微推进");
    expect(result.shots[0]).toMatchObject({ shotName: "小狗回头", narration: "今天也要开心", notes: "后期加环境音" });
    expect(result.warnings).toEqual([]);
  });

  it("warns only for field-like typos and aggregates once per shot", () => {
    const result = parseStoryboard(`
### 分镜 1
视频提示词：小狗向镜头回头
首帧：01.png
画面比例：16:9
动作：缓慢转头
### 分镜 2
视频提示词：小猫跳上沙发
光线：午后暖光
`);
    expect(result.shots[0].videoPrompt).toContain("首帧：01.png\n画面比例：16:9\n动作：缓慢转头");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ shotNumber: 1, label: "首帧、画面比例" });
  });

  it("records whether model, duration and ratio came from a shot", () => {
    const result = parseStoryboard("### 分镜 1\n视频提示词：测试\n画幅：自动");
    expect(result.shots[0]).toMatchObject({ modelExplicit: false, durationExplicit: false, aspectRatioExplicit: true, aspectRatio: "adaptive" });
  });

  it("supports the finalized v1 project defaults, generation count and character references", () => {
    const result = parseStoryboard(`
格式版本：1
项目名称：协议测试
默认模型：Seedance 2.5
默认时长：8秒
默认画幅：16:9
角色参考图：豆豆_正面.png，豆豆_侧面.png, 豆豆_正面.png
### 分镜 1
镜头名：抬头
生成次数：3
视频提示词：柯基抬头
### 分镜 2
视频提示词：柯基跑动
时长：6秒
`);
    expect(result).toMatchObject({
      formatVersion: 1,
      defaultModel: "Seedance 2.5",
      defaultDuration: 8,
      defaultAspectRatio: "16:9",
      characterReferenceImages: ["豆豆_正面.png", "豆豆_侧面.png"]
    });
    expect(result.shots[0]).toMatchObject({ model: "Seedance 2.5", duration: 8, aspectRatio: "16:9", generationCount: 3 });
    expect(result.shots[1]).toMatchObject({ duration: 6, durationExplicit: true, generationCount: 1 });
  });

  it("rejects an unsupported import protocol version", () => {
    expect(() => parseStoryboard("格式版本：2\n### 分镜 1\n视频提示词：测试"))
      .toThrow(/不支持格式版本 2/);
  });
});
