import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StudioDatabase } from "../electron/database";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createDatabase() {
  const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-"));
  tempDirs.push(dir);
  return new StudioDatabase(dir);
}

describe("StudioDatabase", () => {
  it("creates isolated account partitions", () => {
    const db = createDatabase();
    const first = db.createAccount("主账号");
    const second = db.createAccount("副账号");
    expect(first.partition).not.toBe(second.partition);
    expect(first.partition).toMatch(/^persist:doubao-/);
    db.close();
  });

  it("prevents one Doubao identity from being assigned twice", () => {
    const db = createDatabase();
    const first = db.createAccount("主账号");
    const second = db.createAccount("重复账号");
    db.updateIdentity(first.id, { userId: "same-user" });
    expect(() => db.updateIdentity(second.id, { userId: "same-user" })).toThrow(/已经添加/);
    db.close();
  });

  it("updates a local account label without changing its partition", () => {
    const db = createDatabase();
    const account = db.createAccount("原备注");
    const renamed = db.renameAccount(account.id, "新备注");
    expect(renamed.label).toBe("新备注");
    expect(renamed.partition).toBe(account.partition);
    db.close();
  });

  it("clamps worker concurrency to a memory-safe range", () => {
    const db = createDatabase();
    expect(db.updateSettings({ maxActiveWorkers: 20 }).maxActiveWorkers).toBe(3);
    expect(db.updateSettings({ maxActiveWorkers: 0 }).maxActiveWorkers).toBe(1);
    db.close();
  });

  it("creates, edits, duplicates and removes storyboard tasks", () => {
    const db = createDatabase();
    const account = db.createAccount("创作账号");
    const created = db.createTask({
      projectName: "秋日短片",
      shotNumber: 1,
      imagePrompt: "一片金色树林，静态电影感构图",
      imageAccountId: account.id,
      accountId: account.id,
      prompt: "树叶随风飘落",
      model: "Seedance 2.0 mini",
      duration: 10,
      aspectRatio: "9:16"
    });
    const updated = db.updateTask(created.id, { ...created, prompt: "金色树叶随风飘落" });
    const duplicated = db.duplicateTask(created.id);

    expect(updated.prompt).toBe("金色树叶随风飘落");
    expect(updated.imageStatus).toBe("pending");
    expect(duplicated.projectName).toBe("秋日短片");
    expect(duplicated.shotNumber).toBe(2);
    db.deleteTask(created.id);
    expect(db.listTasks().map((task) => task.id)).toEqual([duplicated.id]);
    db.close();
  });

  it("remembers the last-used task settings", () => {
    const db = createDatabase();
    const account = db.createAccount("常用账号");
    const settings = db.updateSettings({
      lastTaskAccountId: account.id,
      lastVideoModel: "Seedance 2.0 mini",
      lastVideoDuration: 8,
      lastAspectRatio: "16:9"
    });

    expect(settings.lastTaskAccountId).toBe(account.id);
    expect(settings.lastVideoDuration).toBe(8);
    expect(settings.lastAspectRatio).toBe("16:9");
    db.close();
  });

  it("migrates legacy tasks without losing them", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-legacy-"));
    tempDirs.push(dir);
    const legacy = new DatabaseSync(path.join(dir, "studio.sqlite"));
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT,
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
      INSERT INTO tasks(id, prompt, model, duration, aspect_ratio, status, created_at, updated_at)
      VALUES ('legacy-task', '旧提示词', 'Seedance', 10, '9:16', 'queued', '2026-01-01', '2026-01-01');
    `);
    legacy.close();

    const db = new StudioDatabase(dir);
    const [task] = db.listTasks();
    expect(task.id).toBe("legacy-task");
    expect(task.projectName).toBe("");
    expect(task.shotNumber).toBe(1);
    expect(task.imagePrompt).toBe("");
    expect(task.imageStatus).toBe("skipped");
    db.close();
  });

  it("balances imported image and video work across ready accounts", () => {
    const db = createDatabase();
    const first = db.createAccount("账号 A");
    const second = db.createAccount("账号 B");
    db.updateIdentity(first.id, { userId: "user-a" });
    db.updateIdentity(second.id, { userId: "user-b" });
    db.adjustUsage(first.id, "video", 3);
    db.createTasks(Array.from({ length: 4 }, (_, index) => ({
      projectName: "批量短片",
      shotNumber: index + 1,
      imagePrompt: `分镜图 ${index + 1}`,
      imageAccountId: null,
      accountId: null,
      prompt: `分镜视频 ${index + 1}`,
      model: "Seedance 2.0 mini",
      duration: 10,
      aspectRatio: "9:16"
    })));

    const summary = db.autoAssignTasks();
    const tasks = db.listTasks();
    expect(summary).toEqual({ imageAssignments: 4, videoAssignments: 4 });
    expect(new Set(tasks.map((task) => task.imageAccountId))).toEqual(new Set([first.id, second.id]));
    expect(tasks.filter((task) => task.accountId === second.id)).toHaveLength(3);
    expect(tasks.filter((task) => task.accountId === first.id)).toHaveLength(1);
    db.close();
  });

  it("counts a submitted generation once per initial transition", () => {
    const db = createDatabase();
    const account = db.createAccount("额度测试");
    db.updateIdentity(account.id, { userId: "usage-user" });
    const task = db.createTask({
      projectName: "测试",
      shotNumber: 1,
      imagePrompt: "生图",
      imageAccountId: account.id,
      accountId: account.id,
      prompt: "视频",
      model: "Seedance 2.0 mini",
      duration: 10,
      aspectRatio: "9:16"
    });
    db.setTaskImageStatus(task.id, "submitted");
    db.setTaskImageStatus(task.id, "submitted");
    db.setTaskStatus(task.id, "submitted");
    db.setTaskStatus(task.id, "submitted");
    expect(db.listTodayUsage()[0]).toMatchObject({ imageCount: 1, videoCount: 1 });
    db.close();
  });

  it("stores project style profiles and applies locked settings", () => {
    const db = createDatabase();
    const task = db.createTask({
      projectName: "统一风格短片",
      shotNumber: 1,
      imagePrompt: "室内人物静帧",
      imageAccountId: null,
      accountId: null,
      prompt: "人物转头",
      model: "Seedance 2.5",
      duration: 20,
      aspectRatio: "16:9"
    });
    const profile = db.saveProjectStyle({
      projectName: "统一风格短片",
      globalPrompt: "低饱和写实电影风格",
      imageGlobalPrompt: "保持宠物定妆与室内布局一致",
      videoGlobalPrompt: "光线方向连续，禁止换装",
      migrationPending: false,
      characterReferencePath: "C:\\refs\\character.png",
      sceneReferencePath: null,
      styleReferencePath: null,
      lockedModel: "Seedance 2.0 mini",
      lockedAspectRatio: "9:16"
    });

    expect(profile.globalPrompt).toBe("低饱和写实电影风格");
    expect(db.applyProjectLocks(profile.projectName)).toBe(1);
    expect(db.getTask(task.id)).toMatchObject({
      model: "Seedance 2.0 mini",
      duration: 15,
      aspectRatio: "9:16"
    });
    db.close();
  });

  it("copies a local first frame into managed storage and locks it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-local-frame-"));
    tempDirs.push(dir);
    const source = path.join(dir, "01.png");
    writeFileSync(source, "fake image bytes");
    const db = new StudioDatabase(path.join(dir, "data"));
    const task = db.createTask({
      projectName: "本地首帧",
      shotNumber: 1,
      firstFrameSource: "local",
      firstFrameFileName: "01.png",
      sourceImagePath: source,
      imagePrompt: "",
      imageAccountId: null,
      accountId: null,
      prompt: "小狗抬头",
      model: "Seedance 2.0 mini",
      duration: 10,
      aspectRatio: "9:16"
    });
    expect(task.imageStatus).toBe("approved");
    expect(task.imagePath).not.toBe(source);
    expect(existsSync(task.imagePath!)).toBe(true);
    db.close();
  });

  it("migrates old style fields into inactive global-prompt drafts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-style-migration-"));
    tempDirs.push(dir);
    const legacy = new DatabaseSync(path.join(dir, "studio.sqlite"));
    legacy.exec(`
      CREATE TABLE project_styles (
        project_name TEXT PRIMARY KEY,
        style_prompt TEXT NOT NULL DEFAULT '', character_prompt TEXT NOT NULL DEFAULT '',
        scene_prompt TEXT NOT NULL DEFAULT '', continuity_prompt TEXT NOT NULL DEFAULT '',
        negative_prompt TEXT NOT NULL DEFAULT '', character_reference_path TEXT,
        scene_reference_path TEXT, style_reference_path TEXT, locked_model TEXT,
        locked_aspect_ratio TEXT, updated_at TEXT NOT NULL
      );
      INSERT INTO project_styles VALUES (
        '旧项目', '吉卜力风格', '固定柯基花纹', '', '动作连续', '禁止文字',
        NULL, NULL, NULL, NULL, NULL, '2026-01-01'
      );
    `);
    legacy.close();
    const db = new StudioDatabase(dir);
    const profile = db.getProjectStyle("旧项目")!;
    expect(profile.migrationPending).toBe(true);
    expect(profile.imageGlobalPrompt).toContain("吉卜力风格");
    expect(profile.videoGlobalPrompt).toContain("动作连续");
    db.close();
  });
});
