function isUpdateDirectorName(name) {
  return String(name ?? '').trim().toLowerCase() === 'update';
}

export function findUpdateDirector(directors = []) {
  return directors.find((director) => isUpdateDirectorName(director?.name));
}

/** Control only runs Update when that director actually has animation tracks. */
export function hasUpdateDirectorTracks(timeline) {
  if (!timeline || !Array.isArray(timeline.directors)) return false;
  const director = findUpdateDirector(timeline.directors);
  if (!director) return false;
  if (Object.values(timeline.trackDirectors || {}).some((id) => id === director.id)) return true;
  const byProp = timeline.propertyTrackDirectors;
  if (byProp && Object.values(byProp).some((bag) => Object.values(bag || {}).some((id) => id === director.id))) {
    return true;
  }
  return (timeline.keyframes || []).some((keyframe) => keyframe.directorId === director.id);
}

export function sourceTemplateId(cmd) {
  return cmd?.template?.id || cmd?.templateId;
}
