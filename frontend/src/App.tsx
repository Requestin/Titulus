import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { TemplatesPage } from '@/pages/TemplatesPage';
import { UeTemplatesPage } from '@/pages/UeTemplatesPage';
import { EditorPage } from '@/pages/EditorPage';
import { ControlPage } from '@/pages/ControlPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { RendererPage } from '@/pages/RendererPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { LoginPage } from '@/pages/LoginPage';
import { api, type AuthUser, ApiError } from '@/core/api';
import { clearSessionToken, getSessionToken, setSessionToken } from '@/core/session';
import { useControlWs } from '@/core/controlWs';

export function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = getSessionToken();
      if (!token) {
        if (!cancelled) setBooting(false);
        return;
      }
      try {
        const me = await api.auth.me();
        if (!cancelled) setUser(me.user);
      } catch {
        clearSessionToken();
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function login(username: string, password: string) {
    const res = await api.auth.login(username, password);
    setSessionToken(res.token);
    setUser(res.user);
  }

  async function logout() {
    try {
      await api.auth.logout();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        // best effort logout: local session is still cleared below
        console.error('[auth] logout request failed', err);
      }
    } finally {
      clearSessionToken();
      setUser(null);
      useControlWs.getState().disconnect();
    }
  }

  if (booting) {
    return <div className="grid h-full place-items-center text-ink-muted">Loading...</div>;
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Output surface — full-bleed, no app chrome. */}
        <Route path="/renderer" element={<RendererPage />} />
        <Route
          path="/login"
          element={user ? <Navigate to="/templates" replace /> : <LoginPage onLogin={login} />}
        />

        <Route element={user ? <AppShell user={user} onLogout={logout} /> : <Navigate to="/login" replace />}>
          <Route path="/" element={<Navigate to="/templates" replace />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/ue-templates" element={<UeTemplatesPage />} />
          <Route path="/editor/:id" element={<EditorPage />} />
          <Route path="/control" element={<ControlPage />} />
          <Route path="/settings" element={user?.role === 'admin' ? <SettingsPage /> : <Navigate to="/control" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
