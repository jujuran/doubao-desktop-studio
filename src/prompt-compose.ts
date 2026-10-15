import type { ProjectStyleProfile } from "../electron/contracts.js";

export type PromptStage = "image" | "video";

export function composeProjectPrompt(stage: PromptStage, shotPrompt: string, profile?: ProjectStyleProfile | null) {
  if (!profile || !hasProjectStyle(profile)) return shotPrompt.trim();
  const sections: Array<[string, string]> = [
    ["项目固定风格", profile.stylePrompt],
    ["固定人物", profile.characterPrompt],
    ["固定场景", profile.scenePrompt],
    [stage === "image" ? "本分镜画面" : "本分镜视频", shotPrompt],
    ["连续性约束", profile.continuityPrompt],
    ["禁止项", profile.negativePrompt]
  ];
  const references = referenceInstruction(profile);
  if (references) sections.splice(3, 0, ["参考素材约束", references]);
  return sections
    .filter(([, value]) => value.trim())
    .map(([title, value]) => `【${title}】\n${value.trim()}`)
    .join("\n\n");
}

export function hasProjectStyle(profile?: ProjectStyleProfile | null) {
  return Boolean(profile && (
    profile.stylePrompt.trim()
    || profile.characterPrompt.trim()
    || profile.scenePrompt.trim()
    || profile.continuityPrompt.trim()
    || profile.negativePrompt.trim()
    || profile.characterReferencePath
    || profile.sceneReferencePath
    || profile.styleReferencePath
    || profile.lockedModel
    || profile.lockedAspectRatio
  ));
}

function referenceInstruction(profile: ProjectStyleProfile) {
  const items = [
    profile.characterReferencePath ? "人物定妆图：严格保持脸型、发型、服装、年龄与体型" : "",
    profile.sceneReferencePath ? "场景参考图：严格保持空间布局、道具位置、时间与光线方向" : "",
    profile.styleReferencePath ? "风格参考图：严格保持色彩、材质、光影和镜头质感" : ""
  ].filter(Boolean);
  return items.join("\n");
}
