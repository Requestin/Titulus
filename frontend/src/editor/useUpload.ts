// frontend/src/editor/useUpload.ts
//
// Upload a file via /api/uploads and poll the transcode job until the media is
// ready, returning the playable URL (DEVELOPMENT_PROMPT §7.5).

import { useCallback, useState } from 'react';
import { api } from '@/core/api';
import { toast } from '@/core/toast';

export function useUpload() {
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<'pending' | 'processing' | 'ready' | 'error' | null>(null);
  const [uploadProfile, setUploadProfile] = useState<string | null>(null);

  const upload = useCallback(async (file: File): Promise<string | null> => {
    setUploading(true);
    setUploadStatus('pending');
    setUploadProfile(null);
    try {
      const res = await api.uploads.upload(file);
      setUploadStatus(res.status);
      setUploadProfile(res.profile);
      if (res.status === 'ready') return res.url;
      if (res.status === 'error') {
        toast.error(`Transcode failed: ${res.error?.message ?? 'unknown error'}`);
        return null;
      }
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await api.uploads.job(res.jobId);
        setUploadStatus(job.status);
        setUploadProfile(job.profile ?? null);
        if (job.status === 'ready') return job.url;
        if (job.status === 'error') {
          toast.error(`Transcode failed: ${job.error?.message ?? 'unknown error'}`);
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

  return { upload, uploading, uploadStatus, uploadProfile };
}
