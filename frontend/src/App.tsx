import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { TemplatesPage } from '@/pages/TemplatesPage';
import { EditorPage } from '@/pages/EditorPage';
import { ControlPage } from '@/pages/ControlPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { RendererPage } from '@/pages/RendererPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Output surface — full-bleed, no app chrome. */}
        <Route path="/renderer" element={<RendererPage />} />

        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/templates" replace />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/editor/:id" element={<EditorPage />} />
          <Route path="/control" element={<ControlPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
