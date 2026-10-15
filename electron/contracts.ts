export type AccountStatus = "login_required" | "ready" | "busy" | "error";
export type TaskStatus = "queued" | "submitted" | "running" | "succeeded" | "failed" | "cancelled";
export type ImageTaskStatus = "pending" | "preparing" | "submitted" | "ready" | "approved" | "failed" | "skipped";
export type UsageKind = "image" | "video";

export interface Account {
  id: string;
  label: string;
  partition: string;
  doubaoUserId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: AccountStatus;
  createdAt: string;
  lastVerifiedAt: string | null;
}

export interface TaskRecord {
  id: string;
  projectName: string;
  shotNumber: number;
  imagePrompt: string;
  imageAccountId: string | null;
  imageStatus: ImageTaskStatus;
  imagePath: string | null;
  accountId: string | null;
  prompt: string;
  model: string;
  duration: number;
  aspectRatio: string;
  status: TaskStatus;
  resultUrl: string | null;
  resultPath: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskInput = Pick<
  TaskRecord,
  "projectName" | "shotNumber" | "imagePrompt" | "imageAccountId" | "accountId" | "prompt" | "model" | "duration" | "aspectRatio"
>;

export interface AccountUsage {
  accountId: string;
  usageDate: string;
  imageCount: number;
  videoCount: number;
}

export interface AssignmentSummary {
  imageAssignments: number;
  videoAssignments: number;
}

export type ProjectReferenceKind = "character" | "scene" | "style";

export interface ProjectStyleProfile {
  projectName: string;
  stylePrompt: string;
  characterPrompt: string;
  scenePrompt: string;
  continuityPrompt: string;
  negativePrompt: string;
  characterReferencePath: string | null;
  sceneReferencePath: string | null;
  styleReferencePath: string | null;
  lockedModel: string | null;
  lockedAspectRatio: string | null;
  updatedAt: string;
}

export type ProjectStyleInput = Omit<ProjectStyleProfile, "updatedAt">;

export interface AppSettings {
  maxActiveWorkers: number;
  automationEnabled: boolean;
  lastTaskAccountId: string | null;
  lastVideoModel: string;
  lastVideoDuration: number;
  lastAspectRatio: string;
}

export interface RuntimeStats {
  version: string;
  totalPrivateMb: number;
  processCount: number;
  activeAccountWindows: number;
  activeAccountIds: string[];
  dataPath: string;
  logPath: string;
  dataPathNotice: string | null;
}

export interface DataDirectoryChangeResult {
  cancelled: boolean;
  restartScheduled: boolean;
  message: string;
  targetPath?: string;
}

export interface DiagnosticsExportResult {
  cancelled: boolean;
  message: string;
  filePath?: string;
}

export interface IdentityResult {
  ok: boolean;
  account: Account;
  message: string;
}

export interface DesktopApi {
  accounts: {
    list(): Promise<Account[]>;
    create(label: string): Promise<Account>;
    rename(id: string, label: string): Promise<Account>;
    open(id: string): Promise<void>;
    verify(id: string): Promise<IdentityResult>;
    clearCache(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  tasks: {
    list(): Promise<TaskRecord[]>;
    create(input: TaskInput): Promise<TaskRecord>;
    importMany(inputs: TaskInput[]): Promise<TaskRecord[]>;
    update(id: string, input: TaskInput): Promise<TaskRecord>;
    duplicate(id: string): Promise<TaskRecord>;
    remove(id: string): Promise<void>;
    copyPrompt(id: string): Promise<void>;
    openImage(id: string): Promise<TaskRecord>;
    chooseImage(id: string): Promise<TaskRecord | null>;
    updateImageStatus(id: string, status: ImageTaskStatus): Promise<TaskRecord>;
    autoAssign(): Promise<AssignmentSummary>;
    open(id: string): Promise<TaskRecord>;
    updateStatus(id: string, status: TaskStatus): Promise<TaskRecord>;
  };
  usage: {
    listToday(): Promise<AccountUsage[]>;
    adjust(accountId: string, kind: UsageKind, value: number): Promise<AccountUsage>;
  };
  projects: {
    listStyles(): Promise<ProjectStyleProfile[]>;
    saveStyle(input: ProjectStyleInput): Promise<ProjectStyleProfile>;
    chooseReference(kind: ProjectReferenceKind): Promise<string | null>;
    applyLocks(projectName: string): Promise<number>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(input: Partial<AppSettings>): Promise<AppSettings>;
  };
  runtime: {
    stats(): Promise<RuntimeStats>;
    chooseDataDirectory(): Promise<DataDirectoryChangeResult>;
    exportDiagnostics(): Promise<DiagnosticsExportResult>;
  };
  onDataChanged(callback: () => void): () => void;
}
