import { describe, expect, it } from "vitest";
import { imageReplyText, newGeneratedImageUrls } from "../src/doubao-image";

describe("Doubao image result detection", () => {
  it("keeps only new assistant result images", () => {
    expect(newGeneratedImageUrls(["https://example/reference.png"], [
      { url: "https://example/reference.png", role: "user", inComposer: false, contextText: "参考图" },
      { url: "https://example/composer.png", role: "unknown", inComposer: true, contextText: "" },
      { url: "https://example/result.png", role: "assistant", inComposer: false, contextText: "已生成。这版保留了角色特征。" }
    ])).toEqual(["https://example/result.png"]);
  });

  it("recognizes the current short Doubao completion wording", () => {
    expect(imageReplyText("已生成。这版保留了手绘风格。")).toBe(true);
    expect(imageReplyText("正在上传参考图")).toBe(false);
  });

  it("does not treat a refreshed reference-image signature as a new result", () => {
    expect(newGeneratedImageUrls(["https://example/reference.png?sign=old"], [
      { url: "https://example/reference.png?sign=new", role: "unknown", inComposer: false, contextText: "" }
    ])).toEqual([]);
  });
});
