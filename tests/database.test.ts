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

  it("allows worker concurrency up to the configurable maximum", () => {
    const db = createDatabase();
    expect(db.getSettings().maxActiveWorkers).toBe(3);
    expect(db.updateSettings({ maxActiveWorkers: 20 }).maxActiveWorkers).toBe(20);
    expect(db.updateSettings({ maxActiveWorkers: 21 }).maxActiveWorkers).toBe(20);
    expect(db.updateSettings({ maxActiveWorkers: 0 }).maxActiveWorkers).toBe(1);
    db.close();
  });

  it("persists automatically saved generation settings across restart", () => {
    const db = createDatabase();
    const dir = tempDirs[tempDirs.length - 1];
    db.updateSettings({ maxActiveWorkers: 3, autoClickGenerate: true });
    db.close();

    const reopened = new StudioDatabase(dir);
    expect(reopened.getSettings().maxActiveWorkers).toBe(3);
    expect(reopened.getSettings().autoClickGenerate).toBe(true);
    reopened.close();
  });

  it("creates, edits, duplicates and removes storyboard tasks", () => {
    const db = createDatabase();
    const account = db.createAccount("创作账号");
    const created = db.createTask({
      projectName: "秋日短片",
      shotNumber: 1,
      shotName: "转场",
      narration: "今天去散步",
      notes: "保留鸟叫",
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
    expect(updated.narration).toBe("今天去散步");
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
      lastAspectRatio: "16:9",
      autoClickGenerate: true
    });

    expect(settings.lastTaskAccountId).toBe(account.id);
    expect(settings.lastVideoDuration).toBe(8);
    expect(settings.lastAspectRatio).toBe("16:9");
    expect(settings.autoClickGenerate).toBe(true);
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

  it("persists a video preparation error until a successful retry clears it", () => {
    const db = createDatabase();
    const task = db.createTask({
      projectName: "错误展示",
      shotNumber: 1,
      imagePrompt: "",
      imageAccountId: null,
      accountId: null,
      prompt: "视频提示词",
      model: "Seedance 2.0 mini",
      duration: 6,
      aspectRatio: "16:9"
    });

    expect(db.setTaskStatus(task.id, "failed", "视频准备停在【设置模型、比例和时长】步骤：弹层未打开"))
      .toMatchObject({ status: "failed", errorMessage: expect.stringContaining("设置模型、比例和时长") });
    expect(db.setTaskStatus(task.id, "queued", null)).toMatchObject({ status: "queued", errorMessage: null });
    db.close();
  });

  it("stores project style profiles and applies locked settings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-references-"));
    tempDirs.push(dir);
    const firstReference = path.join(dir, "character-front.png");
    const duplicateReference = path.join(dir, "character-copy.png");
    writeFileSync(firstReference, "same character image");
    writeFileSync(duplicateReference, "same character image");
    const db = new StudioDatabase(path.join(dir, "data"));
    const task = db.createTask({
      projectName: "统一风格短片",
      shotNumber: 1,
      imagePrompt: "室内人物静帧",
      imageAccountId: null,
      accountId: null,
      prompt: "人物转头",
      model: "Seedance 2.5",
      modelSource: "default",
      duration: 20,
      durationSource: "default",
      aspectRatio: "16:9",
      aspectRatioSource: "default"
    });
    const profile = db.saveProjectStyle({
      projectName: "统一风格短片",
      globalPrompt: "低饱和写实电影风格",
      imageGlobalPrompt: "保持宠物定妆与室内布局一致",
      videoGlobalPrompt: "光线方向连续，禁止换装",
      migrationPending: false,
      characterReferencePaths: [firstReference, duplicateReference],
      sceneReferencePath: null,
      styleReferencePath: null,
      lockedModel: "Seedance 2.0 mini",
      lockedAspectRatio: "9:16"
    });

    expect(profile.globalPrompt).toBe("低饱和写实电影风格");
    expect(profile.characterReferencePaths).toHaveLength(1);
    expect(profile.characterReferenceHashes[0]).toHaveLength(64);
    expect(profile.characterReferencePaths[0]).not.toBe(firstReference);
    expect(existsSync(profile.characterReferencePaths[0])).toBe(true);
    expect(db.applyProjectLocks(profile.projectName)).toBe(1);
    expect(db.getTask(task.id)).toMatchObject({
      model: "Seedance 2.0 mini",
      duration: 15,
      aspectRatio: "9:16",
      modelSource: "project",
      durationSource: "project",
      aspectRatioSource: "project"
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

  it("persists image and video preparation progress on the task", () => {
    const db = createDatabase();
    const task = db.createTask({
      projectName: "进度测试",
      shotNumber: 1,
      imagePrompt: "柯基静帧",
      imageAccountId: null,
      accountId: null,
      prompt: "柯基转头",
      model: "Seedance 2.0 mini",
      duration: 6,
      aspectRatio: "16:9"
    });
    expect(db.setTaskPreparation(task.id, "image", "running", "设置图片比例"))
      .toMatchObject({ imagePrepareState: "running", imagePrepareStep: "设置图片比例" });
    expect(db.setTaskPreparation(task.id, "video", "failed", "上传首帧", "没有找到上传控件"))
      .toMatchObject({ videoPrepareState: "failed", videoPrepareStep: "上传首帧", videoPrepareMessage: "没有找到上传控件" });
    db.close();
  });

  it("stores downloaded candidates, locks an approved image and archives a rejected video", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-candidates-"));
    tempDirs.push(dir);
    const db = new StudioDatabase(path.join(dir, "data"));
    const image = path.join(dir, "candidate.png");
    const video = path.join(dir, "candidate.mp4");
    writeFileSync(image, "image bytes");
    writeFileSync(video, "video bytes");
    const task = db.createTask({
      projectName: "候选闭环",
      shotNumber: 3,
      firstFrameSource: "generated",
      imagePrompt: "一只柯基",
      imageAccountId: null,
      accountId: null,
      prompt: "柯基眨眼",
      model: "Seedance 2.0 mini",
      duration: 6,
      aspectRatio: "16:9"
    });
    const withImage = db.addTaskCandidates(task.id, "image", 1, [{ sourceUrl: "https://example/image.png", filePath: image }]);
    expect(withImage.imageGenerationCount).toBe(1);
    expect(withImage.videoGenerationCount).toBe(0);
    const approved = db.approveImageCandidate(withImage.imageCandidates[0].id);
    expect(approved.imageStatus).toBe("approved");
    expect(approved.imageCandidates[0].reviewStatus).toBe("approved");
    expect(existsSync(approved.imagePath!)).toBe(true);

    const withVideo = db.addTaskCandidates(task.id, "video", 1, [{ sourceUrl: "https://example/video.mp4", filePath: video, hasWatermark: true }]);
    expect(withVideo.imageGenerationCount).toBe(1);
    expect(withVideo.videoGenerationCount).toBe(1);
    const rejected = db.reviewVideoCandidate(withVideo.videoCandidates[0].id, false);
    expect(rejected.status).toBe("queued");
    expect(rejected.videoCandidates[0].reviewStatus).toBe("rejected");
    expect(rejected.videoCandidates[0].filePath).toContain("作废");
    expect(existsSync(rejected.videoCandidates[0].filePath)).toBe(true);
    db.close();
  });

  it("imports a generated image as a review candidate without replacing the locked frame", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-import-image-"));
    tempDirs.push(dir);
    const db = new StudioDatabase(path.join(dir, "data"));
    const locked = path.join(dir, "locked.png");
    const imported = path.join(dir, "new.png");
    writeFileSync(locked, "locked image");
    writeFileSync(imported, "new image");
    const task = db.createTask({
      projectName: "导入候选",
      shotNumber: 2,
      firstFrameSource: "generated",
      sourceImagePath: locked,
      imagePrompt: "一只柯基",
      imageAccountId: null,
      accountId: null,
      prompt: "柯基眼睛",
      model: "Seedance 2.0 mini",
      duration: 6,
      aspectRatio: "16:9"
    });
    const oldPath = task.imagePath;
    const updated = db.importImageCandidate(task.id, imported);
    expect(updated.imageStatus).toBe("ready");
    expect(updated.imagePath).toBe(oldPath);
    expect(updated.imageGenerationCount).toBe(1);
    expect(updated.imageCandidates).toHaveLength(1);
    expect(updated.imageCandidates[0].reviewStatus).toBe("pending");
    expect(path.basename(updated.imageCandidates[0].filePath)).toContain("第1次_候选1");
    expect(existsSync(updated.imageCandidates[0].filePath)).toBe(true);
    const restored = db.restoreLockedImageState(task.id, "已取消重新生图");
    expect(restored.imageStatus).toBe("approved");
    expect(restored.imagePath).toBe(oldPath);
    expect(restored.imagePrepareStep).toBe("已取消重新生图");
    db.close();
  });

  it("keeps a task completed when a later video candidate is rejected", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-multi-candidates-"));
    tempDirs.push(dir);
    const db = new StudioDatabase(path.join(dir, "data"));
    const firstVideo = path.join(dir, "first.mp4");
    const secondVideo = path.join(dir, "second.mp4");
    writeFileSync(firstVideo, "first video");
    writeFileSync(secondVideo, "second video");
    const task = db.createTask({
      projectName: "多候选审核",
      shotNumber: 1,
      imagePrompt: "",
      imageAccountId: null,
      accountId: null,
      prompt: "柯基回头",
      model: "Seedance 2.0 mini",
      duration: 6,
      aspectRatio: "16:9"
    });
    let updated = db.addTaskCandidates(task.id, "video", 1, [{ sourceUrl: "first", filePath: firstVideo }]);
    updated = db.reviewVideoCandidate(updated.videoCandidates[0].id, true);
    const approvedPath = updated.resultPath;
    updated = db.addTaskCandidates(task.id, "video", 2, [{ sourceUrl: "second", filePath: secondVideo }]);
    const latest = updated.videoCandidates.find((candidate) => candidate.generationIndex === 2)!;
    updated = db.reviewVideoCandidate(latest.id, false);
    expect(updated.status).toBe("succeeded");
    expect(updated.resultPath).toBe(approvedPath);
    expect(updated.videoPrepareStep).toContain("已通过");
    expect(updated.videoGenerationCount).toBe(2);
    expect(updated.imageGenerationCount).toBe(0);
    db.close();
  });

  it("stores a project output directory and removes spaces from account labels in filenames", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-output-"));
    tempDirs.push(dir);
    const outputDirectory = path.join(dir, "项目素材");
    const db = new StudioDatabase(path.join(dir, "data"));
    const task = db.createTask({
      projectName: "输出测试",
      shotNumber: 3,
      imagePrompt: "",
      imageAccountId: null,
      accountId: null,
      prompt: "柯基眨眼",
      model: "Seedance 2.0 mini",
      duration: 6,
      aspectRatio: "16:9"
    });
    db.saveProjectStyle({
      projectName: "输出测试",
      globalPrompt: "",
      imageGlobalPrompt: "",
      videoGlobalPrompt: "",
      migrationPending: false,
      characterReferencePaths: [],
      sceneReferencePath: null,
      styleReferencePath: null,
      outputDirectory,
      lockedModel: null,
      lockedAspectRatio: null
    });
    const target = db.generationTarget(task.id, "video", "账号 1");
    expect(target.folder).toBe(path.join(outputDirectory, "视频"));
    expect(target.baseName).toContain("账号1");
    expect(target.baseName).not.toContain("账号 1");
    const imageTarget = db.generationTarget(task.id, "image", "账号 1");
    expect(imageTarget.baseName).toBe("输出测试_分镜03_第1次");
    db.close();
  });

  it("keeps project history, supports archive/restore, and does not delete output files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-studio-projects-"));
    tempDirs.push(dir);
    const outputDirectory = path.join(dir, "output");
    const outputFile = path.join(outputDirectory, "成片.mp4");
    const db = new StudioDatabase(path.join(dir, "data"));
    const task = db.createTask({
      projectName: "历史项目",
      shotNumber: 1,
      imagePrompt: "",
      imageAccountId: null,
      accountId: null,
      prompt: "柯基跑过客厅",
      model: "Seedance 2.0 mini",
      duration: 10,
      aspectRatio: "16:9"
    });
    db.saveProjectStyle({
      projectName: "历史项目", globalPrompt: "", imageGlobalPrompt: "", videoGlobalPrompt: "",
      migrationPending: false, characterReferencePaths: [], sceneReferencePath: null, styleReferencePath: null,
      outputDirectory, lockedModel: null, lockedAspectRatio: null
    });
    writeFileSync(outputFile, "video");

    expect(db.listProjects()[0]).toMatchObject({ projectName: "历史项目", shotCount: 1, totalDuration: 10, status: "active" });
    expect(db.setProjectStatus("历史项目", "archived").status).toBe("archived");
    expect(db.setProjectStatus("历史项目", "active").status).toBe("active");
    db.deleteProject("历史项目");
    expect(db.listProjects()).toEqual([]);
    expect(() => db.getTask(task.id)).toThrow(/不存在/);
    expect(existsSync(outputFile)).toBe(true);
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
