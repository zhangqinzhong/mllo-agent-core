const SECRET_KEY_PATTERN =
  /(^|[_-])(api[-_]?key|authorization|cookie|password|secret|token|access[-_]?token|refresh[-_]?token)([_-]|$)/i;
const BEARER_PATTERN = /(bearer\s+)[a-z0-9._~+/=-]{12,}/gi;
const KEY_VALUE_PATTERN =
  /\b(api[_-]?key|authorization|password|secret|token)\b\s*[:=]\s*["']?[^"',\s}]+/gi;

type RedactionOptions = {
  redactSecrets?: boolean;
  maxDepth?: number;
};

function shouldRedactKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactMlloObserverText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "$1[redacted]")
    .replace(KEY_VALUE_PATTERN, (match, key: string) => `${key}: [redacted]`);
}

export function redactMlloObserverValue(
  value: unknown,
  options: RedactionOptions = {},
  depth = 0,
): unknown {
  if (options.redactSecrets === false) {
    return value;
  }
  if (depth > (options.maxDepth ?? 12)) {
    return "[max-depth]";
  }
  if (typeof value === "string") {
    return redactMlloObserverText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMlloObserverValue(item, options, depth + 1));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = shouldRedactKey(key)
      ? "[redacted]"
      : redactMlloObserverValue(item, options, depth + 1);
  }
  return redacted;
}
