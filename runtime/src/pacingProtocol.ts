// runtime/src/pacingProtocol.ts
//
// Bounded P20.1 runtime provenance line consumed by the engine console bridge.

export const PACING_HEADER = 'BGPACING v1';
export const PACING_MAX_ACTIVE_TEMPLATES = 64;
export const PACING_MAX_TICKS_PER_RAF = 4;
export const PACING_MAX_TEMPLATE_ID_BYTES = 128;

export interface PacingEvent {
  runtimeEventSeq: number;
  rafSeq: number;
  runtimePerfUs: number;
  runtimeUnixUs: number;
  rafDeltaUs: number;
  ticksPerRaf: number;
  logicalFrameBefore: number;
  logicalFrameAfter: number;
  activeCount: number;
  identityValid: boolean;
  templateId: string | null;
  graphRevision: number;
  stateRevision: number;
}

export interface PacingIdentityCandidate {
  templateId: string;
  logicalFrame: number;
  graphRevision: number;
  stateRevision: number;
}

export interface PacingIdentity {
  activeCount: number;
  identityValid: boolean;
  templateId: string | null;
  logicalFrame: number;
  graphRevision: number;
  stateRevision: number;
}

export function selectPacingIdentity(
  active: readonly PacingIdentityCandidate[],
): PacingIdentity {
  if (active.length !== 1) {
    return {
      activeCount: active.length,
      identityValid: false,
      templateId: null,
      logicalFrame: 0,
      graphRevision: 0,
      stateRevision: 0,
    };
  }
  const candidate = active[0]!;
  return {
    activeCount: 1,
    identityValid: true,
    templateId: candidate.templateId,
    logicalFrame: candidate.logicalFrame,
    graphRevision: candidate.graphRevision,
    stateRevision: candidate.stateRevision,
  };
}

function validUnsigned(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validTemplateId(value: string): boolean {
  if (new TextEncoder().encode(value).byteLength > PACING_MAX_TEMPLATE_ID_BYTES) return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Returns null rather than producing an unparseable console line. The C++
 * parser mirrors every bound so diagnostics cannot become a render-path input.
 */
export function encodePacingEvent(event: PacingEvent): string | null {
  const numbers = [
    event.runtimeEventSeq,
    event.rafSeq,
    event.runtimePerfUs,
    event.runtimeUnixUs,
    event.rafDeltaUs,
    event.ticksPerRaf,
    event.logicalFrameBefore,
    event.logicalFrameAfter,
    event.activeCount,
    event.graphRevision,
    event.stateRevision,
  ];
  if (!numbers.every(validUnsigned)
      || event.runtimeEventSeq === 0
      || event.ticksPerRaf > PACING_MAX_TICKS_PER_RAF
      || event.activeCount > PACING_MAX_ACTIVE_TEMPLATES) {
    return null;
  }

  const template = event.identityValid ? event.templateId : null;
  if ((event.identityValid && (!template || !validTemplateId(template)))
      || (!event.identityValid && event.templateId !== null)) {
    return null;
  }

  return `${PACING_HEADER} ev=${event.runtimeEventSeq},raf=${event.rafSeq},`
    + `rperf=${event.runtimePerfUs},runix=${event.runtimeUnixUs},`
    + `rdelta=${event.rafDeltaUs},ticks=${event.ticksPerRaf},`
    + `lf_before=${event.logicalFrameBefore},lf_after=${event.logicalFrameAfter},`
    + `active=${event.activeCount},valid=${event.identityValid ? 1 : 0},`
    + `template=${template ?? '-'},graph=${event.graphRevision},state=${event.stateRevision}`;
}
