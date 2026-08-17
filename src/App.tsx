import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { InboxPage } from './pages/InboxPage';
import { LoginPage } from './pages/LoginPage';
import { DownloadAndroidPage } from './pages/DownloadAndroidPage';
import { SettingsPage } from './pages/SettingsPage';
import type { CurrentUser } from './types';

export function App() {
	const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);

	const refreshMe = useCallback(async (signal?: AbortSignal) => {
		const res = await fetch('/api/me', { credentials: 'same-origin', signal });
		if (res.status === 401) {
			setUser(null);
			return;
		}
		if (!res.ok) {
			setUser(null);
			return;
		}
		setUser((await res.json()) as CurrentUser);
	}, []);

	useEffect(() => {
		const ac = new AbortController();
		void refreshMe(ac.signal);
		return () => ac.abort();
	}, [refreshMe]);

	async function onLogout() {
		await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
		if ('caches' in window) {
			const keys = await caches.keys();
			await Promise.all(keys.map((key) => caches.delete(key)));
		}
		setUser(null);
	}

	if (user === undefined) {
		return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
	}

	return (
		<Routes>
			<Route path="/download/android" element={<DownloadAndroidPage />} />
			<Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
			<Route path="/settings" element={user ? <SettingsPage user={user} onLogout={onLogout} /> : <Navigate to="/login" replace />} />
			<Route path="/" element={user ? <InboxPage user={user} onLogout={onLogout} /> : <Navigate to="/login" replace />} />
			<Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
		</Routes>
	);
}
