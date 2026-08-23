import { useEffect, useState } from 'react';
import { Image, Search, Upload } from 'lucide-react';
import { api, type MediaAsset } from '@/core/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/form';
import { toast } from '@/core/toast';

export function MamPicker({
  onPick,
  accept = 'image/*,video/*',
}: {
  onPick: (token: string) => void;
  accept?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setItems(await api.media.list({ q: q.trim() || undefined, tag: tag.trim() || undefined }));
    } catch (error) {
      toast.error(`MAM list failed: ${(error as Error).message}`);
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function importFile(file: File) {
    setBusy(true);
    try {
      const result = await api.media.import(file);
      const token = result.catalog?.token;
      if (!token) throw new Error('import returned no token');
      onPick(token);
      setOpen(false);
      toast.success('Imported to MAM');
    } catch (error) {
      toast.error(`Import failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="neutral" className="w-full" onClick={() => setOpen(true)}>
        <Image className="h-4 w-4" aria-hidden />
        Choose from MAM
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-label="Media library">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-surface">
            <div className="flex items-center gap-2 border-b border-border p-3">
              <Search className="h-4 w-4 text-ink-faint" aria-hidden />
              <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search" className="flex-1" />
              <Input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="Tag" className="w-32" />
              <Button size="sm" variant="neutral" onClick={() => void load()}>Find</Button>
              <label className="inline-flex">
                <input
                  type="file"
                  accept={accept}
                  className="hidden"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importFile(file);
                    event.target.value = '';
                  }}
                />
                <span className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[12px]">
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                  Import
                </span>
              </label>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
            </div>
            <ul className="min-h-0 flex-1 overflow-auto p-2">
              {items.length === 0 ? (
                <li className="p-6 text-center text-[13px] text-ink-faint">No media yet.</li>
              ) : items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-[13px] hover:bg-surface-2"
                    onClick={() => {
                      onPick(item.token);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{item.title || item.originalName || item.token}</span>
                    <span className="text-[11px] text-ink-faint">{item.tags.join(', ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
