import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Lock, Unlock, RefreshCw, X } from 'lucide-react';
import { api, type FontAsset } from '@/core/api';
import { Button } from '@/components/ui/Button';
import { toast } from '@/core/toast';
import { cn } from '@/lib/cn';

/** Dropdown of MAM-imported font families. Inter is shown only when MAM is empty. */
export function FontFamilySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (family: string) => void;
}) {
  const [fonts, setFonts] = useState<FontAsset[] | null>(null);

  useEffect(() => {
    api.fonts.list().then(setFonts).catch(() => setFonts([]));
  }, []);

  const families = fonts
    ? [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b))
    : [];
  const options = families.length > 0 ? families : ['Inter'];

  // Keep current value selectable even if it is not in the list yet.
  const selectOptions = value && !options.includes(value)
    ? [...options, value]
    : options;

  return (
    <select
      value={value || selectOptions[0] || 'Inter'}
      onChange={(e) => {
        const family = e.target.value;
        onChange(family);
        // Kick CSS Font Loading so the canvas picks up the face immediately.
        void import('@runtime').then(({ ensureFonts, resetEnsuredFonts }) => {
          resetEnsuredFonts();
          return ensureFonts([{ family }]);
        });
      }}
      className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
      disabled={fonts === null}
    >
      {selectOptions.map((family) => (
        <option key={family} value={family}>{family}</option>
      ))}
    </select>
  );
}

/** Full MAM management dialog for fonts. */
export function FontMamDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [fonts, setFonts] = useState<FontAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FontAsset | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (open) void load();
  }, [open]);

  async function load() {
    setLoading(true);
    try {
      setFonts(await api.fonts.list());
    } catch (e) {
      toast.error(`Failed to load fonts: ${(e as Error).message}`);
    }
    setLoading(false);
  }

  async function importFont(file: File) {
    setImporting(true);
    try {
      const family = file.name.replace(/\.(woff2|woff|ttf|otf)$/i, '');
      await api.fonts.upload(file, { family });
      await load();
      toast.success('Font imported');
      // Reload the CSS manifest by busting cache
      const link = document.querySelector('link[href*="/api/fonts/manifest.css"]');
      if (link) {
        (link as HTMLLinkElement).href = `/api/fonts/manifest.css?t=${Date.now()}`;
      }
      void import('@runtime').then(({ resetEnsuredFonts }) => resetEnsuredFonts());
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    }
    setImporting(false);
  }

  async function refreshFolder() {
    try {
      const res = await api.fonts.refresh();
      if (res.imported.length > 0) {
        toast.success(`Imported ${res.imported.length} font(s)`);
        await load();
      } else {
        toast.success('No new fonts found');
      }
    } catch (e) {
      toast.error(`Refresh failed: ${(e as Error).message}`);
    }
  }

  async function toggleLock(font: FontAsset) {
    try {
      await api.fonts.update(font.id, { locked: !font.locked });
      await load();
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`);
    }
  }

  async function deleteFont(font: FontAsset) {
    try {
      await api.fonts.remove(font.id);
      await load();
      toast.success('Font deleted');
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    }
    setPendingDelete(null);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[640px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Font MAM</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink"><X className="h-4 w-4" /></button>
        </header>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <label className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-2 cursor-pointer">
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Import font
            <input
              type="file"
              accept=".woff2,.woff,.ttf,.otf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importFont(file);
                e.target.value = '';
              }}
            />
          </label>
          <Button size="sm" variant="neutral" onClick={() => void refreshFolder()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>

        <div className="overflow-y-auto">
          {loading ? (
            <div className="grid place-items-center py-8"><Loader2 className="h-5 w-5 animate-spin text-ink-faint" /></div>
          ) : fonts.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-ink-faint">
              No fonts imported yet. Import .woff2, .woff, .ttf, or .otf files.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-[11px] uppercase text-ink-faint">
                <tr>
                  <th className="px-4 py-2">Family</th>
                  <th className="px-4 py-2">Weight</th>
                  <th className="px-4 py-2">Style</th>
                  <th className="px-4 py-2">File</th>
                  <th className="px-4 py-2 w-20">Actions</th>
                </tr>
              </thead>
              <tbody>
                {fonts.map((font) => (
                  <tr key={font.id} className="border-b border-border/40 hover:bg-surface-2/50">
                    <td className="px-4 py-2 font-medium">{font.family}</td>
                    <td className="px-4 py-2 text-ink-muted">{font.weight}</td>
                    <td className="px-4 py-2 text-ink-muted">{font.style}</td>
                    <td className="px-4 py-2 text-ink-faint">{font.originalName}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        <button
                          title={font.locked ? 'Unlock' : 'Lock'}
                          onClick={() => void toggleLock(font)}
                          className={cn('rounded p-1 hover:bg-surface-2', font.locked ? 'text-warning' : 'text-ink-faint')}
                        >
                          {font.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          title="Delete"
                          disabled={font.locked}
                          onClick={() => setPendingDelete(font)}
                          className="rounded p-1 text-danger hover:bg-surface-2 disabled:opacity-30"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {pendingDelete && (
          <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60" onClick={() => setPendingDelete(null)}>
            <div className="w-80 rounded-lg border border-border bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <p className="mb-4 text-sm">Delete font "{pendingDelete.family}"? This cannot be undone.</p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="neutral" onClick={() => setPendingDelete(null)}>Cancel</Button>
                <Button size="sm" variant="danger" onClick={() => void deleteFont(pendingDelete)}>Delete</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
