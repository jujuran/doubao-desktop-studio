export interface DoubaoVideoSettings {
  model: string;
  aspectRatio: string;
  duration: number;
}

export interface DoubaoVideoModeSnapshot {
  modeLabels: string[];
  composerPlaceholders: string[];
  controlTexts: string[];
}

export interface DoubaoVideoParameterValue {
  aspectRatio: string;
  duration: number;
}

export function parseDoubaoVideoParameterText(value: string): DoubaoVideoParameterValue | null {
  const match = value.trim().match(/^(自动|\d+:\d+)\s*[·•]\s*(\d+)\s*s?$/i);
  if (!match) return null;
  return { aspectRatio: match[1], duration: Number(match[2]) };
}

export function parseDoubaoImageAspectText(value: string) {
  const match = value.replace(/\s+/g, " ").trim().match(/^比例\s*(自动|\d+:\d+)$/);
  return match?.[1] || null;
}

export function isDoubaoVideoModeActive(snapshot: DoubaoVideoModeSnapshot) {
  const labels = snapshot.modeLabels.map((value) => value.replace(/\s+/g, "").trim());
  const hasModeLabel = labels.some((value) => /^视频生成(?:[×✕✖xX])?$/.test(value) || value === "视频");
  const hasModel = snapshot.controlTexts.some((value) => /Seedance/i.test(value));
  const hasParameters = snapshot.controlTexts.some((value) => parseDoubaoVideoParameterText(value) !== null);
  return hasModeLabel && hasModel && hasParameters;
}

export function videoSourceHasWatermark(sourceUrl: string) {
  let normalized = sourceUrl.toLowerCase();
  try {
    normalized = decodeURIComponent(normalized);
    const parsed = new URL(sourceUrl);
    const rendition = parsed.searchParams.get("lr")?.toLowerCase() || "";
    if (rendition === "unwatermarked") return false;
    if (rendition.includes("watermark")) return true;
  } catch {
    // Fall back to URL text matching for malformed or partially escaped URLs.
  }
  if (normalized.includes("unwatermarked")) return false;
  return /video_gen_watermark|video_dsz_watermark|watermark_dyn|(?:^|[\/_?&=.-])watermarked(?:$|[\/_?&=.-])/.test(normalized);
}

export function parseExpectedVideoWaitMinutes(bodyText: string) {
  const compact = bodyText.replace(/[\u00a0\u2000-\u200b]/g, " ");
  const exact = /预\s*计\s*等\s*待\s*(\d+)\s*分\s*钟/i.exec(compact);
  if (exact) return Number(exact[1]);
  const range = /大\s*约\s*需\s*要\s*(\d+)\s*[-–—至~～]\s*(\d+)\s*分\s*钟/i.exec(compact);
  return range ? Math.max(Number(range[1]), Number(range[2])) : 0;
}

export function normalizedModelName(value: string) {
  return value
    .replace(/模型/gi, "")
    .replace(/升级|\d+\s*倍消耗|[✓✔]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function doubaoAspectRatio(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "adaptive" || normalized === "自适应" ? "自动" : normalized;
}

export function concreteDuration(value: number) {
  return value === -1 ? 10 : value;
}

export function durationToSliderValue(
  desiredDuration: number,
  currentDuration: number,
  currentSliderValue: number,
  minimum: number,
  maximum: number
) {
  const offset = currentDuration - currentSliderValue;
  const value = desiredDuration - offset;
  return value >= minimum && value <= maximum ? value : null;
}

export function normalizeComposerText(value: string) {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compareDoubaoVideoSettings(expected: DoubaoVideoSettings, actual: DoubaoVideoSettings) {
  const mismatches: string[] = [];
  if (normalizedModelName(actual.model) !== normalizedModelName(expected.model)) {
    mismatches.push(`模型应为 ${expected.model}，页面为 ${actual.model || "未识别"}`);
  }
  if (doubaoAspectRatio(actual.aspectRatio) !== doubaoAspectRatio(expected.aspectRatio)) {
    mismatches.push(`比例应为 ${doubaoAspectRatio(expected.aspectRatio)}，页面为 ${actual.aspectRatio || "未识别"}`);
  }
  if (actual.duration !== concreteDuration(expected.duration)) {
    mismatches.push(`时长应为 ${concreteDuration(expected.duration)}s，页面为 ${actual.duration || "未识别"}s`);
  }
  return mismatches;
}
