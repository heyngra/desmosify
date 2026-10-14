type Shaped = { name?: unknown; message?: unknown; status?: unknown };

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;

  const shaped = (error ?? {}) as Shaped;
  const parts = [shaped.name, shaped.message, shaped.status === undefined ? '' : `status ${String(shaped.status)}`]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map(String);

  return parts.length > 0 ? parts.join(' · ') : String(error);
}
