import { describe, expect, it } from "vitest";
import { detectDoubaoRejection, refusalFailureMessage } from "../src/doubao-rejection";

describe("detectDoubaoRejection", () => {
  it("detects a newly appended refusal", () => {
    expect(detectDoubaoRejection("主对话\n用户提示词", "主对话\n用户提示词\n抱歉，我无法生成该内容。你可以换个需求，我会尽力帮你。"))
      .toContain("无法生成");
  });

  it("ignores refusal text already present before this submission", () => {
    const text = "主对话\n抱歉，我无法生成该内容。你可以换个需求";
    expect(detectDoubaoRejection(text, text)).toBe("");
  });

  it("detects a repeated identical refusal added to the conversation", () => {
    const refusal = "抱歉，我无法生成该内容。你可以换个需求";
    expect(detectDoubaoRejection(refusal, `${refusal}\n${refusal}`)).toBe(refusal);
  });

  it("does not treat an ordinary apology as a refusal", () => {
    expect(detectDoubaoRejection("", "抱歉让你久等了，图片正在生成中")).toBe("");
  });
});

describe("refusalFailureMessage", () => {
  it("keeps the original response and refusal count", () => {
    expect(refusalFailureMessage("抱歉，无法生成", 2)).toBe("豆包拒绝生成（可能是偶发误判，累计 2 次）：抱歉，无法生成");
  });
});
