<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type {
  Account,
  AccountUsage,
  AssetFolderSelection,
  AppSettings,
  ImageTaskStatus,
  ProjectReferenceKind,
  ProjectRecord,
  ProjectStatus,
  ProjectStyleInput,
  ProjectStyleProfile,
  RuntimeStats,
  TaskInput,
  TaskRecord,
  TaskStatus
} from "../electron/contracts";
import appIcon from "./assets/app-icon.png";
import { parseStoryboard, type ImportedShot } from "./storyboard-import";
import { inferAspectRatio, resolveProjectReferenceAssets, resolveStoryboardAssets } from "./storyboard-assets";
import { composeDeliveryPrompt, composeProjectPrompt, hasProjectStyle, projectStagePrompt, type PromptStage } from "./prompt-compose";
import {
  aspectRatioLabel,
  DEFAULT_VIDEO_MODEL,
  durationLabel,
  durationOptions,
  VIDEO_MODEL_OPTIONS
} from "./video-options";

type Tab = "overview" | "accounts" | "tasks" | "projects" | "settings";

const activeTab = ref<Tab>("overview");
const accounts = ref<Account[]>([]);
const tasks = ref<TaskRecord[]>([]);
const usage = ref<AccountUsage[]>([]);
const projectStyles = ref<ProjectStyleProfile[]>([]);
const projects = ref<ProjectRecord[]>([]);
const selectedProjectName = ref("");
const settings = ref<AppSettings>({
  maxActiveWorkers: 3,
  automationEnabled: false,
  autoClickGenerate: false,
  lastTaskAccountId: null,
  lastVideoModel: DEFAULT_VIDEO_MODEL.value,
  lastVideoDuration: 10,
  lastAspectRatio: "9:16"
});
const runtime = ref<RuntimeStats>({
  version: "",
  totalPrivateMb: 0,
  processCount: 0,
  activeAccountWindows: 0,
  activeAccountIds: [],
  dataPath: "",
  logPath: "",
  dataPathNotice: null
});
const loading = ref(true);
const notice = ref("");
const noticeError = ref(false);
const aboutCard = ref<HTMLElement | null>(null);
const settingsSaveState = ref<"saved" | "saving" | "error">("saved");
const newAccountLabel = ref("");
const showAccountDialog = ref(false);
const renameAccountTarget = ref<Account | null>(null);
const renameAccountLabel = ref("");
const editingTaskId = ref<string | null>(null);
const showTaskDialog = ref(false);
const taskLocalImagePath = ref("");
const taskLocalImageName = ref("");
const taskAspectFromFrame = ref(false);
const taskParameterTouched = reactive({ model: false, duration: false, aspectRatio: false });
const showImportDialog = ref(false);
const importText = ref("");
const importProjectName = ref("");
const importAssets = ref<AssetFolderSelection>({ cancelled: false, folderPath: null, files: [] });
const importGlobalChoice = ref<"incoming" | "existing">("incoming");
const styleTargetName = ref<string | null>(null);
const applyStyleLocks = ref(true);
const styleForm = reactive<ProjectStyleInput>({
  projectName: "",
  globalPrompt: "",
  imageGlobalPrompt: "",
  videoGlobalPrompt: "",
  migrationPending: false,
  characterReferencePaths: [],
  characterReferenceNames: [],
  sceneReferencePath: null,
  sceneReferenceName: null,
  styleReferencePath: null,
  styleReferenceName: null,
  outputDirectory: null,
  lockedModel: null,
  lockedAspectRatio: null
});
const taskForm = reactive({
  projectName: "",
  shotNumber: 1,
  shotName: "",
  narration: "",
  notes: "",
  generationCount: 1,
  imagePrompt: "",
  imageAccountId: "",
  accountId: "",
  prompt: "",
  model: DEFAULT_VIDEO_MODEL.value,
  duration: 10,
  aspectRatio: "9:16"
});

const readyAccounts = computed(() => accounts.value.filter((account) => account.status === "ready"));
const queuedTasks = computed(() => tasks.value.filter((task) => task.status === "queued").length);
const activeTasks = computed(() => tasks.value.filter((task) => task.status === "running").length);
const settingsSaveLabel = computed(() => ({
  saved: "✓ 修改后自动保存",
  saving: "正在保存…",
  error: "保存失败，请重试"
})[settingsSaveState.value]);
const accountById = computed(() => new Map(accounts.value.map((account) => [account.id, account])));
const usageByAccount = computed(() => new Map(usage.value.map((item) => [item.accountId, item])));
const projectStyleByName = computed(() => new Map(projectStyles.value.map((profile) => [profile.projectName, profile])));
const stylePreviewProfile = computed<ProjectStyleProfile>(() => ({
  ...styleForm,
  characterReferenceNames: styleForm.characterReferenceNames ?? [],
  sceneReferenceName: styleForm.sceneReferenceName ?? null,
  styleReferenceName: styleForm.styleReferenceName ?? null,
  outputDirectory: styleForm.outputDirectory ?? null,
  characterReferenceHashes: [],
  updatedAt: ""
}));
const stylePreviewTask = computed(() => tasks.value.find((task) => task.projectName === styleForm.projectName) ?? null);
const styleImagePreview = computed(() => composeProjectPrompt(
  "image",
  stylePreviewTask.value?.imagePrompt || "（当前分镜图提示词）",
  stylePreviewProfile.value
));
const styleVideoPreview = computed(() => composeProjectPrompt(
  "video",
  stylePreviewTask.value?.prompt || "（当前分镜视频提示词）",
  stylePreviewProfile.value
));
const importPreview = computed(() => {
  if (!importText.value.trim()) return { storyboard: null, error: "" };
  try {
    return { storyboard: parseStoryboard(importText.value, importProjectName.value), error: "" };
  } catch (error) {
    return { storyboard: null, error: error instanceof Error ? error.message : String(error) };
  }
});
const importAssetResolution = computed(() => importPreview.value.storyboard
  ? resolveStoryboardAssets(importPreview.value.storyboard.shots, importAssets.value.files)
  : null
);
const importCharacterReferenceResolution = computed(() => importPreview.value.storyboard
  ? resolveProjectReferenceAssets(importPreview.value.storyboard.characterReferenceImages, importAssets.value.files)
  : null
);
const importGlobalConflict = computed(() => {
  const storyboard = importPreview.value.storyboard;
  if (!storyboard) return false;
  const existing = projectStyleByName.value.get(storyboard.projectName);
  if (!existing) return false;
  const incoming = [storyboard.globalPrompt, storyboard.imageGlobalPrompt, storyboard.videoGlobalPrompt].join("\n").trim();
  const saved = [existing.globalPrompt, existing.imageGlobalPrompt, existing.videoGlobalPrompt].join("\n").trim();
  return Boolean(incoming && incoming !== saved);
});
const importPromptProfile = computed<ProjectStyleProfile | null>(() => {
  const storyboard = importPreview.value.storyboard;
  if (!storyboard) return null;
  const existing = projectStyleByName.value.get(storyboard.projectName) ?? null;
  const incomingHasGlobals = Boolean(storyboard.globalPrompt || storyboard.imageGlobalPrompt || storyboard.videoGlobalPrompt);
  if (existing && !incomingHasGlobals) return existing;
  if (existing && importGlobalConflict.value && importGlobalChoice.value === "existing") return existing;
  return {
    projectName: storyboard.projectName,
    globalPrompt: storyboard.globalPrompt,
    imageGlobalPrompt: storyboard.imageGlobalPrompt,
    videoGlobalPrompt: storyboard.videoGlobalPrompt,
    migrationPending: false,
    characterReferencePaths: importCharacterReferenceResolution.value?.files.map((file) => file.path) ?? existing?.characterReferencePaths ?? [],
    characterReferenceHashes: [],
    characterReferenceNames: importCharacterReferenceResolution.value?.files.map((file) => file.name) ?? existing?.characterReferenceNames ?? [],
    sceneReferencePath: existing?.sceneReferencePath ?? null,
    sceneReferenceName: existing?.sceneReferenceName ?? null,
    styleReferencePath: existing?.styleReferencePath ?? null,
    styleReferenceName: existing?.styleReferenceName ?? null,
    outputDirectory: existing?.outputDirectory ?? importAssets.value.folderPath ?? null,
    lockedModel: existing?.lockedModel ?? null,
    lockedAspectRatio: existing?.lockedAspectRatio ?? null,
    updatedAt: ""
  };
});
const canImportStoryboard = computed(() => Boolean(
  importPreview.value.storyboard
  && !importAssetResolution.value?.hasErrors
));
const importUnusedFiles = computed(() => {
  const referencePaths = new Set(importCharacterReferenceResolution.value?.files.map((file) => file.path) ?? []);
  return (importAssetResolution.value?.unusedFiles ?? []).filter((file) => !referencePaths.has(file.path));
});
const selectedVideoModel = computed(
  () => VIDEO_MODEL_OPTIONS.find((model) => model.value === taskForm.model) ?? DEFAULT_VIDEO_MODEL
);
const availableDurations = computed(() => durationOptions(selectedVideoModel.value));
const availableAspectRatios = computed(() => selectedVideoModel.value.aspectRatios);
const taskGroups = computed(() => {
  const groups = new Map<string, TaskRecord[]>();
  for (const task of tasks.value.filter((item) => item.projectName === selectedProjectName.value)) {
    const projectName = task.projectName;
    const group = groups.get(projectName) ?? [];
    group.push(task);
    groups.set(projectName, group);
  }
  return [...groups.entries()].map(([projectName, groupTasks]) => ({
    projectName,
    name: projectName || "未命名项目",
    tasks: groupTasks.sort((left, right) => left.shotNumber - right.shotNumber)
  }));
});
const currentProject = computed(() => projects.value.find((project) => project.projectName === selectedProjectName.value) ?? null);
const currentProjectTasks = computed(() => tasks.value.filter((task) => task.projectName === selectedProjectName.value));

let removeChangeListener: (() => void) | undefined;
let statsTimer: number | undefined;
let taskDefaultsLoaded = false;
let settingsSaveRevision = 0;

onMounted(async () => {
  await refresh();
  removeChangeListener = window.desktopApi.onDataChanged(() => void refreshData());
  statsTimer = window.setInterval(() => void refreshRuntime(), 4000);
});

onBeforeUnmount(() => {
  removeChangeListener?.();
  if (statsTimer) window.clearInterval(statsTimer);
});

async function refresh() {
  loading.value = true;
  try {
    await Promise.all([refreshData(), refreshRuntime()]);
  } finally {
    loading.value = false;
  }
}

