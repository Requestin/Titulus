// frontend/src/editor/useUpload.ts
//
// Upload a file via /api/uploads and poll the transcode job until the media is
// ready, returning the playable URL (DEVELOPMENT_PROMPT §7.5).

import { useCallback, useState } from 'react';
import { api } from '@/core/api';
import { toast } from '@/core/toast';

export function useUpload() {
  const [uploading, setUploading] = useState(false);

  const upload = useCallback(async (file: File): Promise<string | null> => {
    setUploading(true);
    try {
      const res = await api.uploads.upload(file);
      if (res.status === 'ready') return res.url;
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await api.uploads.job(res.jobId);
        if (job.status === 'ready') return job.url;
        if (job.status === 'error') {
          toast.error(`Transcode failed: ${job.error ?? 'unknown error'}`);
          return null;
        }
      }
      toast.error('Upload timed out while transcoding');
      return null;
    } catch (e) {
      toast.error(`Upload failed: ${(e as Error).message}`);
      return null;
    } finally {
      setUploading(false);
    }
  }, []);

  return { upload, uploading };
}
