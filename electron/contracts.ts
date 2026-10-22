export type AccountStatus = "login_required" | "ready" | "busy" | "error";
export type TaskStatus = "queued" | "submitted" | "running" | "review" | "succeeded" | "failed" | "cancelled";
export type ImageTaskStatus = "pending" | "preparing" | "submitted" | "ready" | "approved" | "failed" | "skipped";
export type FirstFrameSource = "local" | "generated" | "none";
export type UsageKind = "image" | "video";
export type ParameterSource = "shot" | "project" | "first_frame" | "default";
export type PreparationState = "idle" | "running" | "ready" | "failed";
export type MediaCandidateKind = "image" | "video";
export type MediaReviewStatus = "pending" | "approved" | "rejected";

export interface MediaCandidate {
  id: string;
  taskId: string;
  kind: MediaCandidateKind;
  generationIndex: number;
  candidateIndex: number;
  sourceUrl: string;
  filePath: string;
  previewUrl: string;
  reviewStatus: MediaReviewStatus;
  hasWatermark: boolean;
  createdAt: string;
}

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
  shotName: string;
  narration: string;
  notes: string;
  generationCount: number;
  imageGenerationCount: number;
  videoGenerationCount: number;
  firstFrameSource: FirstFrameSource;
  firstFrameFileName: string | null;
  imagePrompt: string;
  imageAccountId: string | null;
  imageStatus: ImageTaskStatus;
  imagePath: string | null;
  accountId: string | null;
  prompt: string;
  model: string;
  modelSource: ParameterSource;
  duration: number;
  durationSource: ParameterSource;
  aspectRatio: string;
  aspectRatioSource: ParameterSource;
  status: TaskStatus;
  resultUrl: string | null;
  resultPath: string | null;
  errorMessage: string | null;
  imagePrepareState: PreparationState;
  imagePrepareStep: string;
  imagePrepareMessage: string | null;
  videoPrepareState: PreparationState;
  videoPrepareStep: string;
  videoPrepareMessage: string | null;
  imageCandidates: MediaCandidate[];
  videoCandidates: MediaCandidate[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskInput extends Pick<
  TaskRecord,
  "projectName" | "shotNumber" | "imagePrompt" | "imageAccountId" | "accountId" | "prompt" | "model" | "duration" | "aspectRatio"
> {
  shotName?: string;
  narration?: string;
  notes?: string;
  generationCount?: number;
  modelSource?: ParameterSource;
  durationSource?: ParameterSource;
  aspectRatioSource?: ParameterSource;
  firstFrameSource?: FirstFrameSource;
  firstFrameFileName?: string | null;
  sourceImagePath?: string | null;
}

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

export interface ProjectStyleInput {
  projectName: string;
  globalPrompt: string;
  imageGlobalPrompt: string;
  videoGlobalPrompt: string;
  migrationPending: boolean;
  characterReferencePaths: string[];
  characterReferenceNames?: string[];
  sceneReferencePath: string | null;
  sceneReferenceName?: string | null;
  styleReferencePath: string | null;
  styleReferenceName?: string | null;
  outputDirectory?: string | null;
  lockedModel: string | null;
  lockedAspectRatio: string | null;
}

export interface ProjectStyleProfile extends ProjectStyleInput {
  characterReferenceHashes: string[];
  characterReferenceNames: string[];
  sceneReferenceName: string | null;
  styleReferenceName: string | null;
  outputDirectory: string | null;
  updatedAt: string;
}

export interface AssetFolderFile {
  name: string;
  path: string;
  width: number;
  height: number;
  thumbnailUrl: string;
}

export interface AssetFolderSelection {
  cancelled: boolean;
  folderPath: string | null;
  files: AssetFolderFile[];
}

export interface AppSettings {
  maxActiveWorkers: number;
  automationEnabled: boolean;
  autoClickGenerate: boolean;
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
    chooseSourceImage(): Promise<{ path: string; name: string; aspectRatio: string } | null>;
    openImage(id: string): Promise<TaskRecord>;
    chooseImage(id: string): Promise<TaskRecord | null>;
    importImageCandidate(id: string): Promise<TaskRecord | null>;
    cancelImageRegeneration(id: string): Promise<TaskRecord>;
    updateImageStatus(id: string, status: ImageTaskStatus): Promise<TaskRecord>;
    approveImageCandidate(id: string): Promise<TaskRecord>;
    reviewVideoCandidate(id: string, approved: boolean): Promise<TaskRecord>;
    recheckDownload(id: string): Promise<TaskRecord>;
    importVideoCandidate(id: string): Promise<TaskRecord | null>;
    openCandidateFolder(id: string): Promise<void>;
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
    chooseReference(kind: ProjectReferenceKind): Promise<string[]>;
    chooseOutputDirectory(): Promise<string | null>;
    applyLocks(projectName: string): Promise<number>;
  };
  imports: {
    chooseAssetFolder(): Promise<AssetFolderSelection>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(input: Partial<AppSettings>): Promise<AppSettings>;
  };
  runtime: {
    stats(): Promise<RuntimeStats>;
    chooseDataDirectory(): Promise<DataDirectoryChangeResult>;
    exportDiagnostics(): Promise<DiagnosticsExportResult>;
    openRepository(): Promise<void>;
    openDataDirectory(): Promise<void>;
  };
  onDataChanged(callback: () => void): () => void;
}