async function refreshData() {
  const [nextAccounts, nextTasks, nextSettings, nextUsage, nextProjects, nextProjectStyles] = await Promise.all([
    window.desktopApi.accounts.list(),
    window.desktopApi.tasks.list(),
    window.desktopApi.settings.get(),
    window.desktopApi.usage.listToday(),
    window.desktopApi.projects.list(),
    window.desktopApi.projects.listStyles()
  ]);
  accounts.value = nextAccounts;
  tasks.value = nextTasks;
  settings.value = nextSettings;
  usage.value = nextUsage;
  projects.value = nextProjects;
  projectStyles.value = nextProjectStyles;
  if (!nextProjects.some((project) => project.projectName === selectedProjectName.value && project.status !== "archived")) {
    selectedProjectName.value = nextProjects.find((project) => project.status === "active")?.projectName
      ?? nextProjects.find((project) => project.status === "completed")?.projectName
      ?? "";
  }
  if (!taskDefaultsLoaded) {
    taskForm.imageAccountId = "";
    taskForm.accountId = "";
    taskForm.model = VIDEO_MODEL_OPTIONS.some((model) => model.value === nextSettings.lastVideoModel)
      ? nextSettings.lastVideoModel
      : DEFAULT_VIDEO_MODEL.value;
    taskForm.duration = nextSettings.lastVideoDuration;
    taskForm.aspectRatio = nextSettings.lastAspectRatio;
    handleModelChange();
    taskDefaultsLoaded = true;
  }
}

async function refreshRuntime() {
  runtime.value = await window.desktopApi.runtime.stats();
}

function openAddAccount() {
  newAccountLabel.value = `账号 ${accounts.value.length + 1}`;
  showAccountDialog.value = true;
}

async function createAccount() {
  await act(async () => {
    await window.desktopApi.accounts.create(newAccountLabel.value);
    showAccountDialog.value = false;
    flash("已创建隔离账号空间，请在打开的窗口中登录豆包");
  });
}

async function verifyAccount(account: Account) {
  await act(async () => {
    const result = await window.desktopApi.accounts.verify(account.id);
    flash(result.message, !result.ok);
  });
}

async function openAccount(account: Account) {
  await act(async () => {
    await window.desktopApi.accounts.open(account.id);
  });
}

function openRenameAccount(account: Account) {
  renameAccountTarget.value = account;
  renameAccountLabel.value = account.label;
}

async function renameAccount() {
  if (!renameAccountTarget.value) return;
  await act(async () => {
    await window.desktopApi.accounts.rename(renameAccountTarget.value!.id, renameAccountLabel.value);
    renameAccountTarget.value = null;
    flash("账号备注已更新");
  });
}

async function clearAccountCache(account: Account) {
  await act(async () => {
    await window.desktopApi.accounts.clearCache(account.id);
    flash("缓存已清理，登录状态已保留");
  });
}

async function calibrateUsage(account: Account) {
  const current = accountUsage(account.id);
  const imageValue = window.prompt(`“${account.label}”今天已生成多少张分镜图？`, String(current.imageCount));
  if (imageValue === null) return;
  const videoValue = window.prompt(`“${account.label}”今天已生成多少条视频？`, String(current.videoCount));
  if (videoValue === null) return;
  await act(async () => {
    await window.desktopApi.usage.adjust(account.id, "image", Number(imageValue));
    await window.desktopApi.usage.adjust(account.id, "video", Number(videoValue));
    flash("今日用量已校准，后续自动分配会按新数字计算");
  });
}

async function removeAccount(account: Account) {
  if (!window.confirm(`删除“${account.label}”及其本机登录状态？任务记录会保留。`)) return;
  await act(async () => {
    await window.desktopApi.accounts.remove(account.id);
    flash("账号及其本机浏览器数据已删除");
  });
}

async function saveTask() {
  if (taskLocalImagePath.value && taskForm.imagePrompt.trim()) {
    flash("首帧图和分镜图提示词只能保留一个，请先清除其中一项", true);
    return;
  }
  await act(async () => {
    const previous = editingTaskId.value ? tasks.value.find((task) => task.id === editingTaskId.value) : null;
    const firstFrameSource = taskLocalImagePath.value ? "local" : taskForm.imagePrompt.trim() ? "generated" : "none";
    const input: TaskInput = {
      projectName: taskForm.projectName,
      shotNumber: Number(taskForm.shotNumber),
      shotName: taskForm.shotName,
      narration: taskForm.narration,
      notes: taskForm.notes,
      generationCount: Number(taskForm.generationCount),
      firstFrameSource,
      firstFrameFileName: firstFrameSource === "local"
        ? taskLocalImageName.value || previous?.firstFrameFileName || null
        : firstFrameSource === "generated" && previous?.firstFrameSource === "generated"
          ? previous.firstFrameFileName
          : null,
      sourceImagePath: firstFrameSource === "local" ? taskLocalImagePath.value : null,
      imagePrompt: taskForm.imagePrompt,
      imageAccountId: taskForm.imageAccountId || null,
      accountId: taskForm.accountId || null,
      prompt: taskForm.prompt,
      model: taskForm.model,
      modelSource: previous && previous.model === taskForm.model ? previous.modelSource : taskParameterTouched.model ? "shot" : "default",
      duration: Number(taskForm.duration),
      durationSource: previous && previous.duration === Number(taskForm.duration) ? previous.durationSource : taskParameterTouched.duration ? "shot" : "default",
      aspectRatio: taskForm.aspectRatio,
      aspectRatioSource: taskAspectFromFrame.value
        ? "first_frame"
        : previous && previous.aspectRatio === taskForm.aspectRatio
          ? previous.aspectRatioSource
          : taskParameterTouched.aspectRatio ? "shot" : "default"
    };
    if (editingTaskId.value) await window.desktopApi.tasks.update(editingTaskId.value, input);
    else await window.desktopApi.tasks.create(input);
    selectedProjectName.value = input.projectName.trim();
    settings.value = await window.desktopApi.settings.update({
      lastTaskAccountId: input.accountId,
      lastVideoModel: input.model,
      lastVideoDuration: input.duration,
      lastAspectRatio: input.aspectRatio
    });
    const wasEditing = Boolean(editingTaskId.value);
    editingTaskId.value = null;
    showTaskDialog.value = false;
    taskLocalImagePath.value = "";
    taskLocalImageName.value = "";
    taskAspectFromFrame.value = false;
    taskForm.imagePrompt = "";
    taskForm.shotName = "";
    taskForm.narration = "";
    taskForm.notes = "";
    taskForm.generationCount = 1;
    taskForm.prompt = "";
    if (!wasEditing) taskForm.shotNumber += 1;
    flash(wasEditing ? "任务修改已保存" : "任务已保存，可继续填写下一分镜");
  });
}

function editTask(task: TaskRecord) {
  editingTaskId.value = task.id;
  taskForm.projectName = task.projectName;
  taskForm.shotNumber = task.shotNumber;
  taskForm.shotName = task.shotName;
  taskForm.narration = task.narration;
  taskForm.notes = task.notes;
  taskForm.generationCount = task.generationCount;
  taskLocalImagePath.value = task.firstFrameSource === "local" ? task.imagePath || "" : "";
  taskLocalImageName.value = task.firstFrameSource === "local" ? task.firstFrameFileName || fileName(task.imagePath) : "";
  taskForm.imagePrompt = task.imagePrompt;
  taskForm.imageAccountId = task.imageAccountId ?? "";
  taskForm.accountId = task.accountId ?? "";
  taskForm.prompt = task.prompt;
  taskForm.model = task.model;
  taskForm.duration = task.duration;
  taskForm.aspectRatio = task.aspectRatio;
  handleModelChange();
  Object.assign(taskParameterTouched, { model: false, duration: false, aspectRatio: false });
  taskAspectFromFrame.value = false;
  showTaskDialog.value = true;
}

function cancelTaskEdit() {
  editingTaskId.value = null;
  showTaskDialog.value = false;
  taskForm.imagePrompt = "";
  taskForm.shotName = "";
  taskForm.narration = "";
  taskForm.notes = "";
  taskForm.generationCount = 1;
  taskForm.prompt = "";
  taskLocalImagePath.value = "";
  taskLocalImageName.value = "";
  taskAspectFromFrame.value = false;
  Object.assign(taskParameterTouched, { model: false, duration: false, aspectRatio: false });
  restoreTaskDefaults();
}

function openNewTask() {
  editingTaskId.value = null;
  taskForm.shotName = "";
  taskForm.narration = "";
  taskForm.notes = "";
  taskForm.generationCount = 1;
  taskForm.imagePrompt = "";
  taskForm.prompt = "";
  taskLocalImagePath.value = "";
  taskLocalImageName.value = "";
  taskAspectFromFrame.value = false;
  Object.assign(taskParameterTouched, { model: false, duration: false, aspectRatio: false });
  const currentProject = selectedProjectName.value || taskForm.projectName.trim() || tasks.value[0]?.projectName || "";
  taskForm.projectName = currentProject;
  taskForm.shotNumber = Math.max(0, ...tasks.value.filter((task) => task.projectName === currentProject).map((task) => task.shotNumber)) + 1;
  restoreTaskDefaults();
  showTaskDialog.value = true;
}

async function chooseTaskSourceImage() {
  const selected = await window.desktopApi.tasks.chooseSourceImage();
  if (!selected) return;
  taskLocalImagePath.value = selected.path;
  taskLocalImageName.value = selected.name;
  const previous = editingTaskId.value ? tasks.value.find((task) => task.id === editingTaskId.value) : null;
  if (!taskParameterTouched.aspectRatio && (!previous || ["default", "first_frame"].includes(previous.aspectRatioSource))) {
    taskForm.aspectRatio = selected.aspectRatio;
    taskAspectFromFrame.value = true;
  }
}

function clearTaskSourceImage() {
  taskLocalImagePath.value = "";
  taskLocalImageName.value = "";
  taskAspectFromFrame.value = false;
}

function markModelChange() {
  taskParameterTouched.model = true;
  handleModelChange();
}

function markAspectChange() {
  taskParameterTouched.aspectRatio = true;
  taskAspectFromFrame.value = false;
}

function restoreTaskDefaults() {
  taskForm.imageAccountId = "";
  taskForm.accountId = "";
  taskForm.model = VIDEO_MODEL_OPTIONS.some((model) => model.value === settings.value.lastVideoModel)
    ? settings.value.lastVideoModel
    : DEFAULT_VIDEO_MODEL.value;
  taskForm.duration = settings.value.lastVideoDuration;
  taskForm.aspectRatio = settings.value.lastAspectRatio;
  handleModelChange();
}

async function openTask(task: TaskRecord) {
  await act(async () => {
    await window.desktopApi.tasks.open(task.id);
    const frameNote = task.firstFrameSource === "none" ? "" : "，已自动上传锁定首帧";
    const referenceNote = projectHasReferences(task.projectName) ? "；视频阶段未额外上传项目参考图" : "";
    flash(`已打开豆包视频页并自动填入合成提示词${frameNote}${referenceNote}${settings.value.autoClickGenerate ? '，核对通过后已自动点击生成' : '，请确认后点击生成'}`);
  });
}

