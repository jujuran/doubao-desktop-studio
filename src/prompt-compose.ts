import type { ProjectStyleProfile } from "../electron/contracts.js";

export type PromptStage = "image" | "video";

export function composeProjectPrompt(stage: PromptStage, shotPrompt: string, profile?: ProjectStyleProfile | null) {
  return compose(stage, shotPrompt, profile, true);
}

export function composeDeliveryPrompt(stage: PromptStage, shotPrompt: string, profile?: ProjectStyleProfile | null) {
  return compose(stage, shotPrompt, profile, false);
}

function compose(stage: PromptStage, shotPrompt: string, profile: ProjectStyleProfile | null | undefined, headings: boolean) {
  if (!profile || profile.migrationPending || !hasProjectStyle(profile)) return shotPrompt.trim();
  const stagePrompt = stage === "image" ? profile.imageGlobalPrompt : profile.videoGlobalPrompt;
  const globalPrompt = stagePrompt.trim() || profile.globalPrompt.trim();
  const sections: Array<[string, string]> = [
    [stage === "image" ? "全局分镜图提示词" : "全局视频提示词", globalPrompt],
    [stage === "image" ? "本分镜画面" : "本分镜视频", shotPrompt]
  ];
  const references = referenceInstruction(profile);
  if (references) sections.splice(1, 0, ["参考素材约束", references]);
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
    || profile.characterReferencePath
    || profile.sceneReferencePath
    || profile.styleReferencePath
    || profile.lockedModel
    || profile.lockedAspectRatio
  ));
}

function referenceInstruction(profile: ProjectStyleProfile) {
  const items = [
    profile.characterReferencePath ? "角色定妆图：严格保持角色身份、外形、花纹、配饰与身体比例" : "",
    profile.sceneReferencePath ? "场景参考图：严格保持空间布局、道具位置、时间与光线方向" : "",
    profile.styleReferencePath ? "风格参考图：严格保持色彩、材质、光影和镜头质感" : ""
  ].filter(Boolean);
  return items.join("\n");
}
