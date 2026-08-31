const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|authorization|auth[-_]?token|bearer|credential|password|secret|token)/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bpk-lf-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-lf-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

function maskString(value: string): string {
  const maskedValues = SECRET_VALUE_PATTERNS.reduce(
    (next, pattern) => next.replace(pattern, "[REDACTED]"),
    value,
  );
  return maskedValues
    .replace(
      /(["']?(?:api[-_]?key|authorization|password|secret|token)["']?\s*[:=]\s*["'])[^\s"']+(["'])/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /\b((?:api[-_]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s"']+/gi,
      "$1[REDACTED]",
    );
}

function maskValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return maskString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, seen));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : maskValue(item, seen),
  ]);
  seen.delete(value);
  return Object.fromEntries(entries);
}

export function maskAgentCoreLangfuseSensitiveData(data: unknown): unknown {
  return maskValue(data, new WeakSet<object>());
}