async function openImageTask(task: TaskRecord) {
  await act(async () => {
    await window.desktopApi.tasks.openImage(task.id);
    const profile = projectStyleByName.value.get(task.projectName);
    const referenceNote = profile?.characterReferencePaths.length ? `；已自动上传 ${profile.characterReferencePaths.length} 张角色参考图` : "";
    flash(`已打开豆包生图页并自动填入合成提示词${referenceNote}${settings.value.autoClickGenerate ? '，核对通过后已自动点击生成' : '，请确认后点击生成'}`);
  });
}

async function chooseTaskImage(task: TaskRecord) {
  await act(async () => {
    const updated = await window.desktopApi.tasks.chooseImage(task.id);
    if (updated) flash("已关联分镜图并通过审核");
  });
}

async function importImageCandidate(task: TaskRecord) {
  await act(async () => {
    const imported = await window.desktopApi.tasks.importImageCandidate(task.id);
    if (imported) flash("分镜图已导入候选列表，审核通过后才会替换当前锁定首帧");
  });
}

async function cancelImageRegeneration(task: TaskRecord) {
  await act(async () => {
    await window.desktopApi.tasks.cancelImageRegeneration(task.id);
    flash("已取消重新生图，继续使用原来锁定的首帧");
  });
}

async function updateImageTask(task: TaskRecord, status: ImageTaskStatus) {
  await act(async () => {
    await window.desktopApi.tasks.updateImageStatus(task.id, status);
    flash(status === "approved" ? "分镜图已通过审核，可以进入视频阶段" : "分镜图状态已更新");
  });
}

async function approveImageCandidate(candidateId: string) {
  await act(async () => {
    await window.desktopApi.tasks.approveImageCandidate(candidateId);
    flash(settings.value.autoClickGenerate ? "首帧已锁定，已自动衔接视频生成" : "候选图已审核通过并锁定为首帧");
  });
}

async function reviewVideoCandidate(candidateId: string, approved: boolean) {
  await act(async () => {
    await window.desktopApi.tasks.reviewVideoCandidate(candidateId, approved);
    flash(approved ? "视频已审核通过" : "视频已移入作废文件夹，可重新生成");
  });
}

async function recheckVideoDownload(task: TaskRecord) {
  await act(async () => {
    await window.desktopApi.tasks.recheckDownload(task.id);
    flash("已重新检查豆包并下载最新原视频");
  });
}

async function retryRejectedGeneration(task: TaskRecord, route: "image" | "video") {
  await act(async () => {
    await window.desktopApi.tasks.retryRejected(task.id, route);
    flash(`已在原豆包对话中重试${route === "image" ? "生图" : "视频"}，不会重新上传参考素材`);
  });
}

async function importVideoCandidate(task: TaskRecord) {
  await act(async () => {
    const imported = await window.desktopApi.tasks.importVideoCandidate(task.id);
    if (imported) flash("视频已导入为待审核候选");
  });
}

async function openCandidateFolder(candidateId: string) {
  await window.desktopApi.tasks.openCandidateFolder(candidateId);
}

async function autoAssignTasks() {
  await act(async () => {
    const summary = await window.desktopApi.tasks.autoAssign();
    flash(`已分配 ${summary.imageAssignments} 个生图任务、${summary.videoAssignments} 个视频任务`);
  });
}

function openNewProject() {
  importText.value = "";
  importProjectName.value = "";
  importAssets.value = { cancelled: false, folderPath: null, files: [] };
  showImportDialog.value = true;
}

function uniqueProjectCopyName(name: string) {
  let index = 2;
  let candidate = `${name}（副本）`;
  const names = new Set(projects.value.map((project) => project.projectName));
  while (names.has(candidate)) candidate = `${name}（副本 ${index++}）`;
  return candidate;
}

async function changeProjectStatus(projectName: string, status: ProjectStatus) {
  await act(async () => {
    await window.desktopApi.projects.setStatus(projectName, status);
    if (status === "archived" && selectedProjectName.value === projectName) selectedProjectName.value = "";
    flash(status === "archived" ? "项目已归档，全部分镜、提示词、候选和文件均已保留" : status === "completed" ? "项目已标记完成" : "项目已恢复到制作中");
  });
}

async function continueProject(project: ProjectRecord) {
  if (project.status !== "active") await window.desktopApi.projects.setStatus(project.projectName, "active");
  selectedProjectName.value = project.projectName;
  activeTab.value = "tasks";
  await refreshData();
}

async function openProjectOutput(projectName: string) {
  await window.desktopApi.projects.openOutputDirectory(projectName);
}

async function removeProject(project: ProjectRecord) {
  const label = project.projectName || "未命名项目";
  if (!window.confirm(`删除项目“${label}”的工作台记录？\n\n会删除分镜、提示词和候选记录；不会删除输出目录及已下载文件，应用内部素材副本也不会自动清理。此操作不能撤销。`)) return;
  await act(async () => {
    await window.desktopApi.projects.remove(project.projectName);
    if (selectedProjectName.value === project.projectName) selectedProjectName.value = "";
    flash(`已删除“${label}”的工作台记录；磁盘文件仍保留`);
  });
}

async function importStoryboardTasks() {
  const parsed = importPreview.value.storyboard;
  if (!parsed) return;
  await act(async () => {
    let targetProjectName = parsed.projectName;
    if (projects.value.some((project) => project.projectName === targetProjectName)) {
      const continueExisting = window.confirm(`项目“${targetProjectName}”已存在。\n\n确定：继续导入到现有项目\n取消：创建一个新的副本项目`);
      if (!continueExisting) targetProjectName = uniqueProjectCopyName(targetProjectName);
    }
    const existing = projectStyleByName.value.get(targetProjectName);
    const inputs: TaskInput[] = parsed.shots.map((shot) => {
      const resolvedAsset = importAssetResolution.value?.shots.find((item) => item.shotNumber === shot.shotNumber)?.file;
      const inferredRatio = resolvedAsset ? inferAspectRatio(resolvedAsset.width, resolvedAsset.height) : shot.aspectRatio;
      const model = shot.modelExplicit ? shot.model : existing?.lockedModel || shot.model;
      const aspectRatio = shot.aspectRatioExplicit
        ? shot.aspectRatio
        : existing?.lockedAspectRatio || (resolvedAsset ? inferredRatio : shot.aspectRatio);
      return {
        projectName: targetProjectName,
        shotNumber: shot.shotNumber,
        shotName: shot.shotName,
        narration: shot.narration,
        notes: shot.notes,
        generationCount: shot.generationCount,
        firstFrameSource: shot.firstFrameSource,
        firstFrameFileName: shot.firstFrameImage || resolvedAsset?.name || null,
        sourceImagePath: resolvedAsset?.path || null,
        imagePrompt: shot.imagePrompt,
        imageAccountId: null,
        accountId: null,
        prompt: shot.videoPrompt,
        model,
        modelSource: shot.modelExplicit ? "shot" : existing?.lockedModel ? "project" : "default",
        duration: shot.duration,
        durationSource: shot.durationExplicit ? "shot" : "default",
        aspectRatio,
        aspectRatioSource: shot.aspectRatioExplicit ? "shot" : existing?.lockedAspectRatio ? "project" : resolvedAsset ? "first_frame" : "default"
      };
    });
    const incomingHasGlobals = Boolean(parsed.globalPrompt || parsed.imageGlobalPrompt || parsed.videoGlobalPrompt);
    const incomingReferencePaths = importCharacterReferenceResolution.value?.files.map((file) => file.path) ?? [];
    const useIncomingGlobals = incomingHasGlobals && (!existing || importGlobalChoice.value === "incoming");
    if (useIncomingGlobals || incomingReferencePaths.length || (!existing && importAssets.value.folderPath)) {
      await window.desktopApi.projects.saveStyle({
        projectName: targetProjectName,
        globalPrompt: useIncomingGlobals ? parsed.globalPrompt : existing?.globalPrompt ?? "",
        imageGlobalPrompt: useIncomingGlobals ? parsed.imageGlobalPrompt : existing?.imageGlobalPrompt ?? "",
        videoGlobalPrompt: useIncomingGlobals ? parsed.videoGlobalPrompt : existing?.videoGlobalPrompt ?? "",
        migrationPending: false,
        characterReferencePaths: incomingReferencePaths.length ? incomingReferencePaths : existing?.characterReferencePaths ?? [],
        characterReferenceNames: incomingReferencePaths.length
          ? importCharacterReferenceResolution.value?.files.map((file) => file.name) ?? []
          : existing?.characterReferenceNames ?? [],
        sceneReferencePath: existing?.sceneReferencePath ?? null,
        sceneReferenceName: existing?.sceneReferenceName ?? null,
        styleReferencePath: existing?.styleReferencePath ?? null,
        styleReferenceName: existing?.styleReferenceName ?? null,
        outputDirectory: existing?.outputDirectory ?? importAssets.value.folderPath ?? null,
        lockedModel: existing?.lockedModel ?? null,
        lockedAspectRatio: existing?.lockedAspectRatio ?? null
      });
    }
    await window.desktopApi.tasks.importMany(inputs);
    await window.desktopApi.projects.setStatus(targetProjectName, "active");
    selectedProjectName.value = targetProjectName;
    let assignmentMessage = "";
    try {
      const summary = await window.desktopApi.tasks.autoAssign();
      assignmentMessage = `，并分配 ${summary.imageAssignments} 个生图、${summary.videoAssignments} 个视频任务`;
    } catch {
      assignmentMessage = "；登录并确认账号后可使用自动分配";
    }
    showImportDialog.value = false;
    importText.value = "";
    importProjectName.value = "";
    importAssets.value = { cancelled: false, folderPath: null, files: [] };
    flash(`已创建并切换到项目“${targetProjectName}”，导入 ${inputs.length} 个分镜${assignmentMessage}`);
  });
}

function openProjectStyle(projectName: string) {
  if (!projectName) {
    flash("请先填写项目名称", true);
    return;
  }
  const existing = projectStyleByName.value.get(projectName);
  Object.assign(styleForm, existing ? {
    projectName: existing.projectName,
    globalPrompt: existing.globalPrompt,
    imageGlobalPrompt: existing.imageGlobalPrompt,
    videoGlobalPrompt: existing.videoGlobalPrompt,
    migrationPending: existing.migrationPending,
    characterReferencePaths: [...existing.characterReferencePaths],
    characterReferenceNames: [...existing.characterReferenceNames],
    sceneReferencePath: existing.sceneReferencePath,
    sceneReferenceName: existing.sceneReferenceName,
    styleReferencePath: existing.styleReferencePath,
    styleReferenceName: existing.styleReferenceName,
    outputDirectory: existing.outputDirectory,
    lockedModel: existing.lockedModel,
    lockedAspectRatio: existing.lockedAspectRatio
  } : {
    projectName,
    globalPrompt: "吉卜力风格宠物动画，保持角色外形、花纹、配饰、场景布局、光线方向和色彩统一。",
    imageGlobalPrompt: "",
    videoGlobalPrompt: "保持首帧造型与画风，动作自然连贯。禁止角色变形、花纹改变、多余肢体、文字和水印。",
    migrationPending: false,
    characterReferencePaths: [],
    characterReferenceNames: [],
    sceneReferencePath: null,
    sceneReferenceName: null,
    styleReferencePath: null,
    styleReferenceName: null,
    outputDirectory: null,
    lockedModel: null,
    lockedAspectRatio: null
  });
  applyStyleLocks.value = true;
  styleTargetName.value = projectName;
}

