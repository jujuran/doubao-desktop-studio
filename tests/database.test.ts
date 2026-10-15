import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("clamps worker concurrency to a memory-safe range", () => {
    const db = createDatabase();
    expect(db.updateSettings({ maxActiveWorkers: 20 }).maxActiveWorkers).toBe(3);
    expect(db.updateSettings({ maxActiveWorkers: 0 }).maxActiveWorkers).toBe(1);
    db.close();
  });
});
