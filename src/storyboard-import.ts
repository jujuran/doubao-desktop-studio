import { DEFAULT_VIDEO_MODEL, VIDEO_MODEL_OPTIONS } from "./video-options.js";
import type { FirstFrameSource } from "../electron/contracts.js";

export interface ImportedShot {
  shotNumber: number;
  shotName: string;
  narration: string;
  notes: string;
  firstFrameSource: FirstFrameSource;
  firstFrameImage: string;
  imagePrompt: string;
  videoPrompt: string;
  model: string;
  modelExplicit: boolean;
  duration: number;
  durationExplicit: boolean;
  aspectRatio: string;
  aspectRatioExplicit: boolean;
}

export interface StoryboardImportWarning {
  lineNumber: number;
  shotNumber: number | null;
  label: string;
  message: string;
}

export interface ImportedStoryboard {
  projectName: string;
  globalPrompt: string;
  imageGlobalPrompt: string;
  videoGlobalPrompt: string;
  shots: ImportedShot[];
  warnings: StoryboardImportWarning[];
}

type LooseRecord = Record<string, unknown>;

const fieldAliases = {
  shotNumber: ["shotNumber", "shot", "镜头编号", "分镜编号", "序号"],
  shotName: ["shotName", "shot_name", "镜头名", "分镜名"],
  narration: ["narration", "voiceover", "voice_over", "口播", "旁白"],
  notes: ["notes", "note", "备注"],
  firstFrameSource: ["firstFrameSource", "first_frame_source", "首帧来源"],
  firstFrameImage: ["firstFrameImage", "first_frame_image", "首帧图", "首帧图片"],
  imagePrompt: ["imagePrompt", "image_prompt", "分镜图提示词", "图片提示词", "生图提示词"],
  videoPrompt: ["videoPrompt", "video_prompt", "分镜视频提示词", "视频提示词", "prompt"],
  model: ["model", "模型"],
  duration: ["duration", "时长", "秒数"],
  aspectRatio: ["aspectRatio", "aspect_ratio", "画幅", "比例"]
} as const;

const projectFieldAliases = {
  globalPrompt: ["globalPrompt", "global_prompt", "全局提示词"],
  imageGlobalPrompt: ["imageGlobalPrompt", "image_global_prompt", "全局分镜图提示词", "全局生图提示词"],
  videoGlobalPrompt: ["videoGlobalPrompt", "video_global_prompt", "全局视频提示词"]
} as const;

const COMMON_PROMPT_LABELS = new Set([
  "画风", "风格", "角色", "人物", "宠物", "道具", "场景", "环境", "镜头", "机位", "构图",
  "动作", "运动", "一致性", "连续性", "禁止", "负面", "光线", "光影", "色彩", "声音", "音效"
]);

const KNOWN_FIELD_LABELS = [
  ...Object.values(fieldAliases).flat(),
  ...Object.values(projectFieldAliases).flat(),
  "项目名称", "项目", "视频名称"
];

export function parseStoryboard(source: string, fallbackProjectName = ""): ImportedStoryboard {
  const text = source.trim();
  if (!text) throw new Error("请粘贴分镜内容");
  if (text.startsWith("{") || text.startsWith("[")) return parseJsonStoryboard(text, fallbackProjectName);
  return parseMarkdownStoryboard(text, fallbackProjectName);
}

function parseJsonStoryboard(text: string, fallbackProjectName: string): ImportedStoryboard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON 格式无法解析，请检查逗号和引号");
  }
  const root = Array.isArray(parsed) ? { shots: parsed } : asRecord(parsed);
  const candidates = root.shots ?? root.storyboard ?? root.分镜 ?? root.镜头;
  if (!Array.isArray(candidates)) throw new Error("JSON 中没有找到 shots（分镜数组）");
  const projectName = stringValue(root.projectName ?? root.project ?? root.项目名称 ?? root.视频名称) || fallbackProjectName.trim();
  return finalize({
    projectName,
    globalPrompt: stringValue(pick(root, projectFieldAliases.globalPrompt)),
    imageGlobalPrompt: stringValue(pick(root, projectFieldAliases.imageGlobalPrompt)),
    videoGlobalPrompt: stringValue(pick(root, projectFieldAliases.videoGlobalPrompt)),
    shots: candidates.map((item, index) => normalizeShot(asRecord(item), index + 1)),
    warnings: []
  });
}