async function chooseProjectReference(kind: ProjectReferenceKind) {
  const selected = await window.desktopApi.projects.chooseReference(kind);
  if (!selected.length) return;
  if (kind === "character") {
    const pairs = new Map(styleForm.characterReferencePaths.map((item, index) => [item, styleForm.characterReferenceNames?.[index] || ""]));
    selected.forEach((item) => pairs.set(item, fileName(item)));
    styleForm.characterReferencePaths = [...pairs.keys()];
    styleForm.characterReferenceNames = [...pairs.values()];
  }
  if (kind === "scene") {
    styleForm.sceneReferencePath = selected[0] ?? null;
    styleForm.sceneReferenceName = selected[0] ? fileName(selected[0]) : null;
  }
  if (kind === "style") {
    styleForm.styleReferencePath = selected[0] ?? null;
    styleForm.styleReferenceName = selected[0] ? fileName(selected[0]) : null;
  }
}

function clearProjectReference(kind: ProjectReferenceKind, pathToRemove?: string) {
  if (kind === "character") {
    const kept = styleForm.characterReferencePaths
      .map((item, index) => ({ path: item, name: styleForm.characterReferenceNames?.[index] || "" }))
      .filter((item) => !pathToRemove || item.path !== pathToRemove);
    styleForm.characterReferencePaths = pathToRemove ? kept.map((item) => item.path) : [];
    styleForm.characterReferenceNames = pathToRemove ? kept.map((item) => item.name) : [];
  }
  if (kind === "scene") { styleForm.sceneReferencePath = null; styleForm.sceneReferenceName = null; }
  if (kind === "style") { styleForm.styleReferencePath = null; styleForm.styleReferenceName = null; }
}

async function chooseProjectOutputDirectory() {
  const selected = await window.desktopApi.projects.chooseOutputDirectory();
  if (selected) styleForm.outputDirectory = selected;
}

async function saveProjectStyle() {
  await act(async () => {
    await window.desktopApi.projects.saveStyle({ ...styleForm, migrationPending: false });
    let affected = 0;
    if (applyStyleLocks.value) affected = await window.desktopApi.projects.applyLocks(styleForm.projectName);
    styleTargetName.value = null;
    flash(`项目风格锁定已保存${applyStyleLocks.value ? `，已统一 ${affected} 个分镜的模型与画幅` : ""}`);
  });
}

async function chooseImportAssetFolder() {
  await act(async () => {
    const selected = await window.desktopApi.imports.chooseAssetFolder();
    if (!selected.cancelled) importAssets.value = selected;
  });
}

async function copyTaskPrompt(task: TaskRecord) {
  await act(async () => {
    await window.desktopApi.tasks.copyPrompt(task.id);
    flash("提示词已复制");
  });
}

async function duplicateTask(task: TaskRecord) {
  await act(async () => {
    const duplicated = await window.desktopApi.tasks.duplicate(task.id);
    flash(`已复制为分镜 ${duplicated.shotNumber}`);
  });
}

async function removeTask(task: TaskRecord) {
  if (!window.confirm(`删除“${task.projectName || "未命名项目"}”的分镜 ${task.shotNumber}？`)) return;
  await act(async () => {
    await window.desktopApi.tasks.remove(task.id);
    if (editingTaskId.value === task.id) cancelTaskEdit();
    flash("任务已删除");
  });
}

async function updateTask(task: TaskRecord, status: TaskStatus) {
  await act(async () => {
    await window.desktopApi.tasks.updateStatus(task.id, status);
    flash(status === "succeeded" ? "任务已标记完成" : "任务状态已更新");
  });
}

async function persistSettings(input: Partial<AppSettings>) {
  const revision = ++settingsSaveRevision;
  settingsSaveState.value = "saving";
  try {
    const saved = await window.desktopApi.settings.update(input);
    if (revision !== settingsSaveRevision) return;
    if (input.maxActiveWorkers !== undefined) settings.value.maxActiveWorkers = saved.maxActiveWorkers;
    if (input.autoClickGenerate !== undefined) settings.value.autoClickGenerate = saved.autoClickGenerate;
    settingsSaveState.value = "saved";
  } catch (error) {
    if (revision !== settingsSaveRevision) return;
    settingsSaveState.value = "error";
    await refreshData();
    flash(formatError(error), true);
  }
}

function adjustMaxActiveWindows(delta: number) {
  const next = Math.min(20, Math.max(1, settings.value.maxActiveWorkers + delta));
  if (next === settings.value.maxActiveWorkers) return;
  settings.value.maxActiveWorkers = next;
  void persistSettings({ maxActiveWorkers: next });
}

function toggleAutoClickGenerate() {
  const next = !settings.value.autoClickGenerate;
  settings.value.autoClickGenerate = next;
  void persistSettings({ autoClickGenerate: next });
}

async function chooseDataDirectory() {
  if (!window.confirm("更改数据目录会复制账号登录状态、数据库和设置，并自动重启应用。旧目录会暂时保留作为备份。继续吗？")) return;
  await act(async () => {
    const result = await window.desktopApi.runtime.chooseDataDirectory();
    flash(result.message);
  });
}

async function exportDiagnostics() {
  await act(async () => {
    const result = await window.desktopApi.runtime.exportDiagnostics();
    flash(result.message);
  });
}

async function openDataDirectory() {
  try {
    await window.desktopApi.runtime.openDataDirectory();
  } catch (error) {
    flash(formatError(error), true);
  }
}

