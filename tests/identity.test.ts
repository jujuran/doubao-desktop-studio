import { describe, expect, it } from "vitest";
import { extractDoubaoIdentity } from "../electron/identity";

describe("extractDoubaoIdentity", () => {
  it("reads the nested account response", () => {
    expect(extractDoubaoIdentity({ data: { user: { user_id: "123", nickname: "测试账号", avatar_url: "https://example.test/avatar.png" } } }))
      .toEqual({ userId: "123", displayName: "测试账号", avatarUrl: "https://example.test/avatar.png" });
  });

  it("supports alternate user id fields", () => {
    expect(extractDoubaoIdentity({ data: { userId: 456, name: "备用字段" } }))
      .toEqual({ userId: "456", displayName: "备用字段", avatarUrl: null });
  });

  it("rejects a profile without an explicit id", () => {
    expect(extractDoubaoIdentity({ data: { user: { nickname: "同名用户" } } })).toBeNull();
  });
});
