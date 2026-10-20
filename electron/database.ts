import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  Account,
  AccountStatus,
  AccountUsage,
  AppSettings,
  AssignmentSummary,
  FirstFrameSource,
  ImageTaskStatus,
  MediaCandidate,
  MediaCandidateKind,
  PreparationState,
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

  constructor(private readonly dataDir: string) {
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
        shot_name TEXT NOT NULL DEFAULT '',
        narration TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        generation_count INTEGER NOT NULL DEFAULT 1,
        image_generation_count INTEGER NOT NULL DEFAULT 0,
        video_generation_count INTEGER NOT NULL DEFAULT 0,
        first_frame_source TEXT NOT NULL DEFAULT 'none',
        first_frame_file_name TEXT,
        image_prompt TEXT NOT NULL DEFAULT '',
        image_account_id TEXT,
        image_status TEXT NOT NULL DEFAULT 'skipped',
        image_path TEXT,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        model_source TEXT NOT NULL DEFAULT 'shot',
        duration INTEGER NOT NULL,
        duration_source TEXT NOT NULL DEFAULT 'shot',
        aspect_ratio TEXT NOT NULL,
        aspect_ratio_source TEXT NOT NULL DEFAULT 'shot',
        status TEXT NOT NULL,
        result_url TEXT,
        result_path TEXT,
        error_message TEXT,
        image_prepare_state TEXT NOT NULL DEFAULT 'idle',
        image_prepare_step TEXT NOT NULL DEFAULT '',
        image_prepare_message TEXT,
        video_prepare_state TEXT NOT NULL DEFAULT 'idle',
        video_prepare_step TEXT NOT NULL DEFAULT '',
        video_prepare_message TEXT,
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
      CREATE TABLE IF NOT EXISTS media_candidates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        generation_index INTEGER NOT NULL,
        candidate_index INTEGER NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending',
        has_watermark INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_styles (
        project_name TEXT PRIMARY KEY,
        global_prompt TEXT NOT NULL DEFAULT '',
        image_global_prompt TEXT NOT NULL DEFAULT '',
        video_global_prompt TEXT NOT NULL DEFAULT '',
        legacy_migration_pending INTEGER NOT NULL DEFAULT 0,
        style_prompt TEXT NOT NULL DEFAULT '',
        character_prompt TEXT NOT NULL DEFAULT '',
        scene_prompt TEXT NOT NULL DEFAULT '',
        continuity_prompt TEXT NOT NULL DEFAULT '',
        negative_prompt TEXT NOT NULL DEFAULT '',
        character_reference_path TEXT,
        character_reference_paths_json TEXT NOT NULL DEFAULT '[]',
        character_reference_hashes_json TEXT NOT NULL DEFAULT '[]',
        character_reference_names_json TEXT NOT NULL DEFAULT '[]',
        scene_reference_path TEXT,
        scene_reference_name TEXT,
        style_reference_path TEXT,
        style_reference_name TEXT,
        output_directory TEXT,
        locked_model TEXT,
        locked_aspect_ratio TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_media_candidates_task ON media_candidates(task_id, kind, generation_index, candidate_index);
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
    if (!taskColumns.has("shot_name")) this.db.exec("ALTER TABLE tasks ADD COLUMN shot_name TEXT NOT NULL DEFAULT ''");
    if (!taskColumns.has("narration")) this.db.exec("ALTER TABLE tasks ADD COLUMN narration TEXT NOT NULL DEFAULT ''");
    if (!taskColumns.has("notes")) this.db.exec("ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
    if (!taskColumns.has("generation_count")) this.db.exec("ALTER TABLE tasks ADD COLUMN generation_count INTEGER NOT NULL DEFAULT 1");
    if (!taskColumns.has("image_generation_count")) this.db.exec("ALTER TABLE tasks ADD COLUMN image_generation_count INTEGER NOT NULL DEFAULT 0");
    if (!taskColumns.has("video_generation_count")) this.db.exec("ALTER TABLE tasks ADD COLUMN video_generation_count INTEGER NOT NULL DEFAULT 0");
    if (!taskColumns.has("model_source")) this.db.exec("ALTER TABLE tasks ADD COLUMN model_source TEXT NOT NULL DEFAULT 'shot'");
    if (!taskColumns.has("duration_source")) this.db.exec("ALTER TABLE tasks ADD COLUMN duration_source TEXT NOT NULL DEFAULT 'shot'");
    if (!taskColumns.has("aspect_ratio_source")) this.db.exec("ALTER TABLE tasks ADD COLUMN aspect_ratio_source TEXT NOT NULL DEFAULT 'shot'");
    if (!taskColumns.has("first_frame_source")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN first_frame_source TEXT NOT NULL DEFAULT 'none'");
    }
    if (!taskColumns.has("first_frame_file_name")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN first_frame_file_name TEXT");
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
    if (!taskColumns.has("image_prepare_state")) this.db.exec("ALTER TABLE tasks ADD COLUMN image_prepare_state TEXT NOT NULL DEFAULT 'idle'");
    if (!taskColumns.has("image_prepare_step")) this.db.exec("ALTER TABLE tasks ADD COLUMN image_prepare_step TEXT NOT NULL DEFAULT ''");
    if (!taskColumns.has("image_prepare_message")) this.db.exec("ALTER TABLE tasks ADD COLUMN image_prepare_message TEXT");
    if (!taskColumns.has("video_prepare_state")) this.db.exec("ALTER TABLE tasks ADD COLUMN video_prepare_state TEXT NOT NULL DEFAULT 'idle'");
    if (!taskColumns.has("video_prepare_step")) this.db.exec("ALTER TABLE tasks ADD COLUMN video_prepare_step TEXT NOT NULL DEFAULT ''");
    if (!taskColumns.has("video_prepare_message")) this.db.exec("ALTER TABLE tasks ADD COLUMN video_prepare_message TEXT");
    this.db.exec(`
      UPDATE tasks
      SET first_frame_source = CASE
        WHEN image_prompt != '' THEN 'generated'
        WHEN image_path IS NOT NULL AND image_path != '' THEN 'local'
        ELSE 'none'
      END
      WHERE first_frame_source IS NULL OR first_frame_source = 'none'
    `);
    this.db.exec(`
      UPDATE tasks SET
        image_generation_count = COALESCE((SELECT MAX(generation_index) FROM media_candidates WHERE task_id = tasks.id AND kind = 'image'), 0),
        video_generation_count = COALESCE((SELECT MAX(generation_index) FROM media_candidates WHERE task_id = tasks.id AND kind = 'video'), 0)
    `);

    const projectStyleColumns = new Set(
      (this.db.prepare("PRAGMA table_info(project_styles)").all() as DbRow[]).map((row) => String(row.name))
    );
    if (!projectStyleColumns.has("global_prompt")) {
      this.db.exec("ALTER TABLE project_styles ADD COLUMN global_prompt TEXT NOT NULL DEFAULT ''");
    }
    if (!projectStyleColumns.has("image_global_prompt")) {
      this.db.exec("ALTER TABLE project_styles ADD COLUMN image_global_prompt TEXT NOT NULL DEFAULT ''");
    }
    if (!projectStyleColumns.has("video_global_prompt")) {
      this.db.exec("ALTER TABLE project_styles ADD COLUMN video_global_prompt TEXT NOT NULL DEFAULT ''");
    }
    if (!projectStyleColumns.has("legacy_migration_pending")) {
      this.db.exec("ALTER TABLE project_styles ADD COLUMN legacy_migration_pending INTEGER NOT NULL DEFAULT 0");
    }
    if (!projectStyleColumns.has("character_reference_paths_json")) {
      this.db.exec("ALTER TABLE project_styles ADD COLUMN character_reference_paths_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!projectStyleColumns.has("character_reference_hashes_json")) {
      this.db.exec("ALTER TABLE project_styles ADD COLUMN character_reference_hashes_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!projectStyleColumns.has("character_reference_names_json")) {
      this.db.exec("ALTER TABLE project_styles ADD COLUMN character_reference_names_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!projectStyleColumns.has("scene_reference_name")) this.db.exec("ALTER TABLE project_styles ADD COLUMN scene_reference_name TEXT");
    if (!projectStyleColumns.has("style_reference_name")) this.db.exec("ALTER TABLE project_styles ADD COLUMN style_reference_name TEXT");
    if (!projectStyleColumns.has("output_directory")) this.db.exec("ALTER TABLE project_styles ADD COLUMN output_directory TEXT");
    this.db.exec(`
      UPDATE project_styles
      SET character_reference_paths_json = json_array(character_reference_path)
      WHERE character_reference_path IS NOT NULL AND character_reference_path != ''
        AND character_reference_paths_json = '[]'
    `);
    this.createLegacyStyleDrafts();
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("maxActiveWorkers", "2");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("automationEnabled", "false");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)").run("autoClickGenerate", "false");
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
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as DbRow[]).map((row) => this.enrichTask(rowToTask(row)));
  }

  getTask(id: string): TaskRecord {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) throw new Error("任务不存在");
    return this.enrichTask(rowToTask(row));
  }

  private enrichTask(task: TaskRecord): TaskRecord {
    const candidates = this.listTaskCandidates(task.id);
    return {
      ...task,
      imageCandidates: candidates.filter((item) => item.kind === "image"),
      videoCandidates: candidates.filter((item) => item.kind === "video")
    };
  }

  listTaskCandidates(taskId: string): MediaCandidate[] {
    return (this.db.prepare(`
      SELECT * FROM media_candidates WHERE task_id = ?
      ORDER BY generation_index DESC, candidate_index ASC
    `).all(taskId) as DbRow[]).map(rowToMediaCandidate);
  }

  nextGenerationIndex(taskId: string, kind: MediaCandidateKind) {
    this.getTask(taskId);
    const row = this.db.prepare("SELECT MAX(generation_index) AS max_index FROM media_candidates WHERE task_id = ? AND kind = ?")
      .get(taskId, kind) as DbRow;
    return Math.max(1, Number(row.max_index || 0) + 1);
  }

  generationTarget(taskId: string, kind: MediaCandidateKind, accountLabel: string) {
    const task = this.getTask(taskId);
    const generationIndex = this.nextGenerationIndex(taskId, kind);
    const project = safeFilePart(task.projectName || "未命名项目");
    const shot = String(task.shotNumber).padStart(2, "0");
    const projectRoot = this.getProjectStyle(task.projectName)?.outputDirectory
      || path.join(this.dataDir, "projects", project);
    const folder = path.join(projectRoot, kind === "image" ? "分镜图" : "视频");
    mkdirSync(folder, { recursive: true });
    const baseName = kind === "image"
      ? `${project}_分镜${shot}_第${generationIndex}次`
      : `${project}_分镜${shot}_${safeFilePart(accountLabel).replace(/\s+/g, "")}_第${generationIndex}次`;
    return { folder, baseName, generationIndex };
  }

  addTaskCandidates(
    taskId: string,
    kind: MediaCandidateKind,
    generationIndex: number,
    items: Array<{ sourceUrl: string; filePath: string; hasWatermark?: boolean }>
  ) {
    this.getTask(taskId);
    const insert = this.db.prepare(`
      INSERT INTO media_candidates(id, task_id, kind, generation_index, candidate_index, source_url, file_path, review_status, has_watermark, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    items.forEach((item, index) => insert.run(
      randomUUID(), taskId, kind, generationIndex, index + 1, item.sourceUrl, item.filePath, item.hasWatermark ? 1 : 0, now()
    ));
    const countColumn = kind === "image" ? "image_generation_count" : "video_generation_count";
    this.db.prepare(`UPDATE tasks SET ${countColumn} = MAX(${countColumn}, ?), updated_at = ? WHERE id = ?`)
      .run(generationIndex, now(), taskId);
    return this.getTask(taskId);
  }

  approveImageCandidate(candidateId: string) {
    const candidate = this.getCandidate(candidateId);
    if (candidate.kind !== "image") throw new Error("请选择分镜图候选");
    const task = this.getTask(candidate.taskId);
    const managedPath = this.storeManagedImage(candidate.filePath);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE media_candidates SET review_status = CASE WHEN id = ? THEN 'approved' ELSE CASE WHEN kind = 'image' THEN 'rejected' ELSE review_status END END WHERE task_id = ?")
        .run(candidateId, task.id);
      this.db.prepare(`
        UPDATE tasks SET image_path = ?, first_frame_file_name = ?, image_status = 'approved',
          image_prepare_state = 'ready', image_prepare_step = '首帧已锁定', image_prepare_message = NULL,
          video_prepare_state = 'idle', video_prepare_step = '', video_prepare_message = NULL, updated_at = ? WHERE id = ?
      `).run(managedPath, path.basename(candidate.filePath), now(), task.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(task.id);
  }

  reviewVideoCandidate(candidateId: string, approved: boolean) {
    const candidate = this.getCandidate(candidateId);
    if (candidate.kind !== "video") throw new Error("请选择视频候选");
    let filePath = candidate.filePath;
    if (!approved) {
      const rejectedDir = path.join(path.dirname(candidate.filePath), "作废");
      mkdirSync(rejectedDir, { recursive: true });
      const target = uniqueTargetPath(path.join(rejectedDir, path.basename(candidate.filePath)));
      if (existsSync(candidate.filePath)) renameSync(candidate.filePath, target);
      filePath = target;
    }
    this.db.prepare("UPDATE media_candidates SET review_status = ?, file_path = ? WHERE id = ?")
      .run(approved ? "approved" : "rejected", filePath, candidateId);
    const approvedCandidate = this.db.prepare(`
      SELECT file_path FROM media_candidates
      WHERE task_id = ? AND kind = 'video' AND review_status = 'approved'
      ORDER BY generation_index DESC LIMIT 1
    `).get(candidate.taskId) as DbRow | undefined;
    const hasApproved = Boolean(approvedCandidate);
    const status = hasApproved ? "succeeded" : "queued";
    const resultPath = approvedCandidate?.file_path ? String(approvedCandidate.file_path) : null;
    const step = approved ? "已通过" : hasApproved ? "已通过（本次候选已作废）" : "已作废";
    this.db.prepare(`
      UPDATE tasks SET status = ?, result_path = ?, error_message = NULL,
        video_prepare_state = 'ready', video_prepare_step = ?, video_prepare_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(status, resultPath, step, now(), candidate.taskId);
    return this.getTask(candidate.taskId);
  }

  candidateFilePath(candidateId: string) {
    return this.getCandidate(candidateId).filePath;
  }

  importVideoCandidate(taskId: string, sourcePath: string, accountLabel: string) {
    if (!existsSync(sourcePath)) throw new Error("选择的视频文件不存在");
    if (path.extname(sourcePath).toLowerCase() !== ".mp4") throw new Error("目前只支持导入 MP4 视频");
    const target = this.generationTarget(taskId, "video", accountLabel);
    const filePath = uniqueTargetPath(path.join(target.folder, `${target.baseName}.mp4`));
    if (path.normalize(path.resolve(sourcePath)) !== path.normalize(path.resolve(filePath))) copyFileSync(sourcePath, filePath);
    this.addTaskCandidates(taskId, "video", target.generationIndex, [{ sourceUrl: "manual-import", filePath, hasWatermark: false }]);
    this.db.prepare(`
      UPDATE tasks SET status = 'review', error_message = NULL,
        video_prepare_state = 'ready', video_prepare_step = '已导入视频候选', video_prepare_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(now(), taskId);
    return this.getTask(taskId);
  }

  importImageCandidate(taskId: string, sourcePath: string) {
    const task = this.getTask(taskId);
    if (task.firstFrameSource !== "generated") throw new Error("只有提示词生成的首帧才能导入分镜图候选");
    if (!existsSync(sourcePath)) throw new Error("选择的图片文件不存在");
    const extension = path.extname(sourcePath).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new Error("仅支持 PNG、JPG、JPEG 或 WebP 图片");
    const target = this.generationTarget(taskId, "image", "");
    const filePath = uniqueTargetPath(path.join(target.folder, `${target.baseName}_候选1${extension}`));
    if (path.normalize(path.resolve(sourcePath)) !== path.normalize(path.resolve(filePath))) copyFileSync(sourcePath, filePath);
    this.addTaskCandidates(taskId, "image", target.generationIndex, [{ sourceUrl: "manual-import", filePath, hasWatermark: false }]);
    this.db.prepare(`
      UPDATE tasks SET image_status = 'ready',
        image_prepare_state = 'ready', image_prepare_step = '已导入分镜图候选',
        image_prepare_message = '已锁定的首帧仍保留；审核通过新候选后才会替换。', updated_at = ?
      WHERE id = ?
    `).run(now(), taskId);
    return this.getTask(taskId);
  }

  restoreLockedImageState(taskId: string, step = "继续使用已锁定首帧") {
    const task = this.getTask(taskId);
    const status: ImageTaskStatus = task.imagePath
      ? "approved"
      : task.imageCandidates.some((candidate) => candidate.reviewStatus === "pending")
        ? "ready"
        : task.firstFrameSource === "none"
          ? "skipped"
          : "pending";
    this.db.prepare(`
      UPDATE tasks SET image_status = ?, image_prepare_state = 'ready', image_prepare_step = ?,
        image_prepare_message = NULL, updated_at = ? WHERE id = ?
    `).run(status, step, now(), taskId);
    return this.getTask(taskId);
  }

  private getCandidate(id: string): MediaCandidate {
    const row = this.db.prepare("SELECT * FROM media_candidates WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) throw new Error("候选素材不存在");
    return rowToMediaCandidate(row);
  }

  createTask(input: TaskInput): TaskRecord {
    const normalized = this.validateTaskInput(input);
    const id = randomUUID();
    const createdAt = now();
    const imagePath = normalized.sourceImagePath ? this.storeManagedImage(normalized.sourceImagePath) : null;
    const imageStatus = initialImageStatus(normalized.firstFrameSource, imagePath);
    this.db.prepare(`
      INSERT INTO tasks(
        id, project_name, shot_number, shot_name, narration, notes, generation_count, first_frame_source, first_frame_file_name,
        image_prompt, image_account_id, image_status, image_path,
        account_id, prompt, model, model_source, duration, duration_source, aspect_ratio, aspect_ratio_source, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      id,
      normalized.projectName,
      normalized.shotNumber,
      normalized.shotName ?? "",
      normalized.narration ?? "",
      normalized.notes ?? "",
      normalized.generationCount ?? 1,
      normalized.firstFrameSource,
      normalized.firstFrameFileName ?? null,
      normalized.imagePrompt,
      normalized.imageAccountId,
      imageStatus,
      imagePath,
      normalized.accountId,
      normalized.prompt,
      normalized.model,
      normalized.modelSource ?? "shot",
      normalized.duration,
      normalized.durationSource ?? "shot",
      normalized.aspectRatio,
      normalized.aspectRatioSource ?? "shot",
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
    const previous = this.getTask(id);
    const normalized = this.validateTaskInput(input);
    const sourceChanged = previous.firstFrameSource !== normalized.firstFrameSource;
    const promptChanged = previous.imagePrompt !== normalized.imagePrompt;
    let imagePath = previous.imagePath;
    if (normalized.sourceImagePath) imagePath = this.storeManagedImage(normalized.sourceImagePath);
    else if (normalized.firstFrameSource === "none" || sourceChanged || (normalized.firstFrameSource === "generated" && promptChanged)) {
      imagePath = null;
    }
    const imageStatus = normalized.firstFrameSource === "none"
      ? "skipped"
      : imagePath
        ? "approved"
        : sourceChanged || promptChanged
          ? "pending"
          : previous.imageStatus;
    this.db.prepare(`
      UPDATE tasks
      SET project_name = ?, shot_number = ?, shot_name = ?, narration = ?, notes = ?, generation_count = ?, first_frame_source = ?, first_frame_file_name = ?,
          image_prompt = ?, image_account_id = ?, image_status = ?, image_path = ?,
          account_id = ?, prompt = ?, model = ?, model_source = ?, duration = ?, duration_source = ?, aspect_ratio = ?, aspect_ratio_source = ?,
          image_prepare_state = 'idle', image_prepare_step = '', image_prepare_message = NULL,
          video_prepare_state = 'idle', video_prepare_step = '', video_prepare_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      normalized.projectName,
      normalized.shotNumber,
      normalized.shotName ?? "",
      normalized.narration ?? "",
      normalized.notes ?? "",
      normalized.generationCount ?? 1,
      normalized.firstFrameSource,
      normalized.firstFrameFileName ?? null,
      normalized.imagePrompt,
      normalized.imageAccountId,
      imageStatus,
      imagePath,
      normalized.accountId,
      normalized.prompt,
      normalized.model,
      normalized.modelSource ?? "shot",
      normalized.duration,
      normalized.durationSource ?? "shot",
      normalized.aspectRatio,
      normalized.aspectRatioSource ?? "shot",
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
      shotName: source.shotName,
      narration: source.narration,
      notes: source.notes,
      generationCount: source.generationCount,
      firstFrameSource: source.firstFrameSource,
      firstFrameFileName: source.firstFrameFileName,
      sourceImagePath: source.imagePath,
      imagePrompt: source.imagePrompt,
      imageAccountId: source.imageAccountId,
      accountId: source.accountId,
      prompt: source.prompt,
      model: source.model,
      modelSource: source.modelSource,
      duration: source.duration,
      durationSource: source.durationSource,
      aspectRatio: source.aspectRatio,
      aspectRatioSource: source.aspectRatioSource
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

  setTaskPreparation(
    id: string,
    stage: "image" | "video",
    state: PreparationState,
    step: string,
    message: string | null = null
  ): TaskRecord {
    this.getTask(id);
    const prefix = stage === "image" ? "image" : "video";
    this.db.prepare(`
      UPDATE tasks
      SET ${prefix}_prepare_state = ?, ${prefix}_prepare_step = ?, ${prefix}_prepare_message = ?, updated_at = ?
      WHERE id = ?
    `).run(state, step.trim(), message, now(), id);
    return this.getTask(id);
  }

  setTaskImageStatus(id: string, status: ImageTaskStatus): TaskRecord {
    const previous = this.getTask(id);
    if (previous.firstFrameSource === "none" && status !== "skipped") throw new Error("这个分镜没有首帧");
    if (previous.firstFrameSource === "generated" && !previous.imagePrompt && status !== "skipped") {
      throw new Error("这个分镜没有生图提示词");
    }
    if (status === "approved" && !previous.imagePath) throw new Error("请先选择实际首帧图片，再通过审核");
    this.db.prepare("UPDATE tasks SET image_status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    if (status === "submitted" && ["pending", "preparing", "failed"].includes(previous.imageStatus) && previous.imageAccountId) {
      this.incrementUsage(previous.imageAccountId, "image");
    }
    return this.getTask(id);
  }

  setTaskImage(id: string, imagePath: string, inferredAspectRatio?: string): TaskRecord {
    const previous = this.getTask(id);
    const managedPath = this.storeManagedImage(imagePath);
    const source: FirstFrameSource = previous.firstFrameSource === "none" ? "local" : previous.firstFrameSource;
    const followFirstFrame = Boolean(inferredAspectRatio && ["default", "first_frame"].includes(previous.aspectRatioSource));
    const nextAspectRatio = followFirstFrame && inferredAspectRatio ? inferredAspectRatio : previous.aspectRatio;
    this.db.prepare(`
      UPDATE tasks
      SET first_frame_source = ?, first_frame_file_name = ?, image_path = ?, image_status = 'approved',
          aspect_ratio = ?, aspect_ratio_source = ?,
          video_prepare_state = 'idle', video_prepare_step = '', video_prepare_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      source, path.basename(imagePath), managedPath,
      nextAspectRatio,
      followFirstFrame ? "first_frame" : previous.aspectRatioSource,
      now(), id
    );
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
    const characterReferences = dedupeReferences(input.characterReferencePaths.map((sourcePath, index) => ({
      ...this.storeManagedProjectReference(sourcePath),
      name: input.characterReferenceNames?.[index] || path.basename(sourcePath)
    })));
    const outputDirectory = input.outputDirectory ? path.resolve(input.outputDirectory) : null;
    if (outputDirectory) mkdirSync(outputDirectory, { recursive: true });
    const updatedAt = now();
    this.db.prepare(`
      INSERT INTO project_styles(
        project_name, global_prompt, image_global_prompt, video_global_prompt, legacy_migration_pending,
        style_prompt, character_prompt, scene_prompt, continuity_prompt, negative_prompt,
        character_reference_path, character_reference_paths_json, character_reference_hashes_json, character_reference_names_json,
        scene_reference_path, scene_reference_name, style_reference_path, style_reference_name, output_directory,
        locked_model, locked_aspect_ratio, updated_at
      ) VALUES (?, ?, ?, ?, 0, '', '', '', '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_name) DO UPDATE SET
        global_prompt = excluded.global_prompt,
        image_global_prompt = excluded.image_global_prompt,
        video_global_prompt = excluded.video_global_prompt,
        legacy_migration_pending = 0,
        style_prompt = '',
        character_prompt = '',
        scene_prompt = '',
        continuity_prompt = '',
        negative_prompt = '',
        character_reference_path = excluded.character_reference_path,
        character_reference_paths_json = excluded.character_reference_paths_json,
        character_reference_hashes_json = excluded.character_reference_hashes_json,
        character_reference_names_json = excluded.character_reference_names_json,
        scene_reference_path = excluded.scene_reference_path,
        scene_reference_name = excluded.scene_reference_name,
        style_reference_path = excluded.style_reference_path,
        style_reference_name = excluded.style_reference_name,
        output_directory = excluded.output_directory,
        locked_model = excluded.locked_model,
        locked_aspect_ratio = excluded.locked_aspect_ratio,
        updated_at = excluded.updated_at
    `).run(
      projectName,
      input.globalPrompt.trim(),
      input.imageGlobalPrompt.trim(),
      input.videoGlobalPrompt.trim(),
      characterReferences[0]?.path || null,
      JSON.stringify(characterReferences.map((item) => item.path)),
      JSON.stringify(characterReferences.map((item) => item.hash)),
      JSON.stringify(characterReferences.map((item) => item.name)),
      input.sceneReferencePath || null,
      input.sceneReferenceName || (input.sceneReferencePath ? path.basename(input.sceneReferencePath) : null),
      input.styleReferencePath || null,
      input.styleReferenceName || (input.styleReferencePath ? path.basename(input.styleReferencePath) : null),
      outputDirectory,
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
      SET model = CASE WHEN ? IS NOT NULL AND model_source != 'shot' THEN ? ELSE model END,
          model_source = CASE WHEN ? IS NOT NULL AND model_source != 'shot' THEN 'project' ELSE model_source END,
          aspect_ratio = CASE WHEN ? IS NOT NULL AND aspect_ratio_source != 'shot' THEN ? ELSE aspect_ratio END,
          aspect_ratio_source = CASE WHEN ? IS NOT NULL AND aspect_ratio_source != 'shot' THEN 'project' ELSE aspect_ratio_source END,
          duration = CASE
            WHEN ? IS NOT NULL AND ? != 'Seedance 2.5' AND model_source != 'shot' AND duration > 15 THEN 15
            ELSE duration
          END,
          duration_source = CASE
            WHEN ? IS NOT NULL AND ? != 'Seedance 2.5' AND model_source != 'shot' AND duration > 15 THEN 'project'
            ELSE duration_source
          END,
          updated_at = ?
      WHERE project_name = ?
    `).run(
      profile.lockedModel,
      profile.lockedModel,
      profile.lockedModel,
      profile.lockedAspectRatio,
      profile.lockedAspectRatio,
      profile.lockedAspectRatio,
      profile.lockedModel,
      profile.lockedModel,
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
      autoClickGenerate: values.autoClickGenerate === "true",
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
    if (input.autoClickGenerate !== undefined) {
      this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('autoClickGenerate', ?)")
        .run(String(Boolean(input.autoClickGenerate)));
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

  private validateTaskInput(input: TaskInput): TaskInput & { firstFrameSource: FirstFrameSource } {
    const prompt = input.prompt.trim();
    const imagePrompt = input.imagePrompt.trim();
    const firstFrameSource = normalizeFirstFrameSource(input.firstFrameSource, imagePrompt, input.sourceImagePath);
    if (!prompt) throw new Error("分镜视频提示词不能为空");
    if (firstFrameSource === "generated" && !imagePrompt) throw new Error("提示词生成首帧必须填写分镜图提示词");
    if (firstFrameSource === "none" && imagePrompt) throw new Error("纯文生视频不能同时填写分镜图提示词");
    if (firstFrameSource === "local" && imagePrompt) throw new Error("本地首帧不能同时填写分镜图提示词");
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
      shotName: input.shotName?.trim() || "",
      narration: input.narration?.trim() || "",
      notes: input.notes?.trim() || "",
      generationCount: Math.min(20, Math.max(1, Math.round(Number(input.generationCount) || 1))),
      modelSource: input.modelSource ?? "shot",
      durationSource: input.durationSource ?? "shot",
      aspectRatioSource: input.aspectRatioSource ?? "shot",
      firstFrameSource,
      firstFrameFileName: input.firstFrameFileName?.trim() || null,
      sourceImagePath: input.sourceImagePath || null,
      imagePrompt,
      prompt,
      duration
    };
  }

  close() {
    this.db.close();
  }

  private createLegacyStyleDrafts() {
    const rows = this.db.prepare(`
      SELECT * FROM project_styles
      WHERE legacy_migration_pending = 0
        AND global_prompt = '' AND image_global_prompt = '' AND video_global_prompt = ''
        AND (style_prompt != '' OR character_prompt != '' OR scene_prompt != '' OR continuity_prompt != '' OR negative_prompt != '')
    `).all() as DbRow[];
    const update = this.db.prepare(`
      UPDATE project_styles
      SET image_global_prompt = ?, video_global_prompt = ?, legacy_migration_pending = 1
      WHERE project_name = ?
    `);
    for (const row of rows) {
      const imageDraft = legacySections([
        ["项目固定风格", row.style_prompt],
        ["固定角色", row.character_prompt],
        ["固定场景", row.scene_prompt],
        ["禁止项", row.negative_prompt]
      ]);
      const videoDraft = legacySections([
        ["连续性约束", row.continuity_prompt],
        ["禁止项", row.negative_prompt]
      ]);
      update.run(imageDraft, videoDraft, String(row.project_name));
    }
  }

  private storeManagedImage(sourcePath: string) {
    const resolved = path.resolve(sourcePath);
    if (!existsSync(resolved)) throw new Error(`首帧图片不存在：${sourcePath}`);
    const bytes = readFileSync(resolved);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const extension = path.extname(resolved).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new Error("首帧图片格式不支持");
    const targetDir = path.join(this.dataDir, "assets", "first-frames");
    mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `${hash}${extension === ".jpeg" ? ".jpg" : extension}`);
    if (!existsSync(target)) copyFileSync(resolved, target);
    return target;
  }

  private storeManagedProjectReference(sourcePath: string) {
    const resolved = path.resolve(sourcePath);
    if (!existsSync(resolved)) throw new Error(`角色参考图不存在：${sourcePath}`);
    const bytes = readFileSync(resolved);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const extension = path.extname(resolved).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new Error("角色参考图格式不支持");
    const targetDir = path.join(this.dataDir, "assets", "project-references");
    mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `${hash}${extension === ".jpeg" ? ".jpg" : extension}`);
    if (!existsSync(target) && path.normalize(resolved) !== path.normalize(target)) copyFileSync(resolved, target);
    return { path: target, hash };
  }
}

function dedupeReferences(references: Array<{ path: string; hash: string; name: string }>) {
  const seen = new Set<string>();
  return references.filter((item) => {
    if (seen.has(item.hash)) return false;
    seen.add(item.hash);
    return true;
  });
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

function normalizeFirstFrameSource(
  value: FirstFrameSource | undefined,
  imagePrompt: string,
  sourceImagePath?: string | null
): FirstFrameSource {
  if (value && ["local", "generated", "none"].includes(value)) return value;
  if (sourceImagePath) return "local";
  if (imagePrompt) return "generated";
  return "none";
}

function initialImageStatus(source: FirstFrameSource | undefined, imagePath: string | null): ImageTaskStatus {
  if (source === "none") return "skipped";
  if (imagePath) return "approved";
  return "pending";
}

function legacySections(sections: Array<[string, string | number | null | undefined]>) {
  return sections
    .map(([title, value]) => [title, value == null ? "" : String(value).trim()] as const)
    .filter(([, value]) => value)
    .map(([title, value]) => `【${title}】\n${value}`)
    .join("\n\n");
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
    shotName: String(row.shot_name || ""),
    narration: String(row.narration || ""),
    notes: String(row.notes || ""),
    generationCount: Math.min(20, Math.max(1, Number(row.generation_count) || 1)),
    imageGenerationCount: Math.max(0, Number(row.image_generation_count) || 0),
    videoGenerationCount: Math.max(0, Number(row.video_generation_count) || 0),
    firstFrameSource: String(row.first_frame_source || (row.image_prompt ? "generated" : row.image_path ? "local" : "none")) as FirstFrameSource,
    firstFrameFileName: row.first_frame_file_name ? String(row.first_frame_file_name) : null,
    imagePrompt: row.image_prompt ? String(row.image_prompt) : "",
    imageAccountId: row.image_account_id ? String(row.image_account_id) : null,
    imageStatus: String(row.image_status || (row.image_prompt ? "pending" : "skipped")) as ImageTaskStatus,
    imagePath: row.image_path ? String(row.image_path) : null,
    accountId: row.account_id ? String(row.account_id) : null,
    prompt: String(row.prompt),
    model: String(row.model),
    modelSource: String(row.model_source || "shot") as TaskRecord["modelSource"],
    duration: Number(row.duration),
    durationSource: String(row.duration_source || "shot") as TaskRecord["durationSource"],
    aspectRatio: String(row.aspect_ratio),
    aspectRatioSource: String(row.aspect_ratio_source || "shot") as TaskRecord["aspectRatioSource"],
    status: String(row.status) as TaskStatus,
    resultUrl: row.result_url ? String(row.result_url) : null,
    resultPath: row.result_path ? String(row.result_path) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    imagePrepareState: String(row.image_prepare_state || "idle") as PreparationState,
    imagePrepareStep: String(row.image_prepare_step || ""),
    imagePrepareMessage: row.image_prepare_message ? String(row.image_prepare_message) : null,
    videoPrepareState: String(row.video_prepare_state || "idle") as PreparationState,
    videoPrepareStep: String(row.video_prepare_step || ""),
    videoPrepareMessage: row.video_prepare_message ? String(row.video_prepare_message) : null,
    imageCandidates: [],
    videoCandidates: [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToMediaCandidate(row: DbRow): MediaCandidate {
  const filePath = String(row.file_path);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind: String(row.kind) as MediaCandidateKind,
    generationIndex: Math.max(1, Number(row.generation_index) || 1),
    candidateIndex: Math.max(1, Number(row.candidate_index) || 1),
    sourceUrl: String(row.source_url || ""),
    filePath,
    previewUrl: pathToFileURL(filePath).href,
    reviewStatus: String(row.review_status || "pending") as MediaCandidate["reviewStatus"],
    hasWatermark: Boolean(Number(row.has_watermark || 0)),
    createdAt: String(row.created_at)
  };
}

function safeFilePart(value: string) {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  return (normalized || "未命名").slice(0, 80);
}

function uniqueTargetPath(target: string) {
  if (!existsSync(target)) return target;
  const extension = path.extname(target);
  const stem = target.slice(0, -extension.length);
  let index = 2;
  while (existsSync(`${stem}_${index}${extension}`)) index += 1;
  return `${stem}_${index}${extension}`;
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
  const legacyPath = row.character_reference_path ? String(row.character_reference_path) : null;
  const paths = parseStringArray(row.character_reference_paths_json);
  const hashes = parseStringArray(row.character_reference_hashes_json);
  const names = parseStringArray(row.character_reference_names_json);
  return {
    projectName: String(row.project_name),
    globalPrompt: String(row.global_prompt || ""),
    imageGlobalPrompt: String(row.image_global_prompt || ""),
    videoGlobalPrompt: String(row.video_global_prompt || ""),
    migrationPending: Boolean(Number(row.legacy_migration_pending || 0)),
    characterReferencePaths: paths.length ? paths : legacyPath ? [legacyPath] : [],
    characterReferenceHashes: hashes,
    characterReferenceNames: names.length ? names : (paths.length ? paths.map(() => "") : []),
    sceneReferencePath: row.scene_reference_path ? String(row.scene_reference_path) : null,
    sceneReferenceName: row.scene_reference_name ? String(row.scene_reference_name) : null,
    styleReferencePath: row.style_reference_path ? String(row.style_reference_path) : null,
    styleReferenceName: row.style_reference_name ? String(row.style_reference_name) : null,
    outputDirectory: row.output_directory ? String(row.output_directory) : null,
    lockedModel: row.locked_model ? String(row.locked_model) : null,
    lockedAspectRatio: row.locked_aspect_ratio ? String(row.locked_aspect_ratio) : null,
    updatedAt: String(row.updated_at)
  };
}

function parseStringArray(value: string | number | null | undefined) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
  } catch {
    return [];
  }
}