async function openAbout() {
  activeTab.value = "settings";
  await nextTick();
  aboutCard.value?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function openRepository() {
  try {
    await window.desktopApi.runtime.openRepository();
  } catch (error) {
    flash(formatError(error), true);
  }
}

async function act(operation: () => Promise<void>) {
  try {
    await operation();
    await refreshData();
    await refreshRuntime();
  } catch (error) {
    await refreshData();
    await refreshRuntime();
    flash(formatError(error), true);
  }
}

function flash(message: string, error = false) {
  notice.value = message;
  noticeError.value = error;
  window.setTimeout(() => {
    if (notice.value === message) notice.value = "";
  }, 5000);
}

function formatError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function accountName(id: string | null) {
  return id ? accountById.value.get(id)?.label || "已删除账号" : "未指定";
}

function statusLabel(status: string) {
  return ({
    login_required: "待登录",
    ready: "可用",
    busy: "执行中",
    error: "异常",
    queued: "待提交",
    submitted: "已提交",
    running: "执行中",
    review: "待视频审核",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消"
  } as Record<string, string>)[status] || status;
}

function imageStatusLabel(status: ImageTaskStatus) {
  return ({
    pending: "待生图",
    preparing: "待提交",
    submitted: "已提交",
    ready: "待审核",
    approved: "已通过",
    failed: "失败",
    skipped: "无需生图"
  } as Record<ImageTaskStatus, string>)[status];
}

function accountUsage(accountId: string) {
  return usageByAccount.value.get(accountId) ?? { accountId, usageDate: "", imageCount: 0, videoCount: 0 };
}

function fileName(value: string | null) {
  return value ? value.split(/[\\/]/).at(-1) || value : "";
}

function localFileUrl(value: string | null) {
  return value ? encodeURI(`file:///${value.replace(/\\/g, "/")}`) : "";
}

function characterReferenceName(index: number) {
  return styleForm.characterReferenceNames?.[index] || "旧版参考图（请重新选择以恢复原文件名）";
}

function projectHasReferences(projectName: string) {
  const profile = projectStyleByName.value.get(projectName);
  return Boolean(profile?.characterReferencePaths.length || profile?.sceneReferencePath || profile?.styleReferencePath);
}

function projectStatusLabel(status: ProjectStatus) {
  return ({ active: "制作中", completed: "已完成", archived: "已归档" } as Record<ProjectStatus, string>)[status];
}

function projectProgress(project: ProjectRecord) {
  if (!project.shotCount) return "还没有分镜";
  return `首帧 ${project.imageCompletedCount}/${project.shotCount} · 视频 ${project.videoCompletedCount}/${project.shotCount}`;
}

function videoStageLocked(task: TaskRecord) {
  return task.firstFrameSource !== "none" && task.imageStatus !== "approved";
}

function canCancelImageRegeneration(task: TaskRecord) {
  return task.firstFrameSource === "generated" && Boolean(task.imagePath) && (
    task.imagePrepareState === "running" ||
    task.imagePrepareState === "failed" ||
    (task.imagePrepareState === "ready" && /(?:等待你在豆包点击生成|自动点击生成)/.test(task.imagePrepareStep)) ||
    task.imageStatus !== "approved"
  );
}

function hasGenerationRejection(task: TaskRecord, route: "image" | "video") {
  const message = route === "image" ? task.imagePrepareMessage : task.videoPrepareMessage;
  return Boolean(message && /豆包拒绝生成/.test(message));
}

function importReferenceFile(name: string) {
  return importCharacterReferenceResolution.value?.files.find((file) => file.name.toLowerCase() === fileName(name).toLowerCase()) ?? null;
}

function taskFinalPrompt(task: TaskRecord, stage: PromptStage) {
  const shotPrompt = stage === "image" ? task.imagePrompt : task.prompt;
  return composeDeliveryPrompt(stage, shotPrompt, projectStyleByName.value.get(task.projectName));
}

function importFinalPrompt(shot: ImportedShot, stage: PromptStage) {
  return composeDeliveryPrompt(stage, stage === "image" ? shot.imagePrompt : shot.videoPrompt, importPromptProfile.value);
}

function importReferenceMissing(name: string) {
  return Boolean(importCharacterReferenceResolution.value?.missing.some((item) => item === name || item.startsWith(`${name}（`)));
}

function promptLength(value: string) {
  return Array.from(value).length;
}

function promptBreakdown(stage: PromptStage, shotPrompt: string, profile?: ProjectStyleProfile | null) {
  return {
    global: promptLength(projectStagePrompt(stage, profile)),
    shot: promptLength(shotPrompt),
    hasException: /本镜例外\s*[:：]/.test(shotPrompt)
  };
}

function taskPromptBreakdown(task: TaskRecord, stage: PromptStage) {
  return promptBreakdown(stage, stage === "image" ? task.imagePrompt : task.prompt, projectStyleByName.value.get(task.projectName));
}

function importPromptBreakdown(shot: ImportedShot, stage: PromptStage) {
  return promptBreakdown(stage, stage === "image" ? shot.imagePrompt : shot.videoPrompt, importPromptProfile.value);
}

function preparationSteps(task: TaskRecord, stage: "image" | "video") {
  const submitStep = settings.value.autoClickGenerate ? "自动点击生成" : "等待你在豆包点击生成";
  if (stage === "image") {
    const steps = ["检查前置条件", "打开生图页", "进入图像生成", "设置图片比例"];
    if (projectStyleByName.value.get(task.projectName)?.characterReferencePaths.length) steps.push("上传参考图");
    return [...steps, "填写提示词", submitStep, "生图中", "下载分镜图候选"];
  }
  const steps = ["检查前置条件", "打开视频页", "进入视频生成", "设置模型、比例和时长"];
  if (task.firstFrameSource !== "none") steps.push("上传首帧", "等待首帧缩略图");
  return [...steps, "填写提示词", "回读并核对模型、比例和时长", submitStep, "视频生成中", "下载原视频"];
}

function preparationStepClass(task: TaskRecord, stage: "image" | "video", step: string) {
  const state = stage === "image" ? task.imagePrepareState : task.videoPrepareState;
  const current = stage === "image" ? task.imagePrepareStep : task.videoPrepareStep;
  const steps = preparationSteps(task, stage);
  const currentIndex = steps.indexOf(current);
  const index = steps.indexOf(step);
  return {
    current: step === current && state === "running",
    failed: step === current && state === "failed",
    done: state === "ready" || (currentIndex >= 0 && index < currentIndex)
  };
}

function taskGroupSummary(groupTasks: TaskRecord[]) {
  const fixedDuration = groupTasks.reduce((sum, task) => sum + (task.duration > 0 ? task.duration : 0), 0);
  const adaptive = groupTasks.some((task) => task.duration === -1);
  return `${groupTasks.length} 个分镜 · ${fixedDuration} 秒${adaptive ? " + 自动时长" : ""}`;
}

function accountStatusLabel(account: Account) {
  if (account.status === "login_required" && account.doubaoUserId) return "登录失效";
  return statusLabel(account.status);
}

function isAccountWindowOpen(accountId: string) {
  return runtime.value.activeAccountIds.includes(accountId);
}

function shortId(value: string | null) {
  if (!value) return "尚未确认 UID";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function handleModelChange() {
  if (!VIDEO_MODEL_OPTIONS.some((model) => model.value === taskForm.model)) {
    taskForm.model = DEFAULT_VIDEO_MODEL.value;
  }
  if (!availableDurations.value.includes(taskForm.duration)) taskForm.duration = 10;
  if (!availableAspectRatios.value.includes(taskForm.aspectRatio)) taskForm.aspectRatio = "9:16";
}

function parameterSourceLabel(source: TaskRecord["modelSource"]) {
  return ({ shot: "分镜设置", project: "项目锁定", first_frame: "跟随首帧", default: "默认值" })[source];
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-mark" :src="appIcon" alt="" />
        <div>
          <strong>Doubao Studio</strong>
          <span>本地账号工作台{{ runtime.version ? ` · v${runtime.version}` : '' }}</span>
        </div>
      </div>

      <nav>
        <button :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'"><span>⌂</span>概览</button>
        <button :class="{ active: activeTab === 'accounts' }" @click="activeTab = 'accounts'"><span>◎</span>账号</button>
        <button :class="{ active: activeTab === 'tasks' }" @click="activeTab = 'tasks'"><span>▤</span>任务</button>
        <button :class="{ active: activeTab === 'projects' }" @click="activeTab = 'projects'"><span>▦</span>项目库</button>
        <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'"><span>⚙</span>设置</button>
      </nav>

      <div class="runtime-card">
        <div><span class="live-dot"></span>本地运行</div>
        <strong>{{ runtime.totalPrivateMb }} MB</strong>
        <small>{{ runtime.activeAccountWindows }} 个账号窗口 · {{ runtime.processCount }} 个进程</small>
      </div>
      <button class="sidebar-credit" type="button" @click="openAbout">by jujuran · 免费开源</button>
    </aside>

    <main>
      <header class="topbar">
        <div>
          <p class="eyebrow">LOCAL FIRST · SESSION ISOLATION</p>
          <h1>{{ { overview: '工作台概览', accounts: '账号空间', tasks: '视频任务', projects: '项目库', settings: '运行设置' }[activeTab] }}</h1>
        </div>
        <button v-if="activeTab === 'overview' || activeTab === 'accounts'" class="primary" @click="openAddAccount">＋ 添加账号</button>
      </header>

      <div v-if="notice" class="toast" :class="{ error: noticeError }">{{ notice }}</div>
      <div v-if="loading" class="loading">正在读取本地工作区…</div>

      <template v-else-if="activeTab === 'overview'">
        <section class="metrics">
          <article><span>账号总数</span><strong>{{ accounts.length }}</strong><small>{{ readyAccounts.length }} 个已确认登录</small></article>
          <article><span>待处理任务</span><strong>{{ queuedTasks }}</strong><small>{{ activeTasks }} 个正在执行</small></article>
          <article><span>活动窗口</span><strong>{{ runtime.activeAccountWindows }}</strong><small>上限建议 {{ settings.maxActiveWorkers }} 个</small></article>
          <article><span>当前内存</span><strong>{{ runtime.totalPrivateMb }}</strong><small>MB · 全应用进程</small></article>
        </section>

        <section class="panel split-panel">
          <div>
            <p class="eyebrow">RESOURCE STRATEGY</p>
            <h2>账号休眠，窗口按需唤醒</h2>
            <p class="muted">所有登录态分别保存在持久化 Partition。关闭账号窗口不会退出登录，也不会让 10–20 个豆包页面长期占用内存。</p>
          </div>
          <div class="flow">
            <span>20 个登录态</span><b>→</b><span>本地任务队列</span><b>→</b><span>{{ settings.maxActiveWorkers }} 个 Worker</span>
          </div>
        </section>

        <section class="section-heading"><div><p class="eyebrow">RECENT ACCOUNTS</p><h2>最近账号</h2></div><button class="text-button" @click="activeTab = 'accounts'">查看全部 →</button></section>
        <section v-if="accounts.length" class="account-grid compact">
          <article v-for="account in accounts.slice(0, 4)" :key="account.id" class="account-card">
            <div class="account-head"><div class="avatar">{{ account.label.slice(0, 1) }}</div><span class="badge" :class="account.status">{{ accountStatusLabel(account) }}</span></div>
            <h3>{{ account.label }}</h3><p>{{ account.displayName || '尚未读取豆包昵称' }}</p><code>{{ shortId(account.doubaoUserId) }}</code>
          </article>
        </section>
        <section v-else class="empty"><strong>还没有账号</strong><span>添加第一个账号，系统会为它创建独立登录空间。</span><button class="primary" @click="openAddAccount">添加账号</button></section>
      </template>

      <template v-else-if="activeTab === 'accounts'">
        <section class="section-heading"><div><p class="eyebrow">PERSISTENT PARTITIONS</p><h2>{{ accounts.length }} 个隔离空间</h2></div><p class="muted">Cookie 不写入数据库，也不会在账号之间复制。</p></section>
        <section v-if="accounts.length" class="account-grid">
          <article v-for="account in accounts" :key="account.id" class="account-card detailed">
            <div class="account-head"><div class="avatar">{{ account.label.slice(0, 1) }}</div><span class="badge" :class="account.status">{{ accountStatusLabel(account) }}</span></div>
            <h3>{{ account.label }}</h3><p>{{ account.displayName || '打开窗口并登录后进行确认' }}</p><code>{{ shortId(account.doubaoUserId) }}</code>
            <small v-if="account.lastVerifiedAt">上次确认：{{ formatTime(account.lastVerifiedAt) }}</small>
            <small>今日记录：生图 {{ accountUsage(account.id).imageCount }} · 视频 {{ accountUsage(account.id).videoCount }}</small>
            <small v-if="isAccountWindowOpen(account.id)" class="window-open"><span class="live-dot"></span>窗口已打开</small>
            <div class="card-actions">
              <button class="primary small" @click="openAccount(account)">打开</button>
              <button @click="verifyAccount(account)">确认账号</button>
              <button @click="openRenameAccount(account)">改备注</button>
              <button @click="calibrateUsage(account)">校准用量</button>
              <button @click="clearAccountCache(account)">清缓存</button>
              <button class="danger" @click="removeAccount(account)">删除</button>
            </div>
          </article>
        </section>
        <section v-else class="empty"><strong>账号列表为空</strong><span>每个账号都会使用独立的持久化浏览器 Partition。</span><button class="primary" @click="openAddAccount">添加账号</button></section>
      </template>

      <template v-else-if="activeTab === 'tasks'">
        <section class="task-toolbar">
          <div class="project-switcher"><p class="eyebrow">CURRENT PROJECT</p><select v-model="selectedProjectName"><option value="">请选择项目</option><option v-for="project in projects.filter(item => item.status !== 'archived')" :key="project.projectName" :value="project.projectName">{{ project.projectName || '未命名项目' }} · {{ projectStatusLabel(project.status) }}</option></select></div>
          <div><button class="primary" @click="openNewProject">＋ 新建 / 导入项目</button><button @click="activeTab = 'projects'">项目库 / 历史记录</button><button v-if="currentProject" @click="changeProjectStatus(currentProject.projectName, 'archived')">完成并归档</button></div>
        </section>
        <section v-if="currentProject" class="task-toolbar secondary-toolbar">
          <div><strong>{{ currentProject.projectName || '未命名项目' }}</strong><span>{{ projectProgress(currentProject) }}</span></div>
          <div><button @click="showImportDialog = true">继续导入分镜</button><button @click="openNewTask">＋ 新增分镜</button><button class="primary" @click="autoAssignTasks">自动分配账号</button></div>
        </section>
        <section class="panel task-list">
            <div class="section-heading"><div><p class="eyebrow">LOCAL QUEUE</p><h2>分镜流水线</h2></div><span>{{ currentProjectTasks.length }} 条</span></div>
            <div v-if="currentProjectTasks.length" class="task-groups">
              <section v-for="group in taskGroups" :key="group.name" class="task-group">
                <div class="task-group-head">
                  <div><strong>{{ group.name }}</strong><span>{{ taskGroupSummary(group.tasks) }}</span></div>
                  <div class="project-actions">
                    <span v-if="projectStyleByName.get(group.projectName)?.characterReferencePaths.length" class="reference-project-warning">角色参考图将在生图时自动上传</span>
                    <span v-else-if="projectHasReferences(group.projectName)" class="reference-project-warning">场景 / 风格参考图仍需手动上传</span>
                    <button v-if="group.projectName" class="style-lock-button" :class="{ active: hasProjectStyle(projectStyleByName.get(group.projectName)) }" @click="openProjectStyle(group.projectName)">
                      {{ hasProjectStyle(projectStyleByName.get(group.projectName)) ? '已设全局约束' : '设置全局约束' }}
                    </button>
                    <button v-else class="style-lock-button" disabled>命名后可锁定风格</button>
                  </div>
                </div>
                <div class="task-items">
                  <article v-for="task in group.tasks" :key="task.id" class="task-item">
                    <div><strong>分镜 {{ task.shotNumber }}{{ task.shotName ? ` · ${task.shotName}` : '' }}</strong><small>{{ durationLabel(task.duration) }} · {{ aspectRatioLabel(task.aspectRatio) }}</small></div>
                    <div class="pipeline-row">
                      <div class="pipeline-step" :class="{ done: task.imageStatus === 'approved' || task.imageStatus === 'skipped' }">
                        <span class="badge" :class="task.imageStatus">{{ imageStatusLabel(task.imageStatus) }}</span>
                        <strong>首帧 · {{ task.firstFrameSource === 'local' ? '本地图片' : task.firstFrameSource === 'generated' ? '提示词生成' : '无' }}</strong><small>{{ task.firstFrameSource === 'generated' ? accountName(task.imageAccountId) : (task.firstFrameFileName || '纯文生视频') }}</small>
                      </div>
                      <b>→</b>
                      <div class="pipeline-step" :class="{ locked: task.firstFrameSource !== 'none' && task.imageStatus !== 'approved' }">
                        <span class="badge" :class="task.status">{{ statusLabel(task.status) }}</span>
                        <strong>分镜视频</strong><small>{{ accountName(task.accountId) }}</small>
                      </div>
                    </div>
                    <details v-if="task.imagePrompt" class="prompt-detail final-prompt-detail">
                      <summary>查看最终分镜图提示词 · {{ promptLength(taskFinalPrompt(task, 'image')) }} 字</summary>
                      <div class="prompt-breakdown"><span>全局 {{ taskPromptBreakdown(task, 'image').global }} 字</span><span>本镜 {{ taskPromptBreakdown(task, 'image').shot }} 字</span><b v-if="taskPromptBreakdown(task, 'image').hasException">本镜例外</b></div>
                      <pre>{{ taskFinalPrompt(task, 'image') }}</pre>
                    </details>
                    <details class="prompt-detail final-prompt-detail">
                      <summary>查看最终视频提示词 · {{ promptLength(taskFinalPrompt(task, 'video')) }} 字</summary>
                      <div class="prompt-breakdown"><span>全局 {{ taskPromptBreakdown(task, 'video').global }} 字</span><span>本镜 {{ taskPromptBreakdown(task, 'video').shot }} 字</span><b v-if="taskPromptBreakdown(task, 'video').hasException">本镜例外</b></div>
                      <pre>{{ taskFinalPrompt(task, 'video') }}</pre>
                    </details>
                    <details v-if="task.narration" class="prompt-detail narration-detail"><summary>口播 / 旁白（不参与提示词）</summary><p>{{ task.narration }}</p></details>
                    <details v-if="task.notes" class="prompt-detail"><summary>备注（不参与提示词）</summary><p>{{ task.notes }}</p></details>
                    <div class="parameter-sources">
                      <span>模型：{{ task.model }}（{{ parameterSourceLabel(task.modelSource) }}）</span>
                      <span>时长：{{ durationLabel(task.duration) }}（{{ parameterSourceLabel(task.durationSource) }}）</span>
                      <span>画幅：{{ aspectRatioLabel(task.aspectRatio) }}（{{ parameterSourceLabel(task.aspectRatioSource) }}）</span>
                      <span>期望候选：{{ task.generationCount }} 张（仅作计划，不会自动连跑）</span>
                      <span>实际轮次：生图 {{ task.imageGenerationCount }} · 视频 {{ task.videoGenerationCount }}</span>
                    </div>
                    <p v-if="task.imagePath" class="image-path" :title="task.imagePath">已关联：{{ task.firstFrameFileName || fileName(task.imagePath) }}</p>
                    <section v-if="task.imageCandidates.length" class="candidate-section">
                      <strong>分镜图候选</strong>
                      <div class="candidate-grid">
                        <article v-for="candidate in task.imageCandidates" :key="candidate.id" :class="candidate.reviewStatus">
                          <img :src="candidate.previewUrl" :alt="`候选图 ${candidate.candidateIndex}`" />
                          <small>第 {{ candidate.generationIndex }} 次 · 候选 {{ candidate.candidateIndex }}</small>
                          <button v-if="candidate.reviewStatus === 'pending'" class="primary small" @click="approveImageCandidate(candidate.id)">审核通过并锁定</button>
                          <span v-else>{{ candidate.reviewStatus === 'approved' ? '已锁定' : '未采用' }}</span>
                        </article>
                      </div>
                    </section>
                    <section v-if="task.videoCandidates.length" class="candidate-section video-candidates">
                      <strong>视频候选</strong>
                      <div class="candidate-grid">
                        <article v-for="candidate in task.videoCandidates" :key="candidate.id" :class="candidate.reviewStatus">
                          <video :src="candidate.previewUrl" controls preload="metadata"></video>
                          <small :title="candidate.filePath">{{ fileName(candidate.filePath) }}</small>
                          <small>第 {{ candidate.generationIndex }} 次<span v-if="candidate.hasWatermark"> · 下载地址标记有平台水印</span></small>
                          <div v-if="candidate.reviewStatus === 'pending'"><button class="primary small" @click="reviewVideoCandidate(candidate.id, true)">通过</button><button @click="reviewVideoCandidate(candidate.id, false)">不通过</button></div>
                          <span v-else>{{ candidate.reviewStatus === 'approved' ? '已通过' : '已移入作废' }}</span>
                          <button type="button" @click="openCandidateFolder(candidate.id)">打开文件夹</button>
                        </article>
                      </div>
                    </section>
                    <div v-if="task.imagePrepareState !== 'idle'" class="prepare-progress" :class="task.imagePrepareState">
                      <strong>生图准备 · {{ task.imagePrepareStep }}</strong>
                      <div><span v-for="step in preparationSteps(task, 'image')" :key="step" :class="preparationStepClass(task, 'image', step)">{{ step }}</span></div>
                      <p v-if="task.imagePrepareMessage">{{ task.imagePrepareMessage }}</p>
                    </div>
                    <div v-if="task.videoPrepareState !== 'idle'" class="prepare-progress" :class="task.videoPrepareState">
                      <strong>视频准备 · {{ task.videoPrepareStep }}</strong>
                      <div><span v-for="step in preparationSteps(task, 'video')" :key="step" :class="preparationStepClass(task, 'video', step)">{{ step }}</span></div>
                      <p v-if="task.videoPrepareMessage">{{ task.videoPrepareMessage }}</p>
                    </div>
                    <div v-if="task.errorMessage && task.videoPrepareState === 'idle'" class="task-error-card" role="alert">
                      <strong>视频准备失败</strong>
                      <span>{{ task.errorMessage }}</span>
                    </div>
                    <div class="task-meta"><span><template v-if="hasProjectStyle(projectStyleByName.get(task.projectName))">全局提示词已合成</template></span><span>{{ formatTime(task.createdAt) }}</span></div>
                    <div v-if="task.firstFrameSource !== 'none'" class="card-actions stage-actions">
                      <button v-if="task.firstFrameSource === 'generated'" class="primary small" @click="openImageTask(task)">打开生图页</button>
                      <button v-if="hasGenerationRejection(task, 'image')" class="primary small" @click="retryRejectedGeneration(task, 'image')">重试豆包拒绝</button>
                      <button v-if="task.firstFrameSource === 'generated' && (task.imageStatus === 'preparing' || task.imageStatus === 'failed' || task.imageStatus === 'pending')" @click="updateImageTask(task, 'submitted')">标记生图已提交</button>
                      <button v-if="task.firstFrameSource === 'generated' && task.imageStatus === 'submitted'" @click="updateImageTask(task, 'ready')">标记待审核</button>
                      <button v-if="task.firstFrameSource === 'local'" @click="chooseTaskImage(task)">选择本地首帧</button>
                      <button v-else @click="importImageCandidate(task)">导入分镜图候选</button>
                      <button v-if="canCancelImageRegeneration(task)" @click="cancelImageRegeneration(task)">取消重新生图</button>
                      <button v-if="task.firstFrameSource === 'generated' && task.imageStatus !== 'failed'" @click="updateImageTask(task, 'failed')">生图失败</button>
                    </div>
                    <div class="card-actions stage-actions">
                      <button class="primary small" :disabled="videoStageLocked(task)" @click="openTask(task)">打开视频页</button>
                      <button v-if="hasGenerationRejection(task, 'video')" class="primary small" :disabled="videoStageLocked(task)" @click="retryRejectedGeneration(task, 'video')">重试豆包拒绝</button>
                      <button :disabled="videoStageLocked(task)" @click="copyTaskPrompt(task)">复制视频提示词</button>
                      <button v-if="task.status === 'failed' || task.status === 'running'" :disabled="videoStageLocked(task)" @click="recheckVideoDownload(task)">重新检查并下载</button>
                      <button :disabled="videoStageLocked(task)" @click="importVideoCandidate(task)">导入视频候选</button>
                      <button @click="editTask(task)">编辑</button>
                      <button :disabled="videoStageLocked(task)" @click="duplicateTask(task)">复制为下一镜</button>
                      <button v-if="task.status === 'queued' || task.status === 'failed' || task.status === 'cancelled'" :disabled="videoStageLocked(task)" @click="updateTask(task, 'submitted')">标记视频已提交</button>
                      <button v-if="task.status === 'submitted'" :disabled="videoStageLocked(task)" @click="updateTask(task, 'running')">标记生成中</button>
                      <button v-if="task.status === 'submitted' || task.status === 'running'" :disabled="videoStageLocked(task)" @click="updateTask(task, 'succeeded')">标记完成</button>
                      <button v-if="task.status === 'submitted' || task.status === 'running'" :disabled="videoStageLocked(task)" @click="updateTask(task, 'failed')">标记失败</button>
                      <button class="danger" @click="removeTask(task)">删除</button>
                    </div>
                  </article>
                </div>
              </section>
            </div>
            <div v-else class="empty inline"><strong>还没有任务</strong><span>可以保存单个分镜，也可以一次导入整套分镜。</span></div>
        </section>
      </template>

      <template v-else-if="activeTab === 'projects'">
        <section class="task-toolbar">
          <div><p class="eyebrow">PROJECT LIBRARY</p><h2>项目与历史记录</h2><p class="muted">归档只会从当前工作台隐藏，不会删除分镜、提示词、候选或磁盘文件。</p></div>
          <div><button class="primary" @click="openNewProject">＋ 新建 / 导入项目</button></div>
        </section>
        <section v-if="projects.length" class="project-library-grid">
          <article v-for="project in projects" :key="project.projectName" class="panel project-library-card">
            <div class="project-library-head"><div><span class="badge" :class="project.status">{{ projectStatusLabel(project.status) }}</span><h3>{{ project.projectName || '未命名项目' }}</h3></div><small>{{ formatTime(project.updatedAt) }}</small></div>
            <div class="project-stats"><span><b>{{ project.shotCount }}</b> 个分镜</span><span><b>{{ project.totalDuration }}</b> 秒</span><span>{{ projectProgress(project) }}</span></div>
            <code class="path single-line" :title="project.outputDirectory">{{ project.outputDirectory }}</code>
            <div class="card-actions">
              <button class="primary small" @click="continueProject(project)">{{ project.status === 'archived' ? '恢复并继续' : '继续制作' }}</button>
              <button @click="openProjectOutput(project.projectName)">打开输出文件夹</button>
              <button v-if="project.status === 'active'" @click="changeProjectStatus(project.projectName, 'completed')">标记完成</button>
              <button v-if="project.status !== 'archived'" @click="changeProjectStatus(project.projectName, 'archived')">归档</button>
              <button v-else @click="changeProjectStatus(project.projectName, 'active')">恢复</button>
              <button class="danger" @click="removeProject(project)">删除项目</button>
            </div>
          </article>
        </section>
        <section v-else class="empty"><strong>还没有项目</strong><span>导入一套分镜后，它会保存在项目库中。</span><button class="primary" @click="openNewProject">新建 / 导入项目</button></section>
      </template>

      <template v-else>
        <section class="settings-page">
          <div class="settings-grid">
            <article class="panel setting-card settings-main-card">
              <h2>生成</h2>
              <div class="setting-control-row">
                <div>
                  <h3>同时打开的豆包窗口</h3>
                  <p class="muted">推荐 3 个，可设置 1–20 个（最大 20 个）。数量越多，能同时生成的分镜越多，但越占内存。账号数量不受这里限制。</p>
                </div>
                <div class="stepper compact-stepper" aria-label="同时打开的豆包窗口数量">
                  <button :disabled="settings.maxActiveWorkers <= 1" @click="adjustMaxActiveWindows(-1)">−</button>
                  <strong>{{ settings.maxActiveWorkers }}</strong>
                  <button :disabled="settings.maxActiveWorkers >= 20" @click="adjustMaxActiveWindows(1)">＋</button>
                </div>
              </div>
              <div class="setting-divider"></div>
              <div class="setting-control-row">
                <div>
                  <h3>准备完成后自动点击生成</h3>
                  <p class="muted">提示词、模型、比例、时长、首帧全部核对一致才点击，不一致就停下并报错。</p>
                </div>
                <button class="switch" :class="{ on: settings.autoClickGenerate }" type="button" role="switch" :aria-checked="settings.autoClickGenerate" @click="toggleAutoClickGenerate">
                  <span></span>
                </button>
              </div>
              <p class="auto-save-note" :class="settingsSaveState">{{ settingsSaveLabel }}</p>
            </article>

            <article class="panel setting-card settings-main-card data-diagnostics-card">
              <h2>数据与诊断</h2>
              <div class="path-setting-row">
                <div><h3>数据目录</h3><p class="muted">账号会话、数据库和缓存仅保存在本机。</p></div>
                <code class="path single-line" :title="runtime.dataPath">{{ runtime.dataPath }}</code>
              </div>
              <p v-if="runtime.dataPathNotice" class="migration-warning">{{ runtime.dataPathNotice }}</p>
              <div class="setting-divider"></div>
              <div class="path-setting-row">
                <div><h3>诊断日志</h3><p class="muted">只记录程序事件和错误，不记录 Cookie、密码或验证码。</p></div>
                <code class="path single-line" :title="runtime.logPath">{{ runtime.logPath }}</code>
              </div>
              <div class="settings-actions">
                <button @click="chooseDataDirectory">更改目录</button>
                <button @click="openDataDirectory">打开文件夹</button>
                <button @click="exportDiagnostics">导出诊断信息</button>
              </div>
            </article>
          </div>

          <article ref="aboutCard" class="panel setting-card about-card">
            <div>
              <h2>关于 Doubao Desktop Studio</h2>
              <dl class="about-details">
                <div><dt>版本</dt><dd>v{{ runtime.version }}</dd></div>
                <div><dt>作者</dt><dd>jujuran</dd></div>
                <div><dt>许可证</dt><dd>MIT License</dd></div>
              </dl>
              <button class="repository-link" type="button" @click="openRepository">GitHub：jujuran/doubao-desktop-studio ↗</button>
            </div>
            <div class="free-warning">
              <strong>本软件免费开源</strong>
              <p>本软件在 GitHub 免费提供，无需付费购买。如果你是花钱买到的，可以到 GitHub 免费下载最新版。</p>
            </div>
          </article>
        </section>
      </template>
    </main>

    <div v-if="showAccountDialog" class="modal-backdrop" @click.self="showAccountDialog = false">
      <form class="modal" @submit.prevent="createAccount"><p class="eyebrow">NEW ISOLATED SESSION</p><h2>添加豆包账号</h2><p class="muted">名称只是本地备注，不会修改豆包昵称。</p><label>本地备注<input v-model="newAccountLabel" autofocus required /></label><div class="modal-actions"><button type="button" @click="showAccountDialog = false">取消</button><button class="primary" type="submit">创建并打开登录</button></div></form>
    </div>
    <div v-if="renameAccountTarget" class="modal-backdrop" @click.self="renameAccountTarget = null">
      <form class="modal" @submit.prevent="renameAccount"><p class="eyebrow">LOCAL LABEL</p><h2>修改账号备注</h2><p class="muted">只修改工作台里的本地备注，不会修改豆包昵称。</p><label>本地备注<input v-model="renameAccountLabel" autofocus maxlength="60" required /></label><div class="modal-actions"><button type="button" @click="renameAccountTarget = null">取消</button><button class="primary" type="submit">保存备注</button></div></form>
    </div>
    <div v-if="showTaskDialog" class="modal-backdrop" @click.self="cancelTaskEdit">
      <form class="modal task-modal task-form" @submit.prevent="saveTask">
        <p class="eyebrow">{{ editingTaskId ? 'EDIT SHOT' : 'NEW SHOT' }}</p><h2>{{ editingTaskId ? '编辑分镜' : '新增分镜' }}</h2>
        <div class="project-row">
          <label>项目 / 视频名称<input v-model="taskForm.projectName" maxlength="80" placeholder="例如：宠物冒险短片" /></label>
          <label>分镜编号<input v-model.number="taskForm.shotNumber" type="number" min="1" step="1" required /></label>
        </div>
        <label>镜头名（选填）<input v-model="taskForm.shotName" maxlength="80" placeholder="例如：小狗回头" /></label>
        <button class="inline-style-button" type="button" @click="openProjectStyle(taskForm.projectName)">设置项目全局约束</button>
        <p v-if="!taskForm.projectName.trim()" class="form-warning">请先填写项目名称</p>

        <div class="stage-block image-stage">
          <div class="stage-title"><span>1</span><strong>首帧（可选）</strong><small>系统根据填写内容自动判断来源</small></div>
          <div class="source-input-grid">
            <div class="source-picker">
              <strong>首帧图（上传本地图）</strong>
              <span>{{ taskLocalImageName || '未选择；留空也可以' }}</span>
              <div><button type="button" @click="chooseTaskSourceImage">选择图片</button><button v-if="taskLocalImagePath" type="button" @click="clearTaskSourceImage">清除</button></div>
            </div>
            <div>
              <label>分镜图提示词（让豆包生成）<textarea v-model="taskForm.imagePrompt" rows="4" placeholder="描述主体、场景、构图、光线和画面风格…"></textarea></label>
              <label v-if="taskForm.imagePrompt.trim()">生图账号<select v-model="taskForm.imageAccountId"><option value="">稍后自动分配</option><option v-for="account in readyAccounts" :key="account.id" :value="account.id">{{ account.label }}</option></select></label>
            </div>
          </div>
          <p v-if="taskLocalImagePath && taskForm.imagePrompt.trim()" class="form-error">首帧图和分镜图提示词只能保留一个。</p>
          <p v-else class="form-note">有本地图 = 本地首帧；有提示词 = 豆包生成首帧；两项都空 = 纯文生视频。</p>
        </div>

        <div class="stage-block video-stage">
          <div class="stage-title"><span>2</span><strong>分镜视频</strong><small>最终生成按钮仍由你手动点击</small></div>
          <label>视频账号<select v-model="taskForm.accountId"><option value="">稍后自动分配</option><option v-for="account in readyAccounts" :key="account.id" :value="account.id">{{ account.label }}</option></select></label>
          <label>分镜视频提示词<textarea v-model="taskForm.prompt" rows="5" placeholder="描述镜头运动、主体动作、节奏、声音和禁止项…" required></textarea></label>
          <label>口播 / 旁白（选填，不参与提示词）<textarea v-model="taskForm.narration" rows="2" placeholder="后续可用于字幕或配音稿"></textarea></label>
          <label>备注（选填，不参与提示词）<textarea v-model="taskForm.notes" rows="2"></textarea></label>
          <label>期望候选数量（仅作计划，不会自动连跑）<input v-model.number="taskForm.generationCount" type="number" min="1" max="20" step="1" /></label>
        </div>

        <div class="form-row">
          <label class="model-field">模型<select v-model="taskForm.model" @change="markModelChange"><option v-for="model in VIDEO_MODEL_OPTIONS" :key="model.value" :value="model.value">{{ model.label }}</option></select></label>
          <label>时长<select v-model.number="taskForm.duration" @change="taskParameterTouched.duration = true"><option v-for="duration in availableDurations" :key="duration" :value="duration">{{ durationLabel(duration) }}</option></select></label>
          <label>画幅<select v-model="taskForm.aspectRatio" @change="markAspectChange"><option v-for="aspectRatio in availableAspectRatios" :key="aspectRatio" :value="aspectRatio">{{ aspectRatioLabel(aspectRatio) }}</option></select></label>
        </div>
        <p class="spec-note">{{ selectedVideoModel.label }} · {{ selectedVideoModel.durationMin }}–{{ selectedVideoModel.durationMax }} 秒 · 支持自动画幅</p>
        <div class="modal-actions"><button type="button" @click="cancelTaskEdit">取消</button><button class="primary" type="submit" :disabled="Boolean(taskLocalImagePath && taskForm.imagePrompt.trim())">{{ editingTaskId ? '保存修改' : '保存分镜' }}</button></div>
      </form>
    </div>
    <div v-if="showImportDialog" class="modal-backdrop" @click.self="showImportDialog = false">
      <form class="modal import-modal" @submit.prevent="importStoryboardTasks">
        <p class="eyebrow">BATCH STORYBOARD</p><h2>批量导入整套分镜</h2>
        <p class="muted">支持协议 v1 的 JSON 或 Markdown。每个分镜可指定首帧来源；角色参考图和本地首帧均可写素材文件夹内的文件名。</p>
        <label>项目名称（原文中有项目名称时可留空）<input v-model="importProjectName" placeholder="例如：柯基水草球短片" /></label>
        <label>分镜内容<textarea v-model="importText" rows="12" placeholder="项目名称：柯基短片&#10;全局提示词：吉卜力风格…&#10;### 分镜 1&#10;首帧来源：本地图片&#10;首帧图：01.png&#10;视频提示词：……&#10;时长：10秒&#10;画幅：9:16"></textarea></label>
        <div v-if="importPreview.storyboard" class="import-result success">格式 v{{ importPreview.storyboard.formatVersion }} · 识别到 {{ importPreview.storyboard.shots.length }} 个分镜 · 项目：{{ importPreview.storyboard.projectName }}</div>
        <div v-if="importPreview.storyboard" class="parameter-sources import-defaults"><span>默认模型：{{ importPreview.storyboard.defaultModel }}</span><span>默认时长：{{ durationLabel(importPreview.storyboard.defaultDuration) }}</span><span>默认画幅：{{ aspectRatioLabel(importPreview.storyboard.defaultAspectRatio) }}</span></div>
        <div v-else-if="importPreview.error" class="import-result error">{{ importPreview.error }}</div>
        <div v-if="importPreview.storyboard?.warnings.length" class="import-warning-list">
          <strong>发现 {{ importPreview.storyboard.warnings.length }} 个疑似字段（原文已保留）</strong>
          <span v-for="warning in importPreview.storyboard.warnings" :key="`${warning.lineNumber}-${warning.label}`">{{ warning.message }}</span>
        </div>
        <template v-if="importPreview.storyboard && (importPreview.storyboard.shots.some(shot => shot.firstFrameSource === 'local') || importPreview.storyboard.characterReferenceImages.length)">
          <div class="asset-folder-row"><div><strong>项目图片素材</strong><span>{{ importAssets.folderPath || '尚未选择文件夹；绝对路径可直接识别' }}</span></div><button type="button" @click="chooseImportAssetFolder">选择素材文件夹</button></div>
          <div v-if="importPreview.storyboard.characterReferenceImages.length" class="asset-preview-list reference-assets">
            <article v-for="name in importPreview.storyboard.characterReferenceImages" :key="name" :class="{ invalid: importReferenceMissing(name) }">
              <img v-if="importReferenceFile(name)?.thumbnailUrl" :src="importReferenceFile(name)?.thumbnailUrl" alt="" />
              <div><strong>角色参考图</strong><span>{{ name }}</span><small v-if="importReferenceMissing(name)">未找到：{{ name }}（不阻止导入）</small><small v-else>已找到并将写入项目全局约束</small></div>
            </article>
          </div>
          <div v-if="importAssetResolution" class="asset-preview-list">
            <article v-for="item in importAssetResolution.shots.filter(item => importPreview.storyboard?.shots.find(shot => shot.shotNumber === item.shotNumber)?.firstFrameSource === 'local')" :key="item.shotNumber" :class="{ invalid: item.error }">
              <img v-if="item.file?.thumbnailUrl" :src="item.file.thumbnailUrl" alt="" />
              <div><strong>分镜 {{ item.shotNumber }}</strong><span>{{ item.file?.name || item.error }}</span><small v-if="item.warning">{{ item.warning }}</small></div>
            </article>
          </div>
          <p v-if="importUnusedFiles.length" class="import-warning">文件夹中还有 {{ importUnusedFiles.length }} 张未匹配图片，不会导入。</p>
        </template>
        <div v-if="importGlobalConflict" class="global-conflict">
          <strong>导入稿的全局提示词与项目现有设置不同</strong>
          <label><input v-model="importGlobalChoice" type="radio" value="incoming" />使用导入稿</label>
          <label><input v-model="importGlobalChoice" type="radio" value="existing" />保留现有设置</label>
        </div>
        <section v-if="importPreview.storyboard" class="import-prompt-preview-list">
          <strong>导入前确认最终提示词</strong>
          <article v-for="shot in importPreview.storyboard.shots" :key="shot.shotNumber">
            <h4>分镜 {{ shot.shotNumber }}{{ shot.shotName ? ` · ${shot.shotName}` : '' }}</h4>
            <p v-for="warning in importPreview.storyboard.warnings.filter(item => item.shotNumber === shot.shotNumber)" :key="warning.lineNumber" class="import-warning">{{ warning.message }}</p>
            <details v-if="shot.imagePrompt" class="prompt-preview">
              <summary>最终分镜图提示词 · {{ promptLength(importFinalPrompt(shot, 'image')) }} 字</summary>
              <div class="prompt-breakdown"><span>全局 {{ importPromptBreakdown(shot, 'image').global }} 字</span><span>本镜 {{ importPromptBreakdown(shot, 'image').shot }} 字</span><b v-if="importPromptBreakdown(shot, 'image').hasException">本镜例外</b></div>
              <pre>{{ importFinalPrompt(shot, 'image') }}</pre>
            </details>
            <details class="prompt-preview">
              <summary>最终视频提示词 · {{ promptLength(importFinalPrompt(shot, 'video')) }} 字</summary>
              <div class="prompt-breakdown"><span>全局 {{ importPromptBreakdown(shot, 'video').global }} 字</span><span>本镜 {{ importPromptBreakdown(shot, 'video').shot }} 字</span><b v-if="importPromptBreakdown(shot, 'video').hasException">本镜例外</b></div>
              <pre>{{ importFinalPrompt(shot, 'video') }}</pre>
            </details>
          </article>
        </section>
        <div class="modal-actions"><button type="button" @click="showImportDialog = false">取消</button><button class="primary" type="submit" :disabled="!canImportStoryboard">导入并自动分配</button></div>
      </form>
    </div>
    <div v-if="styleTargetName" class="modal-backdrop" @click.self="styleTargetName = null">
      <form class="modal style-modal" @submit.prevent="saveProjectStyle">
        <p class="eyebrow">PROJECT GLOBAL PROMPTS</p><h2>{{ styleForm.projectName }} · 全局约束</h2>
        <p class="muted">共用全局提示词用于两个阶段；填写阶段专用提示词后，会在该阶段替代共用版。最终提示词按“全局在前、分镜在后”拼接。</p>
        <p v-if="styleForm.migrationPending" class="migration-banner">已将旧版五项风格锁定迁移为草稿。请检查下方内容，保存后才会正式生效。</p>

        <div class="reference-grid">
          <article>
            <strong>角色 / 宠物定妆图（可多选）</strong><span>{{ styleForm.characterReferencePaths.length ? `${styleForm.characterReferencePaths.length} 张` : '未选择' }}</span>
            <ul v-if="styleForm.characterReferencePaths.length" class="reference-file-list"><li v-for="(referencePath, index) in styleForm.characterReferencePaths" :key="referencePath"><img class="reference-thumb" :src="localFileUrl(referencePath)" alt="" /><span :title="referencePath">{{ characterReferenceName(index) }}</span><button type="button" @click="clearProjectReference('character', referencePath)">×</button></li></ul>
            <div><button type="button" @click="chooseProjectReference('character')">添加图片</button><button v-if="styleForm.characterReferencePaths.length" type="button" @click="clearProjectReference('character')">全部清除</button></div>
          </article>
          <article>
            <strong>场景参考图</strong><img v-if="styleForm.sceneReferencePath" class="reference-thumb large" :src="localFileUrl(styleForm.sceneReferencePath)" alt="" /><span>{{ styleForm.sceneReferenceName || (styleForm.sceneReferencePath ? '旧版参考图（请重新选择以恢复原文件名）' : '未选择') }}</span>
            <div><button type="button" @click="chooseProjectReference('scene')">选择</button><button v-if="styleForm.sceneReferencePath" type="button" @click="clearProjectReference('scene')">清除</button></div>
          </article>
          <article>
            <strong>风格参考图</strong><img v-if="styleForm.styleReferencePath" class="reference-thumb large" :src="localFileUrl(styleForm.styleReferencePath)" alt="" /><span>{{ styleForm.styleReferenceName || (styleForm.styleReferencePath ? '旧版参考图（请重新选择以恢复原文件名）' : '未选择') }}</span>
            <div><button type="button" @click="chooseProjectReference('style')">选择</button><button v-if="styleForm.styleReferencePath" type="button" @click="clearProjectReference('style')">清除</button></div>
          </article>
        </div>
        <p v-if="styleForm.characterReferencePaths.length || styleForm.sceneReferencePath || styleForm.styleReferencePath" class="reference-upload-warning">角色参考图会在生图时按顺序自动上传，全部成功后才写入“参考素材约束”；视频阶段暂不额外上传项目参考图。场景和风格参考图仍需手动上传。</p>

        <article class="project-output-card">
          <strong>项目输出目录</strong>
          <code class="path">{{ styleForm.outputDirectory || '使用应用数据目录（旧项目保持原位置）' }}</code>
          <button type="button" @click="chooseProjectOutputDirectory">更改输出目录</button>
        </article>

        <div class="style-fields">
          <label>共用全局提示词<textarea v-model="styleForm.globalPrompt" rows="4" placeholder="例如：吉卜力风格宠物动画；统一角色造型、花纹、场景、光线和色彩…"></textarea></label>
          <label>全局分镜图提示词（选填）<textarea v-model="styleForm.imageGlobalPrompt" rows="4" placeholder="填写后替代生图阶段的共用全局提示词"></textarea></label>
          <label>全局视频提示词（选填）<textarea v-model="styleForm.videoGlobalPrompt" rows="4" placeholder="填写后替代视频阶段的共用全局提示词"></textarea></label>
        </div>

        <div class="lock-row">
          <label>锁定视频模型<select v-model="styleForm.lockedModel"><option :value="null">不锁定</option><option v-for="model in VIDEO_MODEL_OPTIONS" :key="model.value" :value="model.value">{{ model.label }}</option></select></label>
          <label>锁定画幅<select v-model="styleForm.lockedAspectRatio"><option :value="null">不锁定</option><option v-for="ratio in ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']" :key="ratio" :value="ratio">{{ aspectRatioLabel(ratio) }}</option></select></label>
        </div>
        <label class="checkbox-row"><input v-model="applyStyleLocks" type="checkbox" />立即把锁定的模型和画幅应用到本项目现有分镜</label>

        <details class="prompt-preview"><summary>查看合成后的分镜图提示词</summary><pre>{{ styleImagePreview }}</pre></details>
        <details class="prompt-preview"><summary>查看合成后的分镜视频提示词</summary><pre>{{ styleVideoPreview }}</pre></details>

        <div class="modal-actions"><button type="button" @click="styleTargetName = null">取消</button><button class="primary" type="submit">保存并启用全局约束</button></div>
      </form>
    </div>
  </div>
</template>
