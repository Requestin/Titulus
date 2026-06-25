import { useRef } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { useUpload } from './useUpload';
import { Button } from '@/components/ui/Button';

export function MediaUploadButton({
  accept,
  onUploaded,
  label = 'Upload media',
}: {
  accept: string;
  onUploaded: (url: string) => void;
  label?: string;
}) {
  const { upload, uploading } = useUpload();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const url = await upload(f);
          if (url) onUploaded(url);
          e.target.value = '';
        }}
      />
      <Button size="sm" variant="neutral" className="w-full" disabled={uploading} onClick={() => ref.current?.click()}>
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
        {label}
      </Button>
    </>
  );
}
