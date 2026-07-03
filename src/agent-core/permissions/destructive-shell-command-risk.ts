import type { AgentCorePermissionRisk } from "./agent-core-permission-types";

export type AgentCoreDestructiveShellWarning = {
  title: string;
  detail: string;
};

type AgentCoreDestructiveShellPattern = AgentCoreDestructiveShellWarning & {
  pattern: RegExp;
};

const COMMAND_BOUNDARY = "[^;&|\\n]*";

const DESTRUCTIVE_SHELL_COMMAND_PATTERNS: readonly AgentCoreDestructiveShellPattern[] = [
  {
    pattern: /\bgit\s+reset\b[^;&|\n]*\s--hard(?:\s|$)/,
    title: "Destructive git reset",
    detail: "This command can discard uncommitted workspace changes.",
  },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*(?:\s--force(?:-with-lease)?(?:\s|$)|\s-f(?:\s|$))/,
    title: "Force push",
    detail: "This command can overwrite remote history.",
  },
  {
    pattern:
      /\bgit\s+clean\b(?=[^;&|\n]*(?:-[A-Za-z]*f|--force))(?![^;&|\n]*(?:-[A-Za-z]*n|--dry-run))/,
    title: "Destructive git clean",
    detail: "This command can permanently delete untracked files.",
  },
  {
    pattern: /\bgit\s+checkout\b[^;&|\n]*(?:--\s+\.\s*(?:$|[;&|\n])|\s\.\s*(?:$|[;&|\n]))/,
    title: "Destructive git checkout",
    detail: "This command can overwrite local file changes.",
  },
  {
    pattern: /\bgit\s+restore\b[^;&|\n]*(?:\s\.|\s--worktree|\s--staged)/,
    title: "Destructive git restore",
    detail: "This command can overwrite local file changes.",
  },
  {
    pattern: /\bgit\s+stash\s+(?:drop|clear)\b/,
    title: "Destructive git stash",
    detail: "This command can permanently remove saved stash entries.",
  },
  {
    pattern:
      /\bgit\s+branch\b[^;&|\n]*(?:\s-D(?:\s|$)|\s--delete\s+--force\b|\s--force\s+--delete\b)/,
    title: "Forced branch deletion",
    detail: "This command can delete a branch even when commits are not merged.",
  },
  {
    pattern: /\bgit\s+(?:commit|merge|push)\b[^;&|\n]*\s--no-verify\b/,
    title: "Bypass git verification",
    detail: "This command skips configured git safety checks.",
  },
  {
    pattern: /\bgit\s+commit\b[^;&|\n]*\s--amend\b/,
    title: "Commit history rewrite",
    detail: "This command rewrites the most recent commit.",
  },
  {
    pattern: new RegExp(
      `\\brm\\b(?=${COMMAND_BOUNDARY}(?:-[^\\s]*r|--recursive))(?=${COMMAND_BOUNDARY}(?:-[^\\s]*f|--force))`,
    ),
    title: "Recursive forced remove",
    detail: "This command can recursively delete files without prompting.",
  },
  {
    pattern: /\bfind\b[^;&|\n]*(?:\s-delete\b|\s-exec(?:dir)?\s+rm\b)/,
    title: "Destructive find command",
    detail: "This command can delete files from a find traversal.",
  },
  {
    pattern: /\b(?:drop|truncate)\s+(?:database|table)\b/i,
    title: "Destructive database command",
    detail: "This command can permanently remove database data.",
  },
  {
    pattern: /\bkubectl\s+delete\b/,
    title: "Destructive cluster command",
    detail: "This command can delete Kubernetes resources.",
  },
  {
    pattern: /\bterraform\s+destroy\b/,
    title: "Destructive infrastructure command",
    detail: "This command can destroy managed infrastructure.",
  },
];

// 这里只生成“危险命令提示”，只解释风险，不替代权限判定。
export function findAgentCoreDestructiveShellWarning(
  command: string,
): AgentCoreDestructiveShellWarning | null {
  const normalized = command.trim();
  const match = DESTRUCTIVE_SHELL_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  return match === undefined
    ? null
    : {
        title: match.title,
        detail: match.detail,
      };
}

export function createAgentCoreDestructiveShellRisk(args: {
  command: string;
  commandPreview: string;
}): AgentCorePermissionRisk | undefined {
  const warning = findAgentCoreDestructiveShellWarning(args.command);
  if (warning === null) {
    return undefined;
  }
  return {
    kind: "destructive-shell-command",
    severity: "high",
    title: warning.title,
    detail: warning.detail,
    names: [],
    commandPreview: args.commandPreview,
  };
}
