export type DoubaoImageRole = "assistant" | "user" | "unknown";

export interface DoubaoImageCandidateSnapshot {
  url: string;
  role: DoubaoImageRole;
  inComposer: boolean;
  contextText: string;
}

export function newGeneratedImageUrls(
  baselineUrls: Iterable<string>,
  candidates: DoubaoImageCandidateSnapshot[]
) {
  const baseline = new Set([...baselineUrls].map(stableImageUrl));
  const unique = new Map<string, DoubaoImageCandidateSnapshot>();
  for (const candidate of candidates) {
    if (!candidate.url || baseline.has(stableImageUrl(candidate.url)) || candidate.inComposer || candidate.role === "user") continue;
    if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  }
  const eligible = [...unique.values()];
  const assistant = eligible.filter((candidate) => candidate.role === "assistant" || imageReplyText(candidate.contextText));
  return (assistant.length ? assistant : eligible).map((candidate) => candidate.url);
}

function stableImageUrl(value: string) {
  if (!/^https?:/i.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

export function imageReplyText(value: string) {
  return /(?:^|[\s，。！])(?:已生成|生成完成|这版|为你生成|生成的图片)/.test(value.slice(-2_000));
}
