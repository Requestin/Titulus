export function diffWaitingContinue(
  last: ReadonlyMap<string, boolean>,
  next: Iterable<readonly [string, boolean]>,
): {
  changed: Array<{ templateId: string; waiting: boolean }>;
  snapshot: Map<string, boolean>;
} {
  const snapshot = new Map<string, boolean>();
  const changed: Array<{ templateId: string; waiting: boolean }> = [];
  for (const [templateId, waiting] of next) {
    snapshot.set(templateId, waiting);
    if (last.get(templateId) !== waiting) {
      changed.push({ templateId, waiting });
    }
  }
  return { changed, snapshot };
}
