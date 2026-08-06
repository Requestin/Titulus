import { useEffect, useState, type ReactNode } from 'react';
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
import {
  api,
  type AuthUser,
  type Permission,
  ApiError,
  firstAllowedPath,
  hasPermission,
} from '@/core/api';
import { clearSessionToken, getSessionToken, setSessionToken } from '@/core/session';
import { useControlWs } from '@/core/controlWs';

function normalizeMeUser(me: {
  user: AuthUser;
  permissions?: Permission[];
}): AuthUser {
  return {
    ...me.user,
    permissions: me.user.permissions ?? me.permissions,
  };
}

function RequirePermission({
  user,
  perm,
  children,
}: {
  user: AuthUser;
  perm: Permission;
  children: ReactNode;
}) {
  if (hasPermission(user, perm)) return <>{children}</>;
  const dest = firstAllowedPath(user) ?? '/login';
  return <Navigate to={dest} replace />;
}

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
        if (!cancelled) setUser(normalizeMeUser(me));
      } catch {
        clearSessionToken();
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Poll session every 60s; clear on failure (expiry / revoke).
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const me = await api.auth.me();
        if (!cancelled) setUser(normalizeMeUser(me));
      } catch {
        clearSessionToken();
        if (!cancelled) {
          setUser(null);
          useControlWs.getState().disconnect();
        }
      }
    };
    const id = window.setInterval(() => { void tick(); }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [user?.id]);

  async function login(username: string, password: string) {
    const res = await api.auth.login(username, password);
    setSessionToken(res.token);
    // Fresh login may not embed permissions; refresh /me when missing.
    if (res.user.permissions?.length) {
      setUser(res.user);
      return;
    }
    try {
      const me = await api.auth.me();
      setUser(normalizeMeUser(me));
    } catch {
      setUser(res.user);
    }
  }

  async function logout() {
    try {
      await api.auth.logout();
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
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

  const home = firstAllowedPath(user) ?? '/login';

  return (
    <BrowserRouter>
      <Routes>
        {/* Output surface — full-bleed, no app chrome. */}
        <Route path="/renderer" element={<RendererPage />} />
        <Route
          path="/login"
          element={user ? <Navigate to={home} replace /> : <LoginPage onLogin={login} />}
        />

        <Route element={user ? <AppShell user={user} onLogout={logout} /> : <Navigate to="/login" replace />}>
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route
            path="/templates"
            element={(
              <RequirePermission user={user!} perm="template_editor">
                <TemplatesPage />
              </RequirePermission>
            )}
          />
          <Route
            path="/ue-templates"
            element={(
              <RequirePermission user={user!} perm="template_ue_editor">
                <UeTemplatesPage />
              </RequirePermission>
            )}
          />
          <Route
            path="/editor/:id"
            element={(
              <RequirePermission user={user!} perm="template_editor">
                <EditorPage />
              </RequirePermission>
            )}
          />
          <Route
            path="/control"
            element={(
              <RequirePermission user={user!} perm="control">
                <ControlPage />
              </RequirePermission>
            )}
          />
          <Route
            path="/settings"
            element={(
              <RequirePermission user={user!} perm="settings">
                <SettingsPage />
              </RequirePermission>
            )}
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
