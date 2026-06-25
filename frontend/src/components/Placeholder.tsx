import type { ReactNode } from 'react';

/** Styled placeholder for routes implemented in later Phase 2 tasks. */
export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-ink-muted">{children}</p>
    </div>
  );
}
