import {
  resolveCueFrame,
  type Timeline,
  type TimelineCue,
  type TimelineCueCommand,
  type TimelineCueDirection,
  type TimelineCueItem,
  type TimelineDirector,
} from '@runtime';

export const UPDATE_DIRECTOR_NAME = 'Update';

export function isProtectedUpdateDirector(
  director: Pick<TimelineDirector, 'name'> | null | undefined,
): boolean {
  return director?.name.trim().toLowerCase() === 'update';
}

export function canRenameDirector(director: Pick<TimelineDirector, 'name'>): boolean {
  return !isProtectedUpdateDirector(director);
}

export function canRemoveDirector(
  directors: Pick<TimelineDirector, 'id' | 'name'>[],
  directorId: string,
): boolean {
  if (directors.length <= 1) return false;
  const director = directors.find((item) => item.id === directorId);
  return Boolean(director && !isProtectedUpdateDirector(director));
}

export function newId(): string {
  return crypto.randomUUID();
}

export function createCueItem(
  command: TimelineCueCommand = 'startDirector',
  parameterDirectorId = 'default',
): TimelineCueItem {
  if (command === 'tag') {
    return {
      id: newId(),
      command: 'tag',
      parameterTag: 'endScene',
      lengthFrames: 0,
      direction: 'normal',
    };
  }
  return {
    id: newId(),
    command,
    parameterDirectorId,
    lengthFrames: command === 'pauseDirector' ? 1 : 0,
    direction: 'normal',
  };
}

export function createCue(directorId: string, frame: number, fromEnd = false): TimelineCue {
  return {
    id: newId(),
    directorId,
    frame: Math.max(0, Math.round(frame)),
    fromEnd,
    name: 'Action',
    items: [createCueItem('startDirector', directorId)],
  };
}

export function effectiveCueFrame(
  cue: Pick<TimelineCue, 'frame' | 'fromEnd'>,
  directorDuration: number,
): number {
  return resolveCueFrame(cue, directorDuration);
}

export function cueFrameFromEffective(
  effective: number,
  fromEnd: boolean,
  directorDuration: number,
): number {
  const frame = Math.max(0, Math.round(effective));
  const duration = Math.max(0, Math.round(directorDuration));
  if (!fromEnd) return Math.min(frame, duration);
  return Math.max(0, duration - Math.min(frame, duration));
}

export function findCueAtEffectiveFrame(
  cues: TimelineCue[] | undefined,
  directorId: string,
  effective: number,
  directorDuration: number,
  exceptId?: string,
): TimelineCue | undefined {
  return (cues ?? []).find((cue) => (
    cue.directorId === directorId
    && cue.id !== exceptId
    && effectiveCueFrame(cue, directorDuration) === Math.max(0, Math.round(effective))
  ));
}

export function mergeCueItems(host: TimelineCue, incoming: TimelineCueItem[]): TimelineCue {
  return { ...host, items: [host.items[0], ...host.items.slice(1), ...incoming] };
}

export function constrainCueTag(
  item: TimelineCueItem,
  hostDirector: Pick<TimelineDirector, 'name'>,
  allCues: TimelineCue[],
  hostCueId?: string,
): TimelineCueItem {
  if (item.command !== 'tag') return item;
  if (isProtectedUpdateDirector(hostDirector)) {
    return { ...item, parameterTag: 'updateData' };
  }
  const hasOtherUpdate = allCues.some((cue) => (
    cue.id !== hostCueId
    && cue.items.some((entry) => entry.command === 'tag' && entry.parameterTag === 'updateData')
  ));
  if (item.parameterTag === 'updateData' && hasOtherUpdate) {
    return { ...item, parameterTag: 'endScene' };
  }
  return { ...item, parameterTag: item.parameterTag === 'updateData' ? 'endScene' : item.parameterTag };
}

export function stripCuesForDirector(timeline: Timeline, directorId: string): TimelineCue[] {
  return (timeline.cues ?? []).filter((cue) => {
    if (cue.directorId === directorId) return false;
    return !cue.items.some((item) => item.command !== 'tag' && item.parameterDirectorId === directorId);
  });
}

export function listCuesForDirector(cues: TimelineCue[] | undefined, directorId: string): TimelineCue[] {
  return (cues ?? []).filter((cue) => cue.directorId === directorId);
}

export const CUE_DIRECTIONS: TimelineCueDirection[] = ['normal', 'reverse', 'both'];
