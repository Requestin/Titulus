// frontend/src/editor/media/MediaSourcePicker.tsx

import { useState } from 'react';
import type { MediaAsset } from '@/core/api';
import { Button } from '@/components/ui/Button';
import { MediaPickerModal } from './MediaPickerModal';
import { MediaFileInfo } from './MediaFileInfo';

export function MediaSourcePicker({
  type,
  src,
  onSelect,
}: {
  type: 'image' | 'video';
  src: string;
  /** Receives the full asset so callers can use duration/fps metadata. */
  onSelect: (asset: MediaAsset) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="neutral" size="sm" onClick={() => setOpen(true)}>
        Choose file
      </Button>
      {src && <MediaFileInfo url={src} type={type} />}
      <MediaPickerModal
        type={type}
        open={open}
        onClose={() => setOpen(false)}
        onSelect={(asset: MediaAsset) => onSelect(asset)}
      />
    </>
  );
}
