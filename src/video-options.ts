export interface VideoModelOption {
  value: string;
  label: string;
  durationMin: number;
  durationMax: number;
  supportsAdaptiveDuration: boolean;
  aspectRatios: readonly string[];
}

export const VIDEO_MODEL_OPTIONS: readonly VideoModelOption[] = [
  {
    value: "Seedance 2.5",
    label: "Seedance 2.5",
    durationMin: 4,
    durationMax: 30,
    supportsAdaptiveDuration: true,
    aspectRatios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]
  },
  {
    value: "Seedance 2.0",
    label: "Seedance 2.0",
    durationMin: 4,
    durationMax: 15,
    supportsAdaptiveDuration: true,
    aspectRatios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]
  },
  {
    value: "Seedance 2.0 fast",
    label: "Seedance 2.0 fast",
    durationMin: 4,
    durationMax: 15,
    supportsAdaptiveDuration: true,
    aspectRatios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]
  },
  {
    value: "Seedance 2.0 mini",
    label: "Seedance 2.0 mini",
    durationMin: 4,
    durationMax: 15,
    supportsAdaptiveDuration: true,
    aspectRatios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]
  }
];

export const DEFAULT_VIDEO_MODEL =
  VIDEO_MODEL_OPTIONS.find((model) => model.value === "Seedance 2.0 mini") ?? VIDEO_MODEL_OPTIONS[0];

export function durationOptions(model: VideoModelOption) {
  const fixedDurations = Array.from(
    { length: model.durationMax - model.durationMin + 1 },
    (_, index) => model.durationMin + index
  );
  return model.supportsAdaptiveDuration ? [-1, ...fixedDurations] : fixedDurations;
}

export function durationLabel(duration: number) {
  return duration === -1 ? "自动" : `${duration} 秒`;
}

export function aspectRatioLabel(aspectRatio: string) {
  return aspectRatio === "adaptive" ? "自适应" : aspectRatio;
}
