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
  onSelect: (url: string) => void;
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
        onSelect={(asset: MediaAsset) => onSelect(asset.url)}
      />
    </>
  );
}