function parseMarkdownStoryboard(text: string, fallbackProjectName: string): ImportedStoryboard {
  const lines = text.split(/\r?\n/);
  let projectName = fallbackProjectName.trim();
  const projectFields: LooseRecord = {};
  const shots: ImportedShot[] = [];
  const suspiciousByShot = new Map<string, { lineNumber: number; shotNumber: number | null; labels: Set<string> }>();
  let current: LooseRecord | null = null;
  let activeField: keyof typeof fieldAliases | null = null;
  let activeProjectField: keyof typeof projectFieldAliases | null = null;

  const flush = () => {
    if (!current) return;
    shots.push(normalizeShot(current, shots.length + 1));
    current = null;
    activeField = null;
    activeProjectField = null;
  };

  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    const projectMatch = line.match(/^(?:#+\s*)?(?:项目(?:名称)?|视频名称)\s*[:：]\s*(.+)$/i);
    if (projectMatch && !current) {
      projectName = cleanMarkdown(projectMatch[1]);
      continue;
    }
    const projectFieldMatch = line.match(/^(?:[-*]\s*)?(全局提示词|全局分镜图提示词|全局生图提示词|全局视频提示词|global\s*prompt|image\s*global\s*prompt|video\s*global\s*prompt)\s*[:：]\s*(.*)$/i);
    if (projectFieldMatch && !current) {
      activeProjectField = projectAliasKey(projectFieldMatch[1]);
      projectFields[activeProjectField] = cleanMarkdown(projectFieldMatch[2]);
      activeField = null;
      continue;
    }
    const heading = line.match(/^(?:#{1,6}\s*)?(?:分镜|镜头|shot)\s*[-#：:]?\s*(\d+)/i);
    if (heading) {
      flush();
      current = { shotNumber: Number(heading[1]) };
      activeProjectField = null;
      continue;
    }
    const fieldMatch = line.match(/^(?:[-*]\s*)?(镜头名|分镜名|shot\s*name|口播|旁白|narration|voice\s*over|备注|notes?|首帧来源|first\s*frame\s*source|首帧图|首帧图片|first\s*frame\s*image|分镜图提示词|图片提示词|生图提示词|image\s*prompt|分镜视频提示词|视频提示词|video\s*prompt|模型|model|时长|秒数|duration|画幅|比例|aspect\s*ratio)\s*[:：]\s*(.*)$/i);
    if (fieldMatch) {
      if (!current) current = { shotNumber: shots.length + 1 };
      activeField = aliasKey(fieldMatch[1]);
      current[activeField] = cleanMarkdown(fieldMatch[2]);
      activeProjectField = null;
      continue;
    }
    const suspiciousField = line.match(/^(?:[-*]\s*)?([^:：]{1,24})\s*[:：]\s*(.*)$/);
    if (suspiciousField && ((current && activeField) || (!current && activeProjectField)) && isLikelyMistypedField(suspiciousField[1])) {
      const shotNumber = current ? positiveInteger(current.shotNumber) || shots.length + 1 : null;
      const key = shotNumber == null ? "project" : `shot-${shotNumber}`;
      const entry = suspiciousByShot.get(key) ?? { lineNumber: lineIndex + 1, shotNumber, labels: new Set<string>() };
      entry.labels.add(suspiciousField[1].trim());
      suspiciousByShot.set(key, entry);
    }
    if (current && activeField && line) {
      const previous = stringValue(current[activeField]);
      current[activeField] = `${previous}${previous ? "\n" : ""}${cleanMarkdown(line)}`;
      continue;
    }
    if (!current && activeProjectField && line) {
      const previous = stringValue(projectFields[activeProjectField]);
      projectFields[activeProjectField] = `${previous}${previous ? "\n" : ""}${cleanMarkdown(line)}`;
    }
  }
  flush();
  const warnings = [...suspiciousByShot.values()].map((entry) => {
    const labels = [...entry.labels];
    const scope = entry.shotNumber == null ? "项目全局" : `分镜 ${entry.shotNumber}`;
    return {
      lineNumber: entry.lineNumber,
      shotNumber: entry.shotNumber,
      label: labels.join("、"),
      message: `${scope}：疑似字段“${labels.join("、")}”（内容已保留在提示词正文中）`
    };
  });
  return finalize({
    projectName,
    globalPrompt: stringValue(projectFields.globalPrompt),
    imageGlobalPrompt: stringValue(projectFields.imageGlobalPrompt),
    videoGlobalPrompt: stringValue(projectFields.videoGlobalPrompt),
    shots,
    warnings
  });
}

function isLikelyMistypedField(label: string) {
  const normalized = normalizeLabel(label);
  if (!normalized || COMMON_PROMPT_LABELS.has(normalized) || /^\d+(?:[–—~～-]\d+)?秒$/.test(normalized)) return false;
  return KNOWN_FIELD_LABELS.some((known) => {
    const candidate = normalizeLabel(known);
    if (normalized.length >= 2 && (candidate.includes(normalized) || normalized.includes(candidate))) return true;
    return Math.max(normalized.length, candidate.length) >= 3 && editDistance(normalized, candidate) <= 1;
  });
}

function normalizeLabel(value: string) {
  return value.replace(/[\s_\-—–:：·•【】()[\]]+/g, "").toLowerCase();
}

function editDistance(left: string, right: string) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let previous = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const current = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      previous = current;
    }
  }
  return row[right.length];
}

