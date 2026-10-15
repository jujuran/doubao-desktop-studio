import { DEFAULT_VIDEO_MODEL, VIDEO_MODEL_OPTIONS } from "./video-options";

export interface ImportedShot {
  shotNumber: number;
  imagePrompt: string;
  videoPrompt: string;
  model: string;
  duration: number;
  aspectRatio: string;
}

export interface ImportedStoryboard {
  projectName: string;
  shots: ImportedShot[];
}

type LooseRecord = Record<string, unknown>;

const fieldAliases = {
  shotNumber: ["shotNumber", "shot", "镜头编号", "分镜编号", "序号"],
  imagePrompt: ["imagePrompt", "image_prompt", "分镜图提示词", "图片提示词", "生图提示词"],
  videoPrompt: ["videoPrompt", "video_prompt", "分镜视频提示词", "视频提示词", "prompt"],
  model: ["model", "模型"],
  duration: ["duration", "时长", "秒数"],
  aspectRatio: ["aspectRatio", "aspect_ratio", "画幅", "比例"]
} as const;

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
  return finalize(projectName, candidates.map((item, index) => normalizeShot(asRecord(item), index + 1)));
}

function parseMarkdownStoryboard(text: string, fallbackProjectName: string): ImportedStoryboard {
  const lines = text.split(/\r?\n/);
  let projectName = fallbackProjectName.trim();
  const shots: ImportedShot[] = [];
  let current: LooseRecord | null = null;
  let activeField: keyof typeof fieldAliases | null = null;

  const flush = () => {
    if (!current) return;
    shots.push(normalizeShot(current, shots.length + 1));
    current = null;
    activeField = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const projectMatch = line.match(/^(?:#+\s*)?(?:项目(?:名称)?|视频名称)\s*[:：]\s*(.+)$/i);
    if (projectMatch && !current) {
      projectName = cleanMarkdown(projectMatch[1]);
      continue;
    }
    const heading = line.match(/^(?:#{1,6}\s*)?(?:分镜|镜头|shot)\s*[-#：:]?\s*(\d+)/i);
    if (heading) {
      flush();
      current = { shotNumber: Number(heading[1]) };
      continue;
    }
    const fieldMatch = line.match(/^(?:[-*]\s*)?(分镜图提示词|图片提示词|生图提示词|image\s*prompt|分镜视频提示词|视频提示词|video\s*prompt|模型|model|时长|秒数|duration|画幅|比例|aspect\s*ratio)\s*[:：]\s*(.*)$/i);
    if (fieldMatch) {
      if (!current) current = { shotNumber: shots.length + 1 };
      activeField = aliasKey(fieldMatch[1]);
      current[activeField] = cleanMarkdown(fieldMatch[2]);
      continue;
    }
    if (current && activeField && line) {
      const previous = stringValue(current[activeField]);
      current[activeField] = `${previous}${previous ? "\n" : ""}${cleanMarkdown(line)}`;
    }
  }
  flush();
  return finalize(projectName, shots);
}

function normalizeShot(record: LooseRecord, fallbackNumber: number): ImportedShot {
  const shotNumber = positiveInteger(pick(record, fieldAliases.shotNumber)) || fallbackNumber;
  const imagePrompt = stringValue(pick(record, fieldAliases.imagePrompt));
  const videoPrompt = stringValue(pick(record, fieldAliases.videoPrompt));
  const requestedModel = stringValue(pick(record, fieldAliases.model));
  const model = VIDEO_MODEL_OPTIONS.some((item) => item.value === requestedModel)
    ? requestedModel
    : DEFAULT_VIDEO_MODEL.value;
  const duration = normalizeDuration(pick(record, fieldAliases.duration));
  const aspectRatio = normalizeAspectRatio(pick(record, fieldAliases.aspectRatio));
  return { shotNumber, imagePrompt, videoPrompt, model, duration, aspectRatio };
}

function finalize(projectName: string, shots: ImportedShot[]): ImportedStoryboard {
  if (!shots.length) throw new Error("没有识别到分镜；建议使用 JSON，或用“分镜 1 / 分镜图提示词 / 视频提示词”格式");
  const missing = shots.filter((shot) => !shot.videoPrompt).map((shot) => shot.shotNumber);
  if (missing.length) throw new Error(`这些分镜缺少视频提示词：${missing.join("、")}`);
  return { projectName: projectName || "未命名项目", shots };
}

function aliasKey(label: string): keyof typeof fieldAliases {
  const normalized = label.replace(/\s+/g, "").toLowerCase();
  if (["分镜图提示词", "图片提示词", "生图提示词", "imageprompt"].includes(normalized)) return "imagePrompt";
  if (["分镜视频提示词", "视频提示词", "videoprompt"].includes(normalized)) return "videoPrompt";
  if (["模型", "model"].includes(normalized)) return "model";
  if (["时长", "秒数", "duration"].includes(normalized)) return "duration";
  return "aspectRatio";
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
  if (raw.includes("自适应") || raw.toLowerCase() === "adaptive") return "adaptive";
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
