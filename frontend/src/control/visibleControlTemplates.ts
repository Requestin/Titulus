export function templatesVisibleInControl<T extends { folder_id?: string | null }>(
  templates: T[],
  folders: Array<{ id: string; hide_in_control: number | boolean }>,
): T[] {
  const hidden = new Set(
    folders
      .filter((folder) => folder.hide_in_control === 1 || folder.hide_in_control === true)
      .map((folder) => folder.id),
  );
  return templates.filter((template) => !template.folder_id || !hidden.has(template.folder_id));
}
