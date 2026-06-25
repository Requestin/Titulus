// frontend/src/pages/RendererPage.tsx
//
// Browser / OBS·vMix output surface (DEVELOPMENT_PROMPT §8.2). A thin wrapper
// over the shared @runtime ChannelClient: it mounts a stage and connects to
// /ws/renderer for the channel. Full transparent BGRA output, no app chrome.
//
// Channel comes from ?channel=<id> (default "default"). Fleshed out in task 2.7.

import { useEffect, useRef } from 'react';
import { ChannelClient } from '@runtime';

export function RendererPage() {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const channelId = new URLSearchParams(location.search).get('channel') || 'default';
    const client = new ChannelClient({ stage, channelId, playbackMode: 'raf' });
    client.connect();
    return () => client.disconnect();
  }, []);

  return <div ref={stageRef} className="h-screen w-screen overflow-hidden bg-transparent" />;
}