function normalizeShot(record: LooseRecord, fallbackNumber: number): ImportedShot {
  const shotNumber = positiveInteger(pick(record, fieldAliases.shotNumber)) || fallbackNumber;
  const shotName = stringValue(pick(record, fieldAliases.shotName));
  const narration = stringValue(pick(record, fieldAliases.narration));
  const notes = stringValue(pick(record, fieldAliases.notes));
  const firstFrameImage = stringValue(pick(record, fieldAliases.firstFrameImage));
  const imagePrompt = stringValue(pick(record, fieldAliases.imagePrompt));
  const explicitSource = normalizeFirstFrameSource(pick(record, fieldAliases.firstFrameSource));
  const firstFrameSource = explicitSource ?? (firstFrameImage ? "local" : imagePrompt ? "generated" : "none");
  validateFirstFrame(shotNumber, firstFrameSource, Boolean(explicitSource), firstFrameImage, imagePrompt);
  const videoPrompt = stringValue(pick(record, fieldAliases.videoPrompt));
  const requestedModel = stringValue(pick(record, fieldAliases.model));
  const modelExplicit = Boolean(requestedModel);
  const model = VIDEO_MODEL_OPTIONS.some((item) => item.value === requestedModel)
    ? requestedModel
    : DEFAULT_VIDEO_MODEL.value;
  const rawDuration = pick(record, fieldAliases.duration);
  const rawAspectRatio = pick(record, fieldAliases.aspectRatio);
  const duration = normalizeDuration(rawDuration);
  const aspectRatio = normalizeAspectRatio(rawAspectRatio);
  return {
    shotNumber, shotName, narration, notes, firstFrameSource, firstFrameImage, imagePrompt, videoPrompt,
    model, modelExplicit, duration, durationExplicit: stringValue(rawDuration) !== "",
    aspectRatio, aspectRatioExplicit: stringValue(rawAspectRatio) !== ""
  };
}

function finalize(storyboard: ImportedStoryboard): ImportedStoryboard {
  const { shots } = storyboard;
  if (!shots.length) throw new Error("没有识别到分镜；建议使用 JSON，或用“分镜 1 / 分镜图提示词 / 视频提示词”格式");
  const missing = shots.filter((shot) => !shot.videoPrompt).map((shot) => shot.shotNumber);
  if (missing.length) throw new Error(`这些分镜缺少视频提示词：${missing.join("、")}`);
  return { ...storyboard, projectName: storyboard.projectName || "未命名项目" };
}

