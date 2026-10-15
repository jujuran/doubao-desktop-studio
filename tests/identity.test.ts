import { describe, expect, it } from "vitest";
import { extractDoubaoIdentity } from "../electron/identity";

describe("extractDoubaoIdentity", () => {
  it("extracts the current Doubao account-info v2 response", () => {
    expect(extractDoubaoIdentity({
      data: {
        user_id: 123456,
        user_id_str: "123456",
        sec_user_id: "sec-123456",
        name: "当前账号",
        avatar_url: "https://example.test/current.png"
      },
      message: "success"
    })).toEqual({
      userId: "123456",
      displayName: "当前账号",
      avatarUrl: "https://example.test/current.png"
    });
  });

  it("does not treat the logged-out v2 response user_id 0 as an identity", () => {
    expect(extractDoubaoIdentity({
      data: {
        description: "会话过期，请重新登录",
        error_code: 13,
        user_id: 0
      },
      message: "error"
    })).toBeNull();
  });

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
