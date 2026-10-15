export type AccountStatus = "login_required" | "ready" | "busy" | "error";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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

export interface AppSettings {
  maxActiveWorkers: number;
  automationEnabled: boolean;
}

export interface RuntimeStats {
  totalPrivateMb: number;
  processCount: number;
  activeAccountWindows: number;
  dataPath: string;
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
    open(id: string): Promise<void>;
    verify(id: string): Promise<IdentityResult>;
    clearCache(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  tasks: {
    list(): Promise<TaskRecord[]>;
    create(input: Pick<TaskRecord, "accountId" | "prompt" | "model" | "duration" | "aspectRatio">): Promise<TaskRecord>;
    open(id: string): Promise<TaskRecord>;
    updateStatus(id: string, status: TaskStatus): Promise<TaskRecord>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(input: Partial<AppSettings>): Promise<AppSettings>;
  };
  runtime: {
    stats(): Promise<RuntimeStats>;
  };
  onDataChanged(callback: () => void): () => void;
}
