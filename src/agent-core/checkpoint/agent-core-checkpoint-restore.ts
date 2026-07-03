import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentCoreCheckpointRecord } from "./agent-core-checkpoint-store";

export type AgentCoreCheckpointRestoreFileResult = {
  path: string;
  resolvedPath: string;
  action: "restored" | "deleted" | "conflict";
  reason?: string;
};

export type AgentCoreCheckpointRestoreResult = {
  checkpointId: string;
  files: AgentCoreCheckpointRestoreFileResult[];
};

export type AgentCoreCheckpointPreviewFileResult = {
  path: string;
  resolvedPath: string;
  plannedAction: "restore" | "delete";
  status: "ready" | "conflict";
  reason?: string;
  diffPreview?: AgentCoreCheckpointPreviewDiff;
};

export type AgentCoreCheckpointPreviewResult = {
  checkpointId: string;
  files: AgentCoreCheckpointPreviewFileResult[];
};

export type AgentCoreCheckpointPreviewDiff = {
  currentContent: string | null;
  restoreContent: string | null;
  truncated: boolean;
  omittedChars: number;
};

export type AgentCoreCheckpointRestoreConflictStrategy = "skip" | "force";

export type AgentCoreCheckpointRestoreOptions = {
  conflictStrategy?: AgentCoreCheckpointRestoreConflictStrategy;
  filePaths?: readonly string[];
};

export type AgentCoreCheckpointPreviewOptions = Pick<
  AgentCoreCheckpointRestoreOptions,
  "filePaths"
> & {
  includeDiff?: boolean;
  diffContentMaxChars?: number;
};

const DEFAULT_CHECKPOINT_DIFF_CONTENT_MAX_CHARS = 12_000;
const CHECKPOINT_RESTORE_CONFLICT_REASON =
  "File changed after the checkpointed agent write; restore skipped to avoid overwriting newer user or agent edits.";
const LEGACY_CHECKPOINT_RESTORE_CONFLICT_REASON =
  "Checkpoint lacks post-write content tracking; restore skipped unless the file already matches the checkpoint target.";

async function readCurrentContent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function getCheckpointFileConflict(
  file: AgentCoreCheckpointRecord["files"][number],
  currentContent: string | null | undefined,
):
  | {
      hasConflict: false;
    }
  | {
      hasConflict: true;
      reason: string;
    } {
  if (file.contentAfterWrite !== undefined) {
    if (currentContent === file.contentAfterWrite) {
      return {
        hasConflict: false,
      };
    }
    return {
      hasConflict: true,
      reason: CHECKPOINT_RESTORE_CONFLICT_REASON,
    };
  }
  if (currentContent === file.previousContent) {
    return {
      hasConflict: false,
    };
  }
  return {
    hasConflict: true,
    reason: LEGACY_CHECKPOINT_RESTORE_CONFLICT_REASON,
  };
}

async function checkpointFileHasConflict(file: AgentCoreCheckpointRecord["files"][number]): Promise<
  | {
      hasConflict: false;
    }
  | {
      hasConflict: true;
      reason: string;
    }
> {
  const currentContent = await readCurrentContent(file.resolvedPath);
  return getCheckpointFileConflict(file, currentContent);
}

export async function readAgentCoreCheckpointRecord(
  checkpointPath: string,
): Promise<AgentCoreCheckpointRecord> {
  return JSON.parse(await readFile(checkpointPath, "utf8")) as AgentCoreCheckpointRecord;
}

