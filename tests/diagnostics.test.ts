import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticsLogger } from "../electron/diagnostics";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DiagnosticsLogger", () => {
  it("redacts sensitive fields from logs and exported reports", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doubao-diagnostics-"));
    tempDirs.push(dir);
    const logger = new DiagnosticsLogger(dir);
    logger.info("test_event", { accountId: "local-account", sessionToken: "must-not-leak" });

    const report = logger.buildReport({ version: "test", cookie: "also-secret" });
    expect(report).toContain("test_event");
    expect(report).toContain("local-account");
    expect(report).toContain("[redacted]");
    expect(report).not.toContain("must-not-leak");
    expect(report).not.toContain("also-secret");
  });
});
