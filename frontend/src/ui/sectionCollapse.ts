export interface SectionCollapseSignal {
  readonly version: number;
  readonly open: boolean;
}

export function toggleSectionCollapseSignal(
  current: SectionCollapseSignal,
): SectionCollapseSignal {
  return {
    version: current.version + 1,
    open: !current.open,
  };
}