function assertCheckpointFileInsideCwd(
  record: AgentCoreCheckpointRecord,
  resolvedPath: string,
): void {
  const relativePath = relative(resolve(record.cwd), resolve(resolvedPath));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to restore checkpoint file outside cwd: ${resolvedPath}`);
  }
}

function createRestorePathFilter(filePaths: readonly string[] | undefined): Set<string> | null {
  return filePaths === undefined ? null : new Set(filePaths);
}

function getPlannedRestoreAction(
  file: AgentCoreCheckpointRecord["files"][number],
): AgentCoreCheckpointPreviewFileResult["plannedAction"] {
  return file.previousContent === null ? "delete" : "restore";
}

function truncateContentForDiffPreview(
  content: string | null,
  maxChars: number,
): {
  content: string | null;
  truncated: boolean;
  omittedChars: number;
} {
  if (content === null || content.length <= maxChars) {
    return {
      content,
      truncated: false,
      omittedChars: 0,
    };
  }
  return {
    content: content.slice(0, maxChars),
    truncated: true,
    omittedChars: content.length - maxChars,
  };
}

function createCheckpointDiffPreview(args: {
  file: AgentCoreCheckpointRecord["files"][number];
  currentContent: string | null;
  maxChars: number;
}): AgentCoreCheckpointPreviewDiff {
  const current = truncateContentForDiffPreview(args.currentContent, args.maxChars);
  const restore = truncateContentForDiffPreview(args.file.previousContent, args.maxChars);
  return {
    currentContent: current.content,
    restoreContent: restore.content,
    truncated: current.truncated || restore.truncated,
    omittedChars: current.omittedChars + restore.omittedChars,
  };
}

export async function previewAgentCoreCheckpointRecord(
  record: AgentCoreCheckpointRecord,
  options: AgentCoreCheckpointPreviewOptions = {},
): Promise<AgentCoreCheckpointPreviewResult> {
  const files: AgentCoreCheckpointPreviewFileResult[] = [];
  const restorePathFilter = createRestorePathFilter(options.filePaths);
  const includeDiff = options.includeDiff ?? false;
  const diffContentMaxChars =
    options.diffContentMaxChars ?? DEFAULT_CHECKPOINT_DIFF_CONTENT_MAX_CHARS;

  for (const file of record.files.slice().reverse()) {
    if (restorePathFilter !== null && !restorePathFilter.has(file.path)) {
      continue;
    }
    assertCheckpointFileInsideCwd(record, file.resolvedPath);
    const currentContent = await readCurrentContent(file.resolvedPath);
    const conflict = getCheckpointFileConflict(file, currentContent);
    const diffPreview = includeDiff
      ? createCheckpointDiffPreview({
          file,
          currentContent,
          maxChars: diffContentMaxChars,
        })
      : undefined;
    if (conflict.hasConflict === true) {
      const previewFile: AgentCoreCheckpointPreviewFileResult = {
        path: file.path,
        resolvedPath: file.resolvedPath,
        plannedAction: getPlannedRestoreAction(file),
        status: "conflict",
        reason: conflict.reason,
      };
      if (diffPreview !== undefined) {
        previewFile.diffPreview = diffPreview;
      }
      files.push(previewFile);
      continue;
    }
    const previewFile: AgentCoreCheckpointPreviewFileResult = {
      path: file.path,
      resolvedPath: file.resolvedPath,
      plannedAction: getPlannedRestoreAction(file),
      status: "ready",
    };
    if (diffPreview !== undefined) {
      previewFile.diffPreview = diffPreview;
    }
    files.push(previewFile);
  }

  return {
    checkpointId: record.checkpointId,
    files,
  };
}

export async function restoreAgentCoreCheckpointRecord(
  record: AgentCoreCheckpointRecord,
  options: AgentCoreCheckpointRestoreOptions = {},
): Promise<AgentCoreCheckpointRestoreResult> {
  const files: AgentCoreCheckpointRestoreFileResult[] = [];
  const conflictStrategy = options.conflictStrategy ?? "skip";
  const restorePathFilter = createRestorePathFilter(options.filePaths);

  for (const file of record.files.slice().reverse()) {
    if (restorePathFilter !== null && !restorePathFilter.has(file.path)) {
      continue;
    }
    assertCheckpointFileInsideCwd(record, file.resolvedPath);
    const conflict =
      conflictStrategy === "force"
        ? {
            hasConflict: false as const,
          }
        : await checkpointFileHasConflict(file);
    if (conflict.hasConflict === true) {
      files.push({
        path: file.path,
        resolvedPath: file.resolvedPath,
        action: "conflict",
        reason: conflict.reason,
      });
      continue;
    }
    if (file.previousContent === null) {
      await rm(file.resolvedPath, {
        force: true,
      });
      files.push({
        path: file.path,
        resolvedPath: file.resolvedPath,
        action: "deleted",
      });
      continue;
    }

    await mkdir(dirname(file.resolvedPath), {
      recursive: true,
    });
    await writeFile(file.resolvedPath, file.previousContent, "utf8");
    files.push({
      path: file.path,
      resolvedPath: file.resolvedPath,
      action: "restored",
    });
  }

  return {
    checkpointId: record.checkpointId,
    files,
  };
}

export async function restoreAgentCoreCheckpointFile(
  checkpointPath: string,
  options: AgentCoreCheckpointRestoreOptions = {},
): Promise<AgentCoreCheckpointRestoreResult> {
  return await restoreAgentCoreCheckpointRecord(
    await readAgentCoreCheckpointRecord(checkpointPath),
    options,
  );
}

export async function previewAgentCoreCheckpointFile(
  checkpointPath: string,
  options: AgentCoreCheckpointPreviewOptions = {},
): Promise<AgentCoreCheckpointPreviewResult> {
  return await previewAgentCoreCheckpointRecord(
    await readAgentCoreCheckpointRecord(checkpointPath),
    options,
  );
}
