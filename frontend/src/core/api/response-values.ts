export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function nonBlankText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function textOr(value: unknown, fallback: string): string {
  return nonBlankText(value) ?? fallback;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
