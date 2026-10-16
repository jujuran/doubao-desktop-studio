<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type {
  Account,
  AccountUsage,
  AssetFolderSelection,
  AppSettings,
  FirstFrameSource,
  ImageTaskStatus,
  ProjectReferenceKind,
  ProjectStyleInput,
  ProjectStyleProfile,
  RuntimeStats,
  TaskInput,
  TaskRecord,
  TaskStatus
} from "../electron/contracts";
import appIcon from "./assets/app-icon.png";
import { parseStoryboard } from "./storyboard-import";
import { resolveStoryboardAssets } from "./storyboard-assets";
import { composeProjectPrompt, hasProjectStyle } from "./prompt-compose";
import {
  aspectRatioLabel,
  DEFAULT_VIDEO_MODEL,
  durationLabel,
  durationOptions,
  VIDEO_MODEL_OPTIONS
} from "./video-options";

type Tab = "overview" | "accounts" | "tasks" | "settings";

const activeTab = ref<Tab>("overview");
const accounts = ref<Account[]>([]);
const tasks = ref<TaskRecord[]>([]);
const usage = ref<AccountUsage[]>([]);
const projectStyles = ref<ProjectStyleProfile[]>([]);
const settings = ref<AppSettings>({
  maxActiveWorkers: 2,
  automationEnabled: false,
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
const newAccountLabel = ref("");
const showAccountDialog = ref(false);
const renameAccountTarget = ref<Account | null>(null);
const renameAccountLabel = ref("");
const editingTaskId = ref<string | null>(null);
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
  characterReferencePath: null,
  sceneReferencePath: null,
  styleReferencePath: null,
  lockedModel: null,
  lockedAspectRatio: null
});
const taskForm = reactive({
  projectName: "",
  shotNumber: 1,
  firstFrameSource: "none" as FirstFrameSource,
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
const accountById = computed(() => new Map(accounts.value.map((account) => [account.id, account])));
const usageByAccount = computed(() => new Map(usage.value.map((item) => [item.accountId, item])));
const projectStyleByName = computed(() => new Map(projectStyles.value.map((profile) => [profile.projectName, profile])));
const stylePreviewProfile = computed<ProjectStyleProfile>(() => ({ ...styleForm, updatedAt: "" }));
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
const importGlobalConflict = computed(() => {
  const storyboard = importPreview.value.storyboard;
  if (!storyboard) return false;
  const existing = projectStyleByName.value.get(storyboard.projectName);
  if (!existing) return false;
  const incoming = [storyboard.globalPrompt, storyboard.imageGlobalPrompt, storyboard.videoGlobalPrompt].join("\n").trim();
  const saved = [existing.globalPrompt, existing.imageGlobalPrompt, existing.videoGlobalPrompt].join("\n").trim();
  return Boolean(incoming && incoming !== saved);
});
const canImportStoryboard = computed(() => Boolean(importPreview.value.storyboard && !importAssetResolution.value?.hasErrors));
const selectedVideoModel = computed(
  () => VIDEO_MODEL_OPTIONS.find((model) => model.value === taskForm.model) ?? DEFAULT_VIDEO_MODEL
);
const availableDurations = computed(() => durationOptions(selectedVideoModel.value));
const availableAspectRatios = computed(() => selectedVideoModel.value.aspectRatios);
const taskGroups = computed(() => {
  const groups = new Map<string, TaskRecord[]>();
  for (const task of tasks.value) {
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

let removeChangeListener: (() => void) | undefined;
let statsTimer: number | undefined;
let taskDefaultsLoaded = false;

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
  const [nextAccounts, nextTasks, nextSettings, nextUsage, nextProjectStyles] = await Promise.all([
    window.desktopApi.accounts.list(),
    window.desktopApi.tasks.list(),
    window.desktopApi.settings.get(),
    window.desktopApi.usage.listToday(),
    window.desktopApi.projects.listStyles()
  ]);
  accounts.value = nextAccounts;
  tasks.value = nextTasks;
  settings.value = nextSettings;
  usage.value = nextUsage;
  projectStyles.value = nextProjectStyles;
  if (!taskDefaultsLoaded) {
    const savedAccount = readyAccounts.value.find((account) => account.id === nextSettings.lastTaskAccountId);
    taskForm.accountId = savedAccount?.id ?? readyAccounts.value[0]?.id ?? "";
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
  await act(async () => {
    const input: TaskInput = {
      projectName: taskForm.projectName,
      shotNumber: Number(taskForm.shotNumber),
      firstFrameSource: taskForm.firstFrameSource,
      firstFrameFileName: editingTaskId.value && taskForm.firstFrameSource !== "none"
        ? tasks.value.find((task) => task.id === editingTaskId.value)?.firstFrameFileName ?? null
        : null,
      imagePrompt: taskForm.imagePrompt,
      imageAccountId: taskForm.imageAccountId || null,
      accountId: taskForm.accountId || null,
      prompt: taskForm.prompt,
      model: taskForm.model,
      duration: Number(taskForm.duration),
      aspectRatio: taskForm.aspectRatio
    };
    if (editingTaskId.value) await window.desktopApi.tasks.update(editingTaskId.value, input);
    else await window.desktopApi.tasks.create(input);
    settings.value = await window.desktopApi.settings.update({
      lastTaskAccountId: input.accountId,
      lastVideoModel: input.model,
      lastVideoDuration: input.duration,
      lastAspectRatio: input.aspectRatio
    });
    const wasEditing = Boolean(editingTaskId.value);
    editingTaskId.value = null;
    taskForm.imagePrompt = "";
    taskForm.prompt = "";
    if (!wasEditing) taskForm.shotNumber += 1;
    flash(wasEditing ? "任务修改已保存" : "任务已保存，可继续填写下一分镜");
  });
}

function editTask(task: TaskRecord) {
  editingTaskId.value = task.id;
  taskForm.projectName = task.projectName;
  taskForm.shotNumber = task.shotNumber;
  taskForm.firstFrameSource = task.firstFrameSource;
  taskForm.imagePrompt = task.imagePrompt;
  taskForm.imageAccountId = task.imageAccountId ?? "";
  taskForm.accountId = task.accountId ?? "";
  taskForm.prompt = task.prompt;
  taskForm.model = task.model;
  taskForm.duration = task.duration;
  taskForm.aspectRatio = task.aspectRatio;
  handleModelChange();
  document.querySelector(".task-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelTaskEdit() {
  editingTaskId.value = null;
  taskForm.imagePrompt = "";
  taskForm.firstFrameSource = "none";
  taskForm.prompt = "";
  taskForm.projectName = "";
  taskForm.shotNumber = 1;
  restoreTaskDefaults();
}

function restoreTaskDefaults() {
  const savedAccount = readyAccounts.value.find((account) => account.id === settings.value.lastTaskAccountId);
  taskForm.imageAccountId = "";
  taskForm.accountId = savedAccount?.id ?? readyAccounts.value[0]?.id ?? "";
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
    const referenceNote = projectHasReferences(task.projectName) ? "；项目参考图目前仍需手动上传" : "";
    flash(`已打开豆包视频页并自动填入合成提示词${frameNote}${referenceNote}，确认参数后提交`);
  });
}

async function openImageTask(task: TaskRecord) {
  await act(async () => {
    await window.desktopApi.tasks.openImage(task.id);
    const referenceNote = projectHasReferences(task.projectName) ? "；请手动上传项目参考图" : "";
    flash(`已打开豆包生图页并自动填入合成提示词${referenceNote}，确认后提交`);
  });
}

async function chooseTaskImage(task: TaskRecord) {
  await act(async () => {
    const updated = await window.desktopApi.tasks.chooseImage(task.id);
    if (updated) flash("已关联分镜图并通过审核");
  });
}

async function updateImageTask(task: TaskRecord, status: ImageTaskStatus) {
  await act(async () => {
    await window.desktopApi.tasks.updateImageStatus(task.id, status);
    flash(status === "approved" ? "分镜图已通过审核，可以进入视频阶段" : "分镜图状态已更新");
  });
}

async function autoAssignTasks() {
  await act(async () => {
    const summary = await window.desktopApi.tasks.autoAssign();
    flash(`已分配 ${summary.imageAssignments} 个生图任务、${summary.videoAssignments} 个视频任务`);
  });
}

async function importStoryboardTasks() {
  const parsed = importPreview.value.storyboard;
  if (!parsed) return;
  await act(async () => {
    const inputs: TaskInput[] = parsed.shots.map((shot) => ({
      projectName: parsed.projectName,
      shotNumber: shot.shotNumber,
      firstFrameSource: shot.firstFrameSource,
      firstFrameFileName: shot.firstFrameImage || importAssetResolution.value?.shots.find((item) => item.shotNumber === shot.shotNumber)?.file?.name || null,
      sourceImagePath: importAssetResolution.value?.shots.find((item) => item.shotNumber === shot.shotNumber)?.file?.path || null,
      imagePrompt: shot.imagePrompt,
      imageAccountId: null,
      accountId: null,
      prompt: shot.videoPrompt,
      model: shot.model,
      duration: shot.duration,
      aspectRatio: shot.aspectRatio
    }));
    const incomingHasGlobals = Boolean(parsed.globalPrompt || parsed.imageGlobalPrompt || parsed.videoGlobalPrompt);
    const existing = projectStyleByName.value.get(parsed.projectName);
    if (incomingHasGlobals && (!existing || importGlobalChoice.value === "incoming")) {
      await window.desktopApi.projects.saveStyle({
        projectName: parsed.projectName,
        globalPrompt: parsed.globalPrompt,
        imageGlobalPrompt: parsed.imageGlobalPrompt,
        videoGlobalPrompt: parsed.videoGlobalPrompt,
        migrationPending: false,
        characterReferencePath: existing?.characterReferencePath ?? null,
        sceneReferencePath: existing?.sceneReferencePath ?? null,
        styleReferencePath: existing?.styleReferencePath ?? null,
        lockedModel: existing?.lockedModel ?? null,
        lockedAspectRatio: existing?.lockedAspectRatio ?? null
      });
    }
    await window.desktopApi.tasks.importMany(inputs);
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
    flash(`已导入 ${inputs.length} 个分镜${assignmentMessage}`);
  });
}

function openProjectStyle(projectName: string) {
  if (!projectName) {
    flash("请先给项目填写名称，再设置风格锁定", true);
    return;
  }
  const existing = projectStyleByName.value.get(projectName);
  Object.assign(styleForm, existing ? {
    projectName: existing.projectName,
    globalPrompt: existing.globalPrompt,
    imageGlobalPrompt: existing.imageGlobalPrompt,
    videoGlobalPrompt: existing.videoGlobalPrompt,
    migrationPending: existing.migrationPending,
    characterReferencePath: existing.characterReferencePath,
    sceneReferencePath: existing.sceneReferencePath,
    styleReferencePath: existing.styleReferencePath,
    lockedModel: existing.lockedModel,
    lockedAspectRatio: existing.lockedAspectRatio
  } : {
    projectName,
    globalPrompt: "吉卜力风格宠物动画，保持角色外形、花纹、配饰、场景布局、光线方向和色彩统一。",
    imageGlobalPrompt: "",
    videoGlobalPrompt: "保持首帧造型与画风，动作自然连贯。禁止角色变形、花纹改变、多余肢体、文字和水印。",
    migrationPending: false,
    characterReferencePath: null,
    sceneReferencePath: null,
    styleReferencePath: null,
    lockedModel: null,
    lockedAspectRatio: null
  });
  applyStyleLocks.value = true;
  styleTargetName.value = projectName;
}

async function chooseProjectReference(kind: ProjectReferenceKind) {
  const selected = await window.desktopApi.projects.chooseReference(kind);
  if (!selected) return;
  if (kind === "character") styleForm.characterReferencePath = selected;
  if (kind === "scene") styleForm.sceneReferencePath = selected;
  if (kind === "style") styleForm.styleReferencePath = selected;
}

function clearProjectReference(kind: ProjectReferenceKind) {
  if (kind === "character") styleForm.characterReferencePath = null;
  if (kind === "scene") styleForm.sceneReferencePath = null;
  if (kind === "style") styleForm.styleReferencePath = null;
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

async function saveSettings() {
  await act(async () => {
    settings.value = await window.desktopApi.settings.update({ maxActiveWorkers: settings.value.maxActiveWorkers });
    flash("设置已保存");
  });
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

async function act(operation: () => Promise<void>) {
  try {
    await operation();
    await refreshData();
    await refreshRuntime();
  } catch (error) {
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

function projectHasReferences(projectName: string) {
  const profile = projectStyleByName.value.get(projectName);
  return Boolean(profile?.characterReferencePath || profile?.sceneReferencePath || profile?.styleReferencePath);
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

function handleFirstFrameSourceChange() {
  if (taskForm.firstFrameSource !== "generated") {
    taskForm.imagePrompt = "";
    taskForm.imageAccountId = "";
  }
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
        <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'"><span>⚙</span>设置</button>
      </nav>

      <div class="runtime-card">
        <div><span class="live-dot"></span>本地运行</div>
        <strong>{{ runtime.totalPrivateMb }} MB</strong>
        <small>{{ runtime.activeAccountWindows }} 个账号窗口 · {{ runtime.processCount }} 个进程</small>
      </div>
    </aside>

    <main>
      <header class="topbar">
        <div>
          <p class="eyebrow">LOCAL FIRST · SESSION ISOLATION</p>
          <h1>{{ { overview: '工作台概览', accounts: '账号空间', tasks: '视频任务', settings: '运行设置' }[activeTab] }}</h1>
        </div>
        <button class="primary" @click="openAddAccount">＋ 添加账号</button>
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
          <div><p class="eyebrow">STORYBOARD PIPELINE</p><h2>分镜图审核后再进入视频生成</h2></div>
          <div><button @click="showImportDialog = true">批量导入分镜</button><button class="primary" @click="autoAssignTasks">自动分配账号</button></div>
        </section>
        <section class="task-layout">
          <form class="panel task-form" @submit.prevent="saveTask">
            <p class="eyebrow">{{ editingTaskId ? 'EDIT SHOT' : 'NEW SHOT' }}</p><h2>{{ editingTaskId ? '编辑分镜任务' : '保存单个分镜' }}</h2>
            <div class="project-row">
              <label>项目 / 视频名称<input v-model="taskForm.projectName" maxlength="80" placeholder="例如：产品宣传片" /></label>
              <label>分镜编号<input v-model.number="taskForm.shotNumber" type="number" min="1" step="1" required /></label>
            </div>
            <button class="inline-style-button" type="button" :disabled="!taskForm.projectName.trim()" @click="openProjectStyle(taskForm.projectName)">设置项目全局约束</button>
            <div class="stage-block image-stage">
              <div class="stage-title"><span>1</span><strong>首帧来源</strong><small>三种方式任选一种</small></div>
              <div class="source-options">
                <label><input v-model="taskForm.firstFrameSource" type="radio" value="local" @change="handleFirstFrameSourceChange" />本地图片</label>
                <label><input v-model="taskForm.firstFrameSource" type="radio" value="generated" @change="handleFirstFrameSourceChange" />提示词生成</label>
                <label><input v-model="taskForm.firstFrameSource" type="radio" value="none" @change="handleFirstFrameSourceChange" />无（纯文生视频）</label>
              </div>
              <template v-if="taskForm.firstFrameSource === 'generated'">
                <label>生图账号<select v-model="taskForm.imageAccountId"><option value="">稍后自动分配</option><option v-for="account in readyAccounts" :key="account.id" :value="account.id">{{ account.label }}</option></select></label>
                <label>分镜图提示词<textarea v-model="taskForm.imagePrompt" rows="4" placeholder="描述主体、场景、构图、光线和画面风格…" required></textarea></label>
              </template>
              <p v-else-if="taskForm.firstFrameSource === 'local'" class="form-note">保存后在分镜卡片中选择本地图片；批量导入可按文件名自动匹配。</p>
            </div>
            <div class="stage-block video-stage">
              <div class="stage-title"><span>2</span><strong>分镜视频</strong><small>有分镜图时，需审核通过后执行</small></div>
              <label>视频账号<select v-model="taskForm.accountId"><option value="">稍后自动分配</option><option v-for="account in readyAccounts" :key="account.id" :value="account.id">{{ account.label }}</option></select></label>
              <label>分镜视频提示词<textarea v-model="taskForm.prompt" rows="5" placeholder="描述镜头运动、主体动作、节奏、声音和禁止项…" required></textarea></label>
            </div>
            <div class="form-row">
              <label class="model-field">模型
                <select v-model="taskForm.model" @change="handleModelChange">
                  <option v-for="model in VIDEO_MODEL_OPTIONS" :key="model.value" :value="model.value">{{ model.label }}</option>
                </select>
              </label>
              <label>时长
                <select v-model.number="taskForm.duration">
                  <option v-for="duration in availableDurations" :key="duration" :value="duration">{{ durationLabel(duration) }}</option>
                </select>
              </label>
              <label>画幅
                <select v-model="taskForm.aspectRatio">
                  <option v-for="aspectRatio in availableAspectRatios" :key="aspectRatio" :value="aspectRatio">{{ aspectRatioLabel(aspectRatio) }}</option>
                </select>
              </label>
            </div>
            <p class="spec-note">{{ selectedVideoModel.label }} · {{ selectedVideoModel.durationMin }}–{{ selectedVideoModel.durationMax }} 秒 · 支持自动时长与自适应画幅</p>
            <div class="form-actions">
              <button v-if="editingTaskId" type="button" @click="cancelTaskEdit">取消编辑</button>
              <button class="primary" :class="{ wide: !editingTaskId }" type="submit">{{ editingTaskId ? '保存修改' : '保存并继续下一分镜' }}</button>
            </div>
            <p class="form-note">点击执行后会打开对应隔离账号并自动填入提示词。模型、时长、画幅、提交按钮以及生成结果目前仍由你在豆包页面确认。</p>
          </form>

          <section class="panel task-list">
            <div class="section-heading"><div><p class="eyebrow">LOCAL QUEUE</p><h2>分镜流水线</h2></div><span>{{ tasks.length }} 条</span></div>
            <div v-if="tasks.length" class="task-groups">
              <section v-for="group in taskGroups" :key="group.name" class="task-group">
                <div class="task-group-head">
                  <div><strong>{{ group.name }}</strong><span>{{ taskGroupSummary(group.tasks) }}</span></div>
                  <button v-if="group.projectName" class="style-lock-button" :class="{ active: hasProjectStyle(projectStyleByName.get(group.projectName)) }" @click="openProjectStyle(group.projectName)">
                    {{ hasProjectStyle(projectStyleByName.get(group.projectName)) ? '已设全局约束' : '设置全局约束' }}
                  </button>
                  <button v-else class="style-lock-button" disabled>命名后可锁定风格</button>
                </div>
                <div class="task-items">
                  <article v-for="task in group.tasks" :key="task.id" class="task-item">
                    <div><strong>分镜 {{ task.shotNumber }}</strong><small>{{ durationLabel(task.duration) }} · {{ aspectRatioLabel(task.aspectRatio) }}</small></div>
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
                    <details v-if="task.imagePrompt" class="prompt-detail"><summary>分镜图提示词</summary><p>{{ task.imagePrompt }}</p></details>
                    <details class="prompt-detail"><summary>分镜视频提示词</summary><p>{{ task.prompt }}</p></details>
                    <p v-if="task.imagePath" class="image-path">已关联：{{ fileName(task.imagePath) }}</p>
                    <div class="task-meta"><span>{{ task.model }}<template v-if="hasProjectStyle(projectStyleByName.get(task.projectName))"> · 项目风格已合成</template></span><span>{{ formatTime(task.createdAt) }}</span></div>
                    <div v-if="task.firstFrameSource !== 'none'" class="card-actions stage-actions">
                      <button v-if="task.firstFrameSource === 'generated'" class="primary small" @click="openImageTask(task)">打开生图页</button>
                      <button v-if="task.firstFrameSource === 'generated' && (task.imageStatus === 'preparing' || task.imageStatus === 'failed' || task.imageStatus === 'pending')" @click="updateImageTask(task, 'submitted')">标记已提交</button>
                      <button v-if="task.firstFrameSource === 'generated' && task.imageStatus === 'submitted'" @click="updateImageTask(task, 'ready')">标记待审核</button>
                      <button @click="chooseTaskImage(task)">{{ task.firstFrameSource === 'local' ? '选择本地首帧' : '选择生成结果' }}</button>
                      <button v-if="task.firstFrameSource === 'generated' && task.imageStatus !== 'failed'" @click="updateImageTask(task, 'failed')">生图失败</button>
                    </div>
                    <div class="card-actions stage-actions">
                      <button class="primary small" :disabled="task.firstFrameSource !== 'none' && task.imageStatus !== 'approved'" @click="openTask(task)">打开视频页</button>
                      <button @click="copyTaskPrompt(task)">复制视频提示词</button>
                      <button @click="editTask(task)">编辑</button>
                      <button @click="duplicateTask(task)">复制为下一镜</button>
                      <button v-if="task.status === 'queued' || task.status === 'failed' || task.status === 'cancelled'" @click="updateTask(task, 'submitted')">标记已提交</button>
                      <button v-if="task.status === 'submitted'" @click="updateTask(task, 'running')">标记生成中</button>
                      <button v-if="task.status === 'submitted' || task.status === 'running'" @click="updateTask(task, 'succeeded')">标记完成</button>
                      <button v-if="task.status === 'submitted' || task.status === 'running'" @click="updateTask(task, 'failed')">标记失败</button>
                      <button class="danger" @click="removeTask(task)">删除</button>
                    </div>
                  </article>
                </div>
              </section>
            </div>
            <div v-else class="empty inline"><strong>还没有任务</strong><span>可以保存单个分镜，也可以一次导入整套分镜。</span></div>
          </section>
        </section>
      </template>

      <template v-else>
        <section class="settings-grid">
          <article class="panel setting-card"><p class="eyebrow">CONCURRENCY</p><h2>活动 Worker 上限</h2><p class="muted">账号可以有 20 个，但豆包窗口默认最多同时保留 2 个。</p><div class="stepper"><button @click="settings.maxActiveWorkers = Math.max(1, settings.maxActiveWorkers - 1)">−</button><strong>{{ settings.maxActiveWorkers }}</strong><button @click="settings.maxActiveWorkers = Math.min(3, settings.maxActiveWorkers + 1)">＋</button></div><button class="primary" @click="saveSettings">保存设置</button></article>
          <article class="panel setting-card"><p class="eyebrow">LOCAL DATA</p><h2>数据目录</h2><p class="muted">账号会话、SQLite 数据库和缓存仅保存在本机。</p><code class="path">{{ runtime.dataPath }}</code><p v-if="runtime.dataPathNotice" class="migration-warning">{{ runtime.dataPathNotice }}</p><button @click="chooseDataDirectory">更改目录</button><p class="security-note">迁移时保留原目录作为备份；不保存密码、短信验证码或 2FA 密钥。</p></article>
          <article class="panel setting-card"><p class="eyebrow">AUTOMATION</p><h2>自动执行适配器</h2><p class="muted">核心接口已经隔离，当前默认保持关闭。下一阶段接入豆包页面适配器后再开放。</p><span class="coming">准备中</span></article>
          <article class="panel setting-card"><p class="eyebrow">DIAGNOSTICS</p><h2>诊断信息</h2><p class="muted">版本 v{{ runtime.version }}。日志只记录程序事件和错误，不记录 Cookie、密码或验证码。</p><code class="path">{{ runtime.logPath }}</code><button @click="exportDiagnostics">导出诊断信息</button><p class="security-note">发送诊断文件前仍建议自行检查内容。</p></article>
        </section>
      </template>
    </main>

    <div v-if="showAccountDialog" class="modal-backdrop" @click.self="showAccountDialog = false">
      <form class="modal" @submit.prevent="createAccount"><p class="eyebrow">NEW ISOLATED SESSION</p><h2>添加豆包账号</h2><p class="muted">名称只是本地备注，不会修改豆包昵称。</p><label>本地备注<input v-model="newAccountLabel" autofocus required /></label><div class="modal-actions"><button type="button" @click="showAccountDialog = false">取消</button><button class="primary" type="submit">创建并打开登录</button></div></form>
    </div>
    <div v-if="renameAccountTarget" class="modal-backdrop" @click.self="renameAccountTarget = null">
      <form class="modal" @submit.prevent="renameAccount"><p class="eyebrow">LOCAL LABEL</p><h2>修改账号备注</h2><p class="muted">只修改工作台里的本地备注，不会修改豆包昵称。</p><label>本地备注<input v-model="renameAccountLabel" autofocus maxlength="60" required /></label><div class="modal-actions"><button type="button" @click="renameAccountTarget = null">取消</button><button class="primary" type="submit">保存备注</button></div></form>
    </div>
    <div v-if="showImportDialog" class="modal-backdrop" @click.self="showImportDialog = false">
      <form class="modal import-modal" @submit.prevent="importStoryboardTasks">
        <p class="eyebrow">BATCH STORYBOARD</p><h2>批量导入整套分镜</h2>
        <p class="muted">支持 JSON 或 Markdown。每个分镜可指定首帧来源；本地图片可写文件名，也可留空后按分镜编号自动匹配。</p>
        <label>项目名称（原文中有项目名称时可留空）<input v-model="importProjectName" placeholder="例如：柯基水草球短片" /></label>
        <label>分镜内容<textarea v-model="importText" rows="12" placeholder="项目名称：柯基短片&#10;全局提示词：吉卜力风格…&#10;### 分镜 1&#10;首帧来源：本地图片&#10;首帧图：01.png&#10;视频提示词：……&#10;时长：10秒&#10;画幅：9:16"></textarea></label>
        <div v-if="importPreview.storyboard" class="import-result success">识别到 {{ importPreview.storyboard.shots.length }} 个分镜 · 项目：{{ importPreview.storyboard.projectName }}</div>
        <div v-else-if="importPreview.error" class="import-result error">{{ importPreview.error }}</div>
        <template v-if="importPreview.storyboard?.shots.some(shot => shot.firstFrameSource === 'local')">
          <div class="asset-folder-row"><div><strong>本地首帧素材</strong><span>{{ importAssets.folderPath || '尚未选择文件夹；绝对路径可直接识别' }}</span></div><button type="button" @click="chooseImportAssetFolder">选择素材文件夹</button></div>
          <div v-if="importAssetResolution" class="asset-preview-list">
            <article v-for="item in importAssetResolution.shots.filter(item => importPreview.storyboard?.shots.find(shot => shot.shotNumber === item.shotNumber)?.firstFrameSource === 'local')" :key="item.shotNumber" :class="{ invalid: item.error }">
              <img v-if="item.file?.thumbnailUrl" :src="item.file.thumbnailUrl" alt="" />
              <div><strong>分镜 {{ item.shotNumber }}</strong><span>{{ item.file?.name || item.error }}</span><small v-if="item.warning">{{ item.warning }}</small></div>
            </article>
          </div>
          <p v-if="importAssetResolution?.unusedFiles.length" class="import-warning">文件夹中还有 {{ importAssetResolution.unusedFiles.length }} 张未匹配图片，不会导入。</p>
        </template>
        <div v-if="importGlobalConflict" class="global-conflict">
          <strong>导入稿的全局提示词与项目现有设置不同</strong>
          <label><input v-model="importGlobalChoice" type="radio" value="incoming" />使用导入稿</label>
          <label><input v-model="importGlobalChoice" type="radio" value="existing" />保留现有设置</label>
        </div>
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
            <strong>角色 / 宠物定妆图</strong><span>{{ fileName(styleForm.characterReferencePath) || '未选择' }}</span>
            <div><button type="button" @click="chooseProjectReference('character')">选择</button><button v-if="styleForm.characterReferencePath" type="button" @click="clearProjectReference('character')">清除</button></div>
          </article>
          <article>
            <strong>场景参考图</strong><span>{{ fileName(styleForm.sceneReferencePath) || '未选择' }}</span>
            <div><button type="button" @click="chooseProjectReference('scene')">选择</button><button v-if="styleForm.sceneReferencePath" type="button" @click="clearProjectReference('scene')">清除</button></div>
          </article>
          <article>
            <strong>风格参考图</strong><span>{{ fileName(styleForm.styleReferencePath) || '未选择' }}</span>
            <div><button type="button" @click="chooseProjectReference('style')">选择</button><button v-if="styleForm.styleReferencePath" type="button" @click="clearProjectReference('style')">清除</button></div>
          </article>
        </div>

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
