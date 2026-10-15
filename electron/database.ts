import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Account,
  AccountStatus,
  AccountUsage,
  AppSettings,
  AssignmentSummary,
  ImageTaskStatus,
  ProjectStyleInput,
  ProjectStyleProfile,
  TaskInput,
  TaskRecord,
  TaskStatus,
  UsageKind
} from "./contracts.js";

type DbRow = Record<string, string | number | null>;

const now = () => new Date().toISOString();

export class StudioDatabase {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "studio.sqlite"), { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        partition_name TEXT NOT NULL UNIQUE,
        doubao_user_id TEXT,
        display_name TEXT,
        avatar_url TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_verified_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL DEFAULT '',
        shot_number INTEGER NOT NULL DEFAULT 1,
        image_prompt TEXT NOT NULL DEFAULT '',
        image_account_id TEXT,
        image_status TEXT NOT NULL DEFAULT 'skipped',
        image_path TEXT,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        duration INTEGER NOT NULL,
        aspect_ratio TEXT NOT NULL,
        status TEXT NOT NULL,
        result_url TEXT,
        result_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_usage (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        usage_date TEXT NOT NULL,
        image_count INTEGER NOT NULL DEFAULT 0,
        video_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account_id, usage_date)
      );
      CREATE TABLE IF NOT EXISTS project_styles (
        project_name TEXT PRIMARY KEY,
        style_prompt TEXT NOT NULL DEFAULT '',
        character_prompt TEXT NOT NULL DEFAULT '',
        scene_prompt TEXT NOT NULL DEFAULT '',
        continuity_prompt TEXT NOT NULL DEFAULT '',
        negative_prompt TEXT NOT NULL DEFAULT '',
        character_reference_path TEXT,
        scene_reference_path TEXT,
        style_reference_path TEXT,
        locked_model TEXT,
        locked_aspect_ratio TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
    `);
    const taskColumns = new Set(
      (this.db.prepare("PRAGMA table_info(tasks)").all() as DbRow[]).map((row) => String(row.name))
    );
    if (!taskColumns.has("project_name")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN project_name TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.has("shot_number")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN shot_number INTEGER NOT NULL DEFAULT 1");
    }
    if (!taskColumns.has("image_prompt")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN image_prompt TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.has("image_account_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN image_account_id TEXT");
    }
    if (!taskColumns.has("image_status")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN image_status TEXT NOT NULL DEFAULT 'skipped'");
    }
    if (!taskColumns.has("image_path")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN image_path TEXT");
    }
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("maxActiveWorkers", "2");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("automationEnabled", "false");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("lastTaskAccountId", "");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("lastVideoModel", "Seedance 2.0 mini");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("lastVideoDuration", "10");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("lastAspectRatio", "9:16");
  }

  listAccounts(): Account[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as DbRow[]).map(rowToAccount);
  }

  getAccount(id: string): Account {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) throw new Error("账号不存在");
    return rowToAccount(row);
  }

  createAccount(label: string): Account {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("账号备注不能为空");
    const id = randomUUID();
    const createdAt = now();
    const partition = `persist:doubao-${id.replaceAll("-", "")}`;
    this.db.prepare(`
      INSERT INTO accounts(id, label, partition_name, status, created_at)
      VALUES (?, ?, ?, 'login_required', ?)
    `).run(id, trimmed, partition, createdAt);
    return this.getAccount(id);
  }

  renameAccount(id: string, label: string): Account {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("账号备注不能为空");
    if (trimmed.length > 60) throw new Error("账号备注不能超过 60 个字符");
    this.getAccount(id);
    this.db.prepare("UPDATE accounts SET label = ? WHERE id = ?").run(trimmed, id);
    return this.getAccount(id);
  }

  updateIdentity(id: string, identity: { userId: string; displayName?: string | null; avatarUrl?: string | null }): Account {
    const duplicate = this.db.prepare("SELECT id FROM accounts WHERE doubao_user_id = ? AND id != ?").get(identity.userId, id) as DbRow | undefined;
    if (duplicate) throw new Error("这个豆包账号已经添加过了");
    this.db.prepare(`
      UPDATE accounts
      SET doubao_user_id = ?, display_name = ?, avatar_url = ?, status = 'ready', last_verified_at = ?
      WHERE id = ?
    `).run(identity.userId, identity.displayName ?? null, identity.avatarUrl ?? null, now(), id);
    return this.getAccount(id);
  }

  setAccountStatus(id: string, status: AccountStatus): Account {
    this.db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, id);
    return this.getAccount(id);
  }

  deleteAccount(id: string) {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  listTasks(): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as DbRow[]).map(rowToTask);
  }

  getTask(id: string): TaskRecord {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) throw new Error("任务不存在");
    return rowToTask(row);
  }

  createTask(input: TaskInput): TaskRecord {
    const normalized = this.validateTaskInput(input);
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO tasks(
        id, project_name, shot_number, image_prompt, image_account_id, image_status,
        account_id, prompt, model, duration, aspect_ratio, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      id,
      normalized.projectName,
      normalized.shotNumber,
      normalized.imagePrompt,
      normalized.imageAccountId,
      normalized.imagePrompt ? "pending" : "skipped",
      normalized.accountId,
      normalized.prompt,
      normalized.model,
      normalized.duration,
      normalized.aspectRatio,
      createdAt,
      createdAt
    );
    return this.getTask(id);
  }

  createTasks(inputs: TaskInput[]): TaskRecord[] {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("没有可导入的分镜");
    if (inputs.length > 300) throw new Error("单次最多导入 300 个分镜");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tasks = inputs.map((input) => this.createTask(input));
      this.db.exec("COMMIT");
      return tasks;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id: string, input: TaskInput): TaskRecord {
    this.getTask(id);
    const normalized = this.validateTaskInput(input);
    this.db.prepare(`
      UPDATE tasks
      SET project_name = ?, shot_number = ?, image_prompt = ?, image_account_id = ?,
          image_status = CASE
            WHEN ? = '' THEN 'skipped'
            WHEN image_prompt != ? THEN 'pending'
            ELSE image_status
          END,
          image_path = CASE WHEN image_prompt != ? THEN NULL ELSE image_path END,
          account_id = ?, prompt = ?, model = ?, duration = ?, aspect_ratio = ?, updated_at = ?
      WHERE id = ?
    `).run(
      normalized.projectName,
      normalized.shotNumber,
      normalized.imagePrompt,
      normalized.imageAccountId,
      normalized.imagePrompt,
      normalized.imagePrompt,
      normalized.imagePrompt,
      normalized.accountId,
      normalized.prompt,
      normalized.model,
      normalized.duration,
      normalized.aspectRatio,
      now(),
      id
    );
    return this.getTask(id);
  }

  duplicateTask(id: string): TaskRecord {
    const source = this.getTask(id);
    return this.createTask({
      projectName: source.projectName,
      shotNumber: source.shotNumber + 1,
      imagePrompt: source.imagePrompt,
      imageAccountId: source.imageAccountId,
      accountId: source.accountId,
      prompt: source.prompt,
      model: source.model,
      duration: source.duration,
      aspectRatio: source.aspectRatio
    });
  }

  deleteTask(id: string) {
    this.getTask(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  setTaskStatus(id: string, status: TaskStatus, errorMessage: string | null = null): TaskRecord {
    const previous = this.getTask(id);
    this.db.prepare("UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?")
      .run(status, errorMessage, now(), id);
    if (status === "submitted" && ["queued", "failed", "cancelled"].includes(previous.status) && previous.accountId) {
      this.incrementUsage(previous.accountId, "video");
    }
    return this.getTask(id);
  }

  setTaskImageStatus(id: string, status: ImageTaskStatus): TaskRecord {
    const previous = this.getTask(id);
    if (!previous.imagePrompt && status !== "skipped") throw new Error("这个分镜没有生图提示词");
    this.db.prepare("UPDATE tasks SET image_status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    if (status === "submitted" && ["pending", "preparing", "failed"].includes(previous.imageStatus) && previous.imageAccountId) {
      this.incrementUsage(previous.imageAccountId, "image");
    }
    return this.getTask(id);
  }

  setTaskImage(id: string, imagePath: string): TaskRecord {
    this.getTask(id);
    this.db.prepare("UPDATE tasks SET image_path = ?, image_status = 'approved', updated_at = ? WHERE id = ?")
      .run(imagePath, now(), id);
    return this.getTask(id);
  }

  listTodayUsage(): AccountUsage[] {
    const usageDate = localUsageDate();
    return (this.db.prepare(`
      SELECT a.id AS account_id, ? AS usage_date,
             COALESCE(u.image_count, 0) AS image_count,
             COALESCE(u.video_count, 0) AS video_count
      FROM accounts a
      LEFT JOIN account_usage u ON u.account_id = a.id AND u.usage_date = ?
      ORDER BY a.created_at ASC
    `).all(usageDate, usageDate) as DbRow[]).map(rowToUsage);
  }

  adjustUsage(accountId: string, kind: UsageKind, value: number): AccountUsage {
    this.getAccount(accountId);
    const normalized = Math.max(0, Math.round(Number(value) || 0));
    const usageDate = localUsageDate();
    const column = kind === "image" ? "image_count" : "video_count";
    this.db.prepare(`
      INSERT INTO account_usage(account_id, usage_date, ${column}) VALUES (?, ?, ?)
      ON CONFLICT(account_id, usage_date) DO UPDATE SET ${column} = excluded.${column}
    `).run(accountId, usageDate, normalized);
    return this.listTodayUsage().find((item) => item.accountId === accountId)!;
  }

  private incrementUsage(accountId: string, kind: UsageKind) {
    const usageDate = localUsageDate();
    const column = kind === "image" ? "image_count" : "video_count";
    this.db.prepare(`
      INSERT INTO account_usage(account_id, usage_date, ${column}) VALUES (?, ?, 1)
      ON CONFLICT(account_id, usage_date) DO UPDATE SET ${column} = ${column} + 1
    `).run(accountId, usageDate);
  }

  autoAssignTasks(): AssignmentSummary {
    const accounts = this.listAccounts().filter((account) => account.status === "ready");
    if (!accounts.length) throw new Error("没有已登录并确认的账号，暂时无法自动分配");
    const usage = new Map(this.listTodayUsage().map((item) => [item.accountId, item]));
    const imageLoads = new Map(accounts.map((account) => [account.id, usage.get(account.id)?.imageCount ?? 0]));
    const videoLoads = new Map(accounts.map((account) => [account.id, usage.get(account.id)?.videoCount ?? 0]));
    const tasks = (this.db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC").all() as DbRow[]).map(rowToTask);
    let imageAssignments = 0;
    let videoAssignments = 0;
    const update = this.db.prepare("UPDATE tasks SET image_account_id = ?, account_id = ?, updated_at = ? WHERE id = ?");
    for (const task of tasks) {
      let imageAccountId = task.imageAccountId;
      let accountId = task.accountId;
      if (task.imagePrompt && !imageAccountId) {
        imageAccountId = leastLoaded(accounts.map((item) => item.id), imageLoads);
        imageLoads.set(imageAccountId, (imageLoads.get(imageAccountId) ?? 0) + 1);
        imageAssignments += 1;
      }
      if (!accountId) {
        accountId = leastLoaded(accounts.map((item) => item.id), videoLoads);
        videoLoads.set(accountId, (videoLoads.get(accountId) ?? 0) + 1);
        videoAssignments += 1;
      }
      if (imageAccountId !== task.imageAccountId || accountId !== task.accountId) {
        update.run(imageAccountId, accountId, now(), task.id);
      }
    }
    return { imageAssignments, videoAssignments };
  }

  listProjectStyles(): ProjectStyleProfile[] {
    return (this.db.prepare("SELECT * FROM project_styles ORDER BY updated_at DESC").all() as DbRow[]).map(rowToProjectStyle);
  }

  getProjectStyle(projectName: string): ProjectStyleProfile | null {
    const row = this.db.prepare("SELECT * FROM project_styles WHERE project_name = ?").get(projectName) as DbRow | undefined;
    return row ? rowToProjectStyle(row) : null;
  }

  saveProjectStyle(input: ProjectStyleInput): ProjectStyleProfile {
    const projectName = input.projectName.trim();
    if (!projectName) throw new Error("请先填写项目名称，再设置风格锁定");
    const updatedAt = now();
    this.db.prepare(`
      INSERT INTO project_styles(
        project_name, style_prompt, character_prompt, scene_prompt, continuity_prompt, negative_prompt,
        character_reference_path, scene_reference_path, style_reference_path,
        locked_model, locked_aspect_ratio, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name) DO UPDATE SET
        style_prompt = excluded.style_prompt,
        character_prompt = excluded.character_prompt,
        scene_prompt = excluded.scene_prompt,
        continuity_prompt = excluded.continuity_prompt,
        negative_prompt = excluded.negative_prompt,
        character_reference_path = excluded.character_reference_path,
        scene_reference_path = excluded.scene_reference_path,
        style_reference_path = excluded.style_reference_path,
        locked_model = excluded.locked_model,
        locked_aspect_ratio = excluded.locked_aspect_ratio,
        updated_at = excluded.updated_at
    `).run(
      projectName,
      input.stylePrompt.trim(),
      input.characterPrompt.trim(),
      input.scenePrompt.trim(),
      input.continuityPrompt.trim(),
      input.negativePrompt.trim(),
      input.characterReferencePath || null,
      input.sceneReferencePath || null,
      input.styleReferencePath || null,
      input.lockedModel || null,
      input.lockedAspectRatio || null,
      updatedAt
    );
    return this.getProjectStyle(projectName)!;
  }

  applyProjectLocks(projectName: string) {
    const profile = this.getProjectStyle(projectName);
    if (!profile) throw new Error("项目尚未保存风格锁定");
    const result = this.db.prepare(`
      UPDATE tasks
      SET model = COALESCE(?, model),
          aspect_ratio = COALESCE(?, aspect_ratio),
          duration = CASE
            WHEN ? IS NOT NULL AND ? != 'Seedance 2.5' AND duration > 15 THEN 15
            ELSE duration
          END,
          updated_at = ?
      WHERE project_name = ?
    `).run(
      profile.lockedModel,
      profile.lockedAspectRatio,
      profile.lockedModel,
      profile.lockedModel,
      now(),
      projectName
    );
    return Number(result.changes);
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as DbRow[];
    const values = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
    return {
      maxActiveWorkers: clampWorkers(Number(values.maxActiveWorkers || 2)),
      automationEnabled: values.automationEnabled === "true",
      lastTaskAccountId: values.lastTaskAccountId || null,
      lastVideoModel: values.lastVideoModel || "Seedance 2.0 mini",
      lastVideoDuration: Number(values.lastVideoDuration || 10),
      lastAspectRatio: values.lastAspectRatio || "9:16"
    };
  }

  updateSettings(input: Partial<AppSettings>): AppSettings {
    if (input.maxActiveWorkers !== undefined) {
      this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('maxActiveWorkers', ?)")
        .run(String(clampWorkers(input.maxActiveWorkers)));
    }
    if (input.automationEnabled !== undefined) {
      this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('automationEnabled', ?)")
        .run(String(Boolean(input.automationEnabled)));
    }
    if (input.lastTaskAccountId !== undefined) {
      this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('lastTaskAccountId', ?)")
        .run(input.lastTaskAccountId ?? "");
    }
    if (input.lastVideoModel !== undefined) {
      this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('lastVideoModel', ?)")
        .run(input.lastVideoModel);
    }
    if (input.lastVideoDuration !== undefined) {
      this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('lastVideoDuration', ?)")
        .run(String(input.lastVideoDuration));
    }
    if (input.lastAspectRatio !== undefined) {
      this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('lastAspectRatio', ?)")
        .run(input.lastAspectRatio);
    }
    return this.getSettings();
  }

  private validateTaskInput(input: TaskInput): TaskInput {
    const prompt = input.prompt.trim();
    const imagePrompt = input.imagePrompt.trim();
    if (!prompt) throw new Error("分镜视频提示词不能为空");
    if (input.accountId) this.getAccount(input.accountId);
    if (input.imageAccountId) this.getAccount(input.imageAccountId);
    const duration = Math.round(Number(input.duration));
    if ((!Number.isInteger(duration) || duration < 4 || duration > 30) && duration !== -1) {
      throw new Error("视频时长参数无效");
    }
    return {
      ...input,
      projectName: input.projectName.trim(),
      shotNumber: Math.max(1, Math.round(Number(input.shotNumber) || 1)),
      imagePrompt,
      prompt,
      duration
    };
  }

  close() {
    this.db.close();
  }
}

function leastLoaded(accountIds: string[], loads: Map<string, number>) {
  return [...accountIds].sort((a, b) => (loads.get(a) ?? 0) - (loads.get(b) ?? 0))[0]!;
}

function localUsageDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function clampWorkers(value: number) {
  return Math.min(3, Math.max(1, Math.round(Number.isFinite(value) ? value : 2)));
}

function rowToAccount(row: DbRow): Account {
  return {
    id: String(row.id),
    label: String(row.label),
    partition: String(row.partition_name),
    doubaoUserId: row.doubao_user_id ? String(row.doubao_user_id) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    status: String(row.status) as AccountStatus,
    createdAt: String(row.created_at),
    lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null
  };
}

function rowToTask(row: DbRow): TaskRecord {
  return {
    id: String(row.id),
    projectName: row.project_name ? String(row.project_name) : "",
    shotNumber: Math.max(1, Number(row.shot_number) || 1),
    imagePrompt: row.image_prompt ? String(row.image_prompt) : "",
    imageAccountId: row.image_account_id ? String(row.image_account_id) : null,
    imageStatus: String(row.image_status || (row.image_prompt ? "pending" : "skipped")) as ImageTaskStatus,
    imagePath: row.image_path ? String(row.image_path) : null,
    accountId: row.account_id ? String(row.account_id) : null,
    prompt: String(row.prompt),
    model: String(row.model),
    duration: Number(row.duration),
    aspectRatio: String(row.aspect_ratio),
    status: String(row.status) as TaskStatus,
    resultUrl: row.result_url ? String(row.result_url) : null,
    resultPath: row.result_path ? String(row.result_path) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToUsage(row: DbRow): AccountUsage {
  return {
    accountId: String(row.account_id),
    usageDate: String(row.usage_date),
    imageCount: Math.max(0, Number(row.image_count) || 0),
    videoCount: Math.max(0, Number(row.video_count) || 0)
  };
}

function rowToProjectStyle(row: DbRow): ProjectStyleProfile {
  return {
    projectName: String(row.project_name),
    stylePrompt: String(row.style_prompt || ""),
    characterPrompt: String(row.character_prompt || ""),
    scenePrompt: String(row.scene_prompt || ""),
    continuityPrompt: String(row.continuity_prompt || ""),
    negativePrompt: String(row.negative_prompt || ""),
    characterReferencePath: row.character_reference_path ? String(row.character_reference_path) : null,
    sceneReferencePath: row.scene_reference_path ? String(row.scene_reference_path) : null,
    styleReferencePath: row.style_reference_path ? String(row.style_reference_path) : null,
    lockedModel: row.locked_model ? String(row.locked_model) : null,
    lockedAspectRatio: row.locked_aspect_ratio ? String(row.locked_aspect_ratio) : null,
    updatedAt: String(row.updated_at)
  };
}
