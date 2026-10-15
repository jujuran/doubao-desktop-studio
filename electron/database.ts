import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Account, AccountStatus, AppSettings, TaskRecord, TaskStatus } from "./contracts.js";

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
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
    `);
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("maxActiveWorkers", "2");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("automationEnabled", "false");
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

  createTask(input: Pick<TaskRecord, "accountId" | "prompt" | "model" | "duration" | "aspectRatio">): TaskRecord {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("提示词不能为空");
    if (input.accountId) this.getAccount(input.accountId);
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO tasks(id, account_id, prompt, model, duration, aspect_ratio, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, input.accountId, prompt, input.model, input.duration, input.aspectRatio, createdAt, createdAt);
    return this.getTask(id);
  }

  setTaskStatus(id: string, status: TaskStatus, errorMessage: string | null = null): TaskRecord {
    this.db.prepare("UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?")
      .run(status, errorMessage, now(), id);
    return this.getTask(id);
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as DbRow[];
    const values = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
    return {
      maxActiveWorkers: clampWorkers(Number(values.maxActiveWorkers || 2)),
      automationEnabled: values.automationEnabled === "true"
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
    return this.getSettings();
  }

  close() {
    this.db.close();
  }
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
