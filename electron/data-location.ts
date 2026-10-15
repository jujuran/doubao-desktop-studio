import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const CONFIG_FILE = ".doubao-desktop-studio-location.json";
const DATA_DIRECTORY_NAME = "Doubao Desktop Studio Data";
const TRANSIENT_TOP_LEVEL_NAMES = new Set([
  "Cache",
  "Code Cache",
  "Crashpad",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "GPUPersistentCache",
  "GrShaderCache",
  "ShaderCache"
]);

interface PendingMigration {
  sourcePath: string;
  targetPath: string;
}

interface DataLocationConfig {
  version: 1;
  userDataPath?: string;
  pendingMigration?: PendingMigration;
  lastError?: string;
}

export interface DataLocationState {
  userDataPath: string;
  notice: string | null;
}

export function initializeDataLocation(appDataPath: string, defaultUserDataPath: string): DataLocationState {
  const configPath = getConfigPath(appDataPath);
  let config = readConfig(configPath);

  if (config.pendingMigration) {
    try {
      migrateData(config.pendingMigration);
      config = {
        version: 1,
        userDataPath: config.pendingMigration.targetPath
      };
    } catch (error) {
      config = {
        version: 1,
        userDataPath: config.userDataPath,
        lastError: `数据目录迁移失败，已继续使用原目录：${errorMessage(error)}`
      };
    }
    writeConfig(configPath, config);
  }

  if (config.userDataPath) {
    if (path.isAbsolute(config.userDataPath) && existsSync(config.userDataPath)) {
      return { userDataPath: path.resolve(config.userDataPath), notice: config.lastError ?? null };
    }
    const notice = "已配置的数据目录不存在，已回退到默认目录";
    writeConfig(configPath, { version: 1, lastError: notice });
    return { userDataPath: path.resolve(defaultUserDataPath), notice };
  }

  return { userDataPath: path.resolve(defaultUserDataPath), notice: config.lastError ?? null };
}

export function resolveSelectedDataPath(selectedPath: string) {
  const resolved = path.resolve(selectedPath);
  return path.basename(resolved).toLowerCase() === DATA_DIRECTORY_NAME.toLowerCase()
    ? resolved
    : path.join(resolved, DATA_DIRECTORY_NAME);
}

export function scheduleDataMigration(
  appDataPath: string,
  sourcePath: string,
  selectedPath: string
) {
  const source = path.resolve(sourcePath);
  const target = resolveSelectedDataPath(selectedPath);
  assertMigrationPaths(source, target);

  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`目标目录已有文件，请选择一个空目录：${target}`);
  }

  const configPath = getConfigPath(appDataPath);
  const current = readConfig(configPath);
  writeConfig(configPath, {
    version: 1,
    userDataPath: current.userDataPath,
    pendingMigration: { sourcePath: source, targetPath: target }
  });
  return target;
}

function migrateData({ sourcePath, targetPath }: PendingMigration) {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  assertMigrationPaths(source, target);
  if (!existsSync(source)) throw new Error(`原数据目录不存在：${source}`);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`目标目录已有文件：${target}`);
  }

  const temporaryTarget = `${target}.migrating`;
  rmSync(temporaryTarget, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    cpSync(source, temporaryTarget, {
      recursive: true,
      force: true,
      filter: (sourceEntry) => shouldCopyEntry(source, sourceEntry)
    });
    rmSync(target, { recursive: true, force: true });
    renameSync(temporaryTarget, target);
  } catch (error) {
    rmSync(temporaryTarget, { recursive: true, force: true });
    throw error;
  }
}

function shouldCopyEntry(sourceRoot: string, sourceEntry: string) {
  const relative = path.relative(sourceRoot, sourceEntry);
  if (!relative) return true;
  const topLevelName = relative.split(path.sep)[0];
  return !TRANSIENT_TOP_LEVEL_NAMES.has(topLevelName)
    && !topLevelName.startsWith("Singleton");
}

function assertMigrationPaths(source: string, target: string) {
  if (!path.isAbsolute(source) || !path.isAbsolute(target)) {
    throw new Error("数据目录必须是绝对路径");
  }
  if (samePath(source, target)) throw new Error("新目录与当前目录相同");
  if (isInside(source, target) || isInside(target, source)) {
    throw new Error("新旧数据目录不能互相嵌套");
  }
}

function samePath(left: string, right: string) {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeForComparison(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getConfigPath(appDataPath: string) {
  return path.join(path.resolve(appDataPath), CONFIG_FILE);
}

function readConfig(configPath: string): DataLocationConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<DataLocationConfig>;
    return {
      version: 1,
      userDataPath: parsed.userDataPath,
      pendingMigration: parsed.pendingMigration,
      lastError: parsed.lastError
    };
  } catch {
    return { version: 1 };
  }
}

function writeConfig(configPath: string, config: DataLocationConfig) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  rmSync(configPath, { force: true });
  renameSync(temporaryPath, configPath);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
