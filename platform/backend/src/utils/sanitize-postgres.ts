const POSTGRES_UNSUPPORTED_NUL = String.fromCharCode(0);

export function sanitizePostgresText(value: string): string {
  return value.split(POSTGRES_UNSUPPORTED_NUL).join("\\0");
}

export function sanitizePostgresJson<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizePostgresText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePostgresJson(item)) as T;
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizePostgresJson(item),
      ]),
    ) as T;
  }

  return value;
}
