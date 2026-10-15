import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import path from "node:path";

const MAX_LOG_SIZE = 2 * 1024 * 1024;
const SENSITIVE_KEY = /authorization|cookie|password|secret|session|token/i;

export type DiagnosticLevel = "info" | "warn" | "error";

export class DiagnosticsLogger {
  readonly logPath: string;
  private readonly previousLogPath: string;

  constructor(dataDir: string) {
    const logDirectory = path.join(dataDir, "logs");
    mkdirSync(logDirectory, { recursive: true });
    this.logPath = path.join(logDirectory, "studio.log");
    this.previousLogPath = path.join(logDirectory, "studio.previous.log");
  }

  info(event: string, details?: Record<string, unknown>) {
    this.write("info", event, details);
  }

  warn(event: string, details?: Record<string, unknown>) {
    this.write("warn", event, details);
  }

  error(event: string, details?: Record<string, unknown>) {
    this.write("error", event, details);
  }

  buildReport(summary: Record<string, unknown>) {
    const current = readText(this.logPath);
    const previous = readText(this.previousLogPath);
    return [
      "Doubao Desktop Studio diagnostics",
      `Generated: ${new Date().toISOString()}`,
      "",
      "Summary:",
      JSON.stringify(redact(summary), null, 2),
      "",
      "Previous log:",
      previous || "(empty)",
      "",
      "Current log:",
      current || "(empty)",
      ""
    ].join("\n");
  }

  private write(level: DiagnosticLevel, event: string, details?: Record<string, unknown>) {
    try {
      this.rotateIfNeeded();
      const entry = {
        time: new Date().toISOString(),
        level,
        event,
        ...(details ? { details: redact(details) } : {})
      };
      appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Diagnostics must never prevent the application from running.
    }
  }

  private rotateIfNeeded() {
    if (!existsSync(this.logPath) || statSync(this.logPath).size < MAX_LOG_SIZE) return;
    rmSync(this.previousLogPath, { force: true });
    renameSync(this.logPath, this.previousLogPath);
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item)
  ]));
}

function readText(filePath: string) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
