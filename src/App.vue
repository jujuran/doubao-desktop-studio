<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { Account, AppSettings, RuntimeStats, TaskRecord, TaskStatus } from "../electron/contracts";

type Tab = "overview" | "accounts" | "tasks" | "settings";

const activeTab = ref<Tab>("overview");
const accounts = ref<Account[]>([]);
const tasks = ref<TaskRecord[]>([]);
const settings = ref<AppSettings>({ maxActiveWorkers: 2, automationEnabled: false });
const runtime = ref<RuntimeStats>({ totalPrivateMb: 0, processCount: 0, activeAccountWindows: 0, dataPath: "" });
const loading = ref(true);
const notice = ref("");
const noticeError = ref(false);
const newAccountLabel = ref("");
const showAccountDialog = ref(false);
const taskForm = reactive({ accountId: "", prompt: "", model: "Seedance", duration: 10, aspectRatio: "9:16" });

const readyAccounts = computed(() => accounts.value.filter((account) => account.status === "ready"));
const queuedTasks = computed(() => tasks.value.filter((task) => task.status === "queued").length);
const activeTasks = computed(() => tasks.value.filter((task) => task.status === "running").length);
const accountById = computed(() => new Map(accounts.value.map((account) => [account.id, account])));

let removeChangeListener: (() => void) | undefined;
let statsTimer: number | undefined;

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
  const [nextAccounts, nextTasks, nextSettings] = await Promise.all([
    window.desktopApi.accounts.list(),
    window.desktopApi.tasks.list(),
    window.desktopApi.settings.get()
  ]);
  accounts.value = nextAccounts;
  tasks.value = nextTasks;
  settings.value = nextSettings;
  if (!taskForm.accountId && readyAccounts.value[0]) taskForm.accountId = readyAccounts.value[0].id;
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

async function clearAccountCache(account: Account) {
  await act(async () => {
    await window.desktopApi.accounts.clearCache(account.id);
    flash("缓存已清理，登录状态已保留");
  });
}

async function removeAccount(account: Account) {
  if (!window.confirm(`删除“${account.label}”及其本机登录状态？任务记录会保留。`)) return;
  await act(async () => {
    await window.desktopApi.accounts.remove(account.id);
    flash("账号及其本机浏览器数据已删除");
  });
}

async function createTask() {
  await act(async () => {
    await window.desktopApi.tasks.create({
      accountId: taskForm.accountId || null,
      prompt: taskForm.prompt,
      model: taskForm.model,
      duration: Number(taskForm.duration),
      aspectRatio: taskForm.aspectRatio
    });
    taskForm.prompt = "";
    flash("任务已保存到本地队列");
  });
}

async function openTask(task: TaskRecord) {
  await act(async () => {
    await window.desktopApi.tasks.open(task.id);
    flash("已打开对应账号，提示词也已复制到剪贴板");
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
    queued: "已排队",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消"
  } as Record<string, string>)[status] || status;
}

