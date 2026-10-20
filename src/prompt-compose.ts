import type { ProjectStyleProfile } from "../electron/contracts.js";

export type PromptStage = "image" | "video";

export function composeProjectPrompt(stage: PromptStage, shotPrompt: string, profile?: ProjectStyleProfile | null) {
  return compose(stage, shotPrompt, profile, true);
}

export function composeDeliveryPrompt(stage: PromptStage, shotPrompt: string, profile?: ProjectStyleProfile | null) {
  return compose(stage, shotPrompt, profile, false);
}

export const IMAGE_REFERENCE_MATERIAL_CONSTRAINT = "参考素材约束：请以已上传的角色参考图为准，保持同一角色的品种、体型、毛色分布、五官、耳朵、尾巴和配饰一致；不要新增、替换或混合角色。";

export function appendImageReferenceConstraint(prompt: string) {
  return [prompt.trim(), IMAGE_REFERENCE_MATERIAL_CONSTRAINT].filter(Boolean).join("\n\n");
}

function compose(stage: PromptStage, shotPrompt: string, profile: ProjectStyleProfile | null | undefined, headings: boolean) {
  if (!profile || profile.migrationPending || !hasProjectStyle(profile)) return shotPrompt.trim();
  const globalPrompt = projectStagePrompt(stage, profile);
  const sections: Array<[string, string]> = [
    [stage === "image" ? "全局分镜图提示词" : "全局视频提示词", globalPrompt],
    [stage === "image" ? "本分镜画面" : "本分镜视频", shotPrompt]
  ];
  const included = sections
    .filter(([, value]) => value.trim())
  return included
    .map(([title, value]) => headings ? `【${title}】\n${value.trim()}` : value.trim())
    .join("\n\n");
}

export function hasProjectStyle(profile?: ProjectStyleProfile | null) {
  return Boolean(profile && (
    profile.globalPrompt.trim()
    || profile.imageGlobalPrompt.trim()
    || profile.videoGlobalPrompt.trim()
    || profile.characterReferencePaths.length
    || profile.sceneReferencePath
    || profile.styleReferencePath
    || profile.lockedModel
    || profile.lockedAspectRatio
  ));
}

export function projectStagePrompt(stage: PromptStage, profile?: ProjectStyleProfile | null) {
  if (!profile || profile.migrationPending) return "";
  const stagePrompt = stage === "image" ? profile.imageGlobalPrompt : profile.videoGlobalPrompt;
  return stagePrompt.trim() || profile.globalPrompt.trim();
}