function aliasKey(label: string): keyof typeof fieldAliases {
  const normalized = label.replace(/\s+/g, "").toLowerCase();
  if (["镜头名", "分镜名", "shotname"].includes(normalized)) return "shotName";
  if (["口播", "旁白", "narration", "voiceover"].includes(normalized)) return "narration";
  if (["备注", "note", "notes"].includes(normalized)) return "notes";
  if (["首帧来源", "firstframesource"].includes(normalized)) return "firstFrameSource";
  if (["首帧图", "首帧图片", "firstframeimage"].includes(normalized)) return "firstFrameImage";
  if (["分镜图提示词", "图片提示词", "生图提示词", "imageprompt"].includes(normalized)) return "imagePrompt";
  if (["分镜视频提示词", "视频提示词", "videoprompt"].includes(normalized)) return "videoPrompt";
  if (["模型", "model"].includes(normalized)) return "model";
  if (["时长", "秒数", "duration"].includes(normalized)) return "duration";
  return "aspectRatio";
}

function projectAliasKey(label: string): keyof typeof projectFieldAliases {
  const normalized = label.replace(/\s+/g, "").toLowerCase();
  if (["全局分镜图提示词", "全局生图提示词", "imageglobalprompt"].includes(normalized)) return "imageGlobalPrompt";
  if (["全局视频提示词", "videoglobalprompt"].includes(normalized)) return "videoGlobalPrompt";
  return "globalPrompt";
}

function normalizeFirstFrameSource(value: unknown): FirstFrameSource | null {
  const normalized = stringValue(value).replace(/[\s_-]+/g, "").toLowerCase();
  if (!normalized) return null;
  if (["本地图片", "本地图", "local", "image"].includes(normalized)) return "local";
  if (["提示词生成", "生成", "generated", "prompt"].includes(normalized)) return "generated";
  if (["无", "纯文生视频", "none", "textonly"].includes(normalized)) return "none";
  throw new Error(`无法识别首帧来源：${stringValue(value)}`);
}

function validateFirstFrame(
  shotNumber: number,
  source: FirstFrameSource,
  explicit: boolean,
  firstFrameImage: string,
  imagePrompt: string
) {
  if (source === "generated" && !imagePrompt) throw new Error(`分镜 ${shotNumber} 使用提示词生成首帧，但缺少分镜图提示词`);
  if (!explicit) return;
  if (source === "local" && imagePrompt) throw new Error(`分镜 ${shotNumber} 明确使用本地首帧，不能同时填写分镜图提示词`);
  if (source === "generated" && firstFrameImage) throw new Error(`分镜 ${shotNumber} 明确使用提示词生成首帧，不能同时填写首帧图`);
  if (source === "none" && (firstFrameImage || imagePrompt)) throw new Error(`分镜 ${shotNumber} 明确不使用首帧，不能同时填写首帧图或分镜图提示词`);
}

function pick(record: LooseRecord, aliases: readonly string[]) {
  for (const alias of aliases) if (record[alias] !== undefined) return record[alias];
  return undefined;
}

function normalizeDuration(value: unknown) {
  if (stringValue(value).includes("自动")) return -1;
  const match = stringValue(value).match(/-?\d+/);
  const duration = match ? Number(match[0]) : 10;
  return duration === -1 ? -1 : Math.min(30, Math.max(4, duration));
}

function normalizeAspectRatio(value: unknown) {
  const raw = stringValue(value).replace("：", ":");
  if (raw.includes("自适应") || raw.includes("自动") || raw.toLowerCase() === "adaptive") return "adaptive";
  return ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(raw) ? raw : "9:16";
}

function positiveInteger(value: unknown) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? cleanMarkdown(value) : value == null ? "" : String(value).trim();
}

function cleanMarkdown(value: string) {
  return value.trim().replace(/^\*\*(.+)\*\*$/, "$1").trim();
}

function asRecord(value: unknown): LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("分镜数据必须是对象");
  return value as LooseRecord;
}