function shortId(value: string | null) {
  if (!value) return "尚未确认 UID";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">D</div>
        <div>
          <strong>Doubao Studio</strong>
          <span>本地账号工作台</span>
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
            <div class="account-head"><div class="avatar">{{ account.label.slice(0, 1) }}</div><span class="badge" :class="account.status">{{ statusLabel(account.status) }}</span></div>
            <h3>{{ account.label }}</h3><p>{{ account.displayName || '尚未读取豆包昵称' }}</p><code>{{ shortId(account.doubaoUserId) }}</code>
          </article>
        </section>
        <section v-else class="empty"><strong>还没有账号</strong><span>添加第一个账号，系统会为它创建独立登录空间。</span><button class="primary" @click="openAddAccount">添加账号</button></section>
      </template>

      <template v-else-if="activeTab === 'accounts'">
        <section class="section-heading"><div><p class="eyebrow">PERSISTENT PARTITIONS</p><h2>{{ accounts.length }} 个隔离空间</h2></div><p class="muted">Cookie 不写入数据库，也不会在账号之间复制。</p></section>
        <section v-if="accounts.length" class="account-grid">
          <article v-for="account in accounts" :key="account.id" class="account-card detailed">
            <div class="account-head"><div class="avatar">{{ account.label.slice(0, 1) }}</div><span class="badge" :class="account.status">{{ statusLabel(account.status) }}</span></div>
            <h3>{{ account.label }}</h3><p>{{ account.displayName || '打开窗口并登录后进行确认' }}</p><code>{{ shortId(account.doubaoUserId) }}</code>
            <small v-if="account.lastVerifiedAt">上次确认：{{ formatTime(account.lastVerifiedAt) }}</small>
            <div class="card-actions">
              <button class="primary small" @click="openAccount(account)">打开</button>
              <button @click="verifyAccount(account)">确认账号</button>
              <button @click="clearAccountCache(account)">清缓存</button>
              <button class="danger" @click="removeAccount(account)">删除</button>
            </div>
          </article>
        </section>
        <section v-else class="empty"><strong>账号列表为空</strong><span>每个账号都会使用独立的持久化浏览器 Partition。</span><button class="primary" @click="openAddAccount">添加账号</button></section>
      </template>

      <template v-else-if="activeTab === 'tasks'">
        <section class="task-layout">
          <form class="panel task-form" @submit.prevent="createTask">
            <p class="eyebrow">NEW TASK</p><h2>保存视频任务</h2>
            <label>执行账号<select v-model="taskForm.accountId"><option value="">暂不指定</option><option v-for="account in readyAccounts" :key="account.id" :value="account.id">{{ account.label }}</option></select></label>
            <label>提示词<textarea v-model="taskForm.prompt" rows="7" placeholder="描述画面、镜头、运动、风格和声音…" required></textarea></label>
            <div class="form-row"><label>模型<input v-model="taskForm.model" /></label><label>时长<select v-model.number="taskForm.duration"><option :value="5">5 秒</option><option :value="10">10 秒</option></select></label><label>画幅<select v-model="taskForm.aspectRatio"><option>9:16</option><option>16:9</option><option>1:1</option></select></label></div>
            <button class="primary wide" type="submit">保存到任务队列</button>
            <p class="form-note">当前版本采用辅助执行：打开对应账号并自动复制提示词。自动提交适配器将在账号隔离验证稳定后接入。</p>
          </form>

          <section class="panel task-list">
            <div class="section-heading"><div><p class="eyebrow">LOCAL QUEUE</p><h2>任务记录</h2></div><span>{{ tasks.length }} 条</span></div>
            <div v-if="tasks.length" class="task-items">
              <article v-for="task in tasks" :key="task.id" class="task-item">
                <div><span class="badge" :class="task.status">{{ statusLabel(task.status) }}</span><small>{{ accountName(task.accountId) }} · {{ task.duration }}s · {{ task.aspectRatio }}</small></div>
                <p>{{ task.prompt }}</p>
                <div class="task-meta"><span>{{ task.model }}</span><span>{{ formatTime(task.createdAt) }}</span></div>
                <div class="card-actions">
                  <button v-if="task.status === 'queued' || task.status === 'failed'" class="primary small" @click="openTask(task)">打开执行</button>
                  <button v-if="task.status === 'running'" @click="updateTask(task, 'succeeded')">标记完成</button>
                  <button v-if="task.status !== 'succeeded' && task.status !== 'cancelled'" @click="updateTask(task, 'cancelled')">取消</button>
                </div>
              </article>
            </div>
            <div v-else class="empty inline"><strong>还没有任务</strong><span>先在左侧保存一个视频任务。</span></div>
          </section>
        </section>
      </template>

      <template v-else>
        <section class="settings-grid">
          <article class="panel setting-card"><p class="eyebrow">CONCURRENCY</p><h2>活动 Worker 上限</h2><p class="muted">账号可以有 20 个，但豆包窗口默认最多同时保留 2 个。</p><div class="stepper"><button @click="settings.maxActiveWorkers = Math.max(1, settings.maxActiveWorkers - 1)">−</button><strong>{{ settings.maxActiveWorkers }}</strong><button @click="settings.maxActiveWorkers = Math.min(3, settings.maxActiveWorkers + 1)">＋</button></div><button class="primary" @click="saveSettings">保存设置</button></article>
          <article class="panel setting-card"><p class="eyebrow">LOCAL DATA</p><h2>数据目录</h2><p class="muted">账号会话、SQLite 数据库和缓存仅保存在本机。</p><code class="path">{{ runtime.dataPath }}</code><p class="security-note">不保存密码、短信验证码或 2FA 密钥。</p></article>
          <article class="panel setting-card"><p class="eyebrow">AUTOMATION</p><h2>自动执行适配器</h2><p class="muted">核心接口已经隔离，当前默认保持关闭。下一阶段接入豆包页面适配器后再开放。</p><span class="coming">准备中</span></article>
        </section>
      </template>
    </main>

    <div v-if="showAccountDialog" class="modal-backdrop" @click.self="showAccountDialog = false">
      <form class="modal" @submit.prevent="createAccount"><p class="eyebrow">NEW ISOLATED SESSION</p><h2>添加豆包账号</h2><p class="muted">名称只是本地备注，不会修改豆包昵称。</p><label>本地备注<input v-model="newAccountLabel" autofocus required /></label><div class="modal-actions"><button type="button" @click="showAccountDialog = false">取消</button><button class="primary" type="submit">创建并打开登录</button></div></form>
    </div>
  </div>
</template>
