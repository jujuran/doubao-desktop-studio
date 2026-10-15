import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeDataLocation,
  resolveSelectedDataPath,
  scheduleDataMigration
} from "../electron/data-location";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("data directory migration", () => {
  it("uses a stable named child when a parent directory is selected", () => {
    const selected = path.join(makeTempDir("doubao-selected-"), "storage");
    expect(resolveSelectedDataPath(selected)).toBe(path.join(selected, "Doubao Desktop Studio Data"));
  });

  it("copies persistent data, skips caches, and activates the new path", () => {
    const root = makeTempDir("doubao-location-");
    const appData = path.join(root, "app-data");
    const source = path.join(root, "old-data");
    const selectedParent = path.join(root, "new-parent");
    mkdirSync(path.join(source, "Partitions", "account-1"), { recursive: true });
    mkdirSync(path.join(source, "Cache"), { recursive: true });
    mkdirSync(selectedParent, { recursive: true });
    writeFileSync(path.join(source, "studio.sqlite"), "database");
    writeFileSync(path.join(source, "Partitions", "account-1", "Cookies"), "session");
    writeFileSync(path.join(source, "Cache", "cache.bin"), "discard");

    const target = scheduleDataMigration(appData, source, selectedParent);
    const state = initializeDataLocation(appData, source);

    expect(state.userDataPath).toBe(target);
    expect(readFileSync(path.join(target, "studio.sqlite"), "utf8")).toBe("database");
    expect(readFileSync(path.join(target, "Partitions", "account-1", "Cookies"), "utf8")).toBe("session");
    expect(existsSync(path.join(target, "Cache"))).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  it("rejects a non-empty destination", () => {
    const root = makeTempDir("doubao-location-full-");
    const appData = path.join(root, "app-data");
    const source = path.join(root, "old-data");
    const selected = path.join(root, "Doubao Desktop Studio Data");
    mkdirSync(source, { recursive: true });
    mkdirSync(selected, { recursive: true });
    writeFileSync(path.join(selected, "existing.txt"), "keep");

    expect(() => scheduleDataMigration(appData, source, selected)).toThrow(/已有文件/);
  });

  it("rejects a destination nested inside the current data directory", () => {
    const root = makeTempDir("doubao-location-nested-");
    const appData = path.join(root, "app-data");
    const source = path.join(root, "old-data");
    mkdirSync(source, { recursive: true });

    expect(() => scheduleDataMigration(appData, source, path.join(source, "backup"))).toThrow(/不能互相嵌套/);
  });

  it("falls back to the default path when a configured directory is missing", () => {
    const root = makeTempDir("doubao-location-missing-");
    const appData = path.join(root, "app-data");
    const source = path.join(root, "old-data");
    const selectedParent = path.join(root, "new-parent");
    mkdirSync(source, { recursive: true });
    mkdirSync(selectedParent, { recursive: true });
    scheduleDataMigration(appData, source, selectedParent);
    const migrated = initializeDataLocation(appData, source);
    rmSync(migrated.userDataPath, { recursive: true, force: true });

    const state = initializeDataLocation(appData, source);
    expect(state.userDataPath).toBe(source);
    expect(state.notice).toMatch(/回退到默认目录/);
  });
});
