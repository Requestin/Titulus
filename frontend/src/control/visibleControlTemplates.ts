export interface ControlVisibilityPrefs {
  hideAll?: boolean;
  hideUnassigned?: boolean;
}

export function templatesVisibleInControl<T extends { folder_id?: string | null }>(
  templates: T[],
  folders: Array<{ id: string; hide_in_control: number | boolean }>,
  prefs?: ControlVisibilityPrefs,
): T[] {
  if (prefs?.hideAll) return [];

  const hidden = new Set(
    folders
      .filter((folder) => folder.hide_in_control === 1 || folder.hide_in_control === true)
      .map((folder) => folder.id),
  );

  return templates.filter((template) => {
    if (!template.folder_id) {
      if (prefs?.hideUnassigned) return false;
      return true;
    }
    return !hidden.has(template.folder_id);
  });
}

export function foldersVisibleInControl<T extends { hide_in_control: number | boolean }>(
  folders: T[],
): T[] {
  return folders.filter(
    (folder) => folder.hide_in_control !== 1 && folder.hide_in_control !== true,
  );
}
