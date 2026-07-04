export type MlloObserverOptions = {
  homePath?: string;
  host?: string;
  port?: number;
  pollIntervalMs?: number;
  redactSecrets?: boolean;
};

export type MlloObserverSessionSource = "state" | "index" | "merged";

export type MlloObserverSessionSummary = {
  id: string;
  title: string;
  cwd: string;
  transcriptPath: string;
  promptDumpPath: string;
  source: MlloObserverSessionSource;
  modelProvider?: string;
  model?: string;
  approvalMode?: string;
  sandboxPolicy?: string;
  tokensUsed?: number;
  runStatus?: string;
  runMessage?: string;
  preview?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type MlloObserverJsonlEntry = {
  ordinal: number;
  lineNumber?: number;
  timestamp?: string;
  kind?: string;
  type?: string;
  json: string;
  truncatedJson?: boolean;
  parsed?: unknown;
  parseError?: string;
};

export type MlloObserverJsonlReadResult = {
  path: string;
  exists: boolean;
  fileBytes: number;
  bytesRead: number;
  truncatedHead: boolean;
  entries: MlloObserverJsonlEntry[];
};

export type MlloObserverSessionDetail = {
  session: MlloObserverSessionSummary;
  transcript: MlloObserverJsonlReadResult;
  prompts: MlloObserverJsonlReadResult;
};

export type MlloObserverServerHandle = {
  url: string;
  close: () => Promise<void>;
};
