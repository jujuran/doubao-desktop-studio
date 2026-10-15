export interface DoubaoIdentity {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export function extractDoubaoIdentity(payload: unknown): DoubaoIdentity | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const data = asRecord(root.data) ?? root;
  const user = asRecord(data.user) ?? asRecord(data.account) ?? data;
  const userId = firstIdentifier(
    user.user_id_str,
    user.sec_user_id,
    user.user_id,
    user.userId,
    user.uid,
    user.id,
    data.user_id_str,
    data.sec_user_id,
    data.user_id,
    data.userId
  );
  if (!userId) return null;
  return {
    userId,
    displayName: firstString(
      user.name,
      user.nickname,
      user.nick_name,
      user.display_name,
      user.screen_name
    ) || null,
    avatarUrl: firstString(user.avatar_url, user.avatarUrl, user.avatar, user.avatar_thumb) || null
  };
}

function firstIdentifier(...values: unknown[]) {
  const result = firstString(...values);
  return result === "0" ? "" : result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) return String(value).trim();
  }
  return "";
}
