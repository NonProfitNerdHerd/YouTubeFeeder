import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { CategoryRecord, LiveGridSize, LiveLayoutRecord, LiveSessionRecord, LiveSourceMode, LiveSourceRecord } from '../types';
import { LIVE_GRID_SIZES } from '../types';
import { youtubeEmbedUrl } from '../lib/youtubeUrl';
import { formatQuadJobStatus } from '../lib/quadStatus';
import '../styles/live.css';

function apiMessage(body: unknown, fallback: string): string {
	const err = (body as { error?: { message?: string } })?.error?.message;
	return err || fallback;
}

function livesOf(source: LiveSourceRecord) {
	return (source.liveVideos ?? []).filter((video) => video.status === 'live' && video.embeddable !== false);
}

function upcomingOf(source: LiveSourceRecord) {
	return (source.liveVideos ?? []).filter((video) => video.status === 'upcoming');
}

function blockedLiveOf(source: LiveSourceRecord) {
	return (source.liveVideos ?? []).filter((video) => video.status === 'non_embeddable');
}

function channelStatus(source: LiveSourceRecord): 'Disabled' | 'Unknown' | 'Live' | 'Upcoming' | 'Offline' {
	if (source.sourceMode === 'disabled') return 'Disabled';
	if (source.verifyState === 'error') return 'Unknown';
	if (livesOf(source).length || blockedLiveOf(source).length) return 'Live';
	if (upcomingOf(source).length) return 'Upcoming';
	return 'Offline';
}

function modeLabel(mode: LiveSourceMode): string {
	if (mode === 'always_on') return 'Always On';
	if (mode === 'on_demand') return 'On Demand';
	if (mode === 'disabled') return 'Disabled';
	return 'Normal';
}

function streamList(source: LiveSourceRecord) {
	const live = livesOf(source);
	const blocked = blockedLiveOf(source);
	const upcoming = upcomingOf(source);
	return (
		<ul className="live-video-list">
			{live.map((video) => (
				<li key={video.videoId}>
					{video.title} · {video.videoId}
				</li>
			))}
			{blocked.map((video) => (
				<li key={video.videoId}>
					{video.title} · {video.videoId} · Live on YouTube, embedding disabled
				</li>
			))}
			{upcoming.map((video) => (
				<li key={video.videoId}>
					Upcoming · {video.title} · {video.videoId}
				</li>
			))}
			{!live.length && !blocked.length && !upcoming.length ? <li>No verified streams</li> : null}
		</ul>
	);
}

function relativeTime(iso: string | null): string {
	if (!iso) return 'Never';
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return 'Never';
	const seconds = Math.round((Date.now() - then) / 1000);
	if (seconds < 60) return 'Just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

export function LivePage({
	sidebarOpen,
	onHeaderStatus,
	onGridChrome,
}: {
	sidebarOpen: boolean;
	onHeaderStatus: (payload: { text: string; error: boolean } | null) => void;
	onGridChrome: (payload: { gridSize: LiveGridSize; setGrid: (size: LiveGridSize) => void } | null) => void;
}) {
	const [sources, setSources] = useState<LiveSourceRecord[]>([]);
	const [session, setSession] = useState<LiveSessionRecord | null>(null);
	const [layouts, setLayouts] = useState<LiveLayoutRecord[]>([]);
	const [categories, setCategories] = useState<CategoryRecord[]>([]);
	const [leftTab, setLeftTab] = useState<'streams' | 'categories' | 'layouts' | 'settings'>('streams');
	const [sourceMode, setSourceMode] = useState<LiveSourceMode>('normal');
	const [monitor, setMonitor] = useState<{
		settings: {
			pollingEnabled: boolean;
			confirmIntervalSeconds: number;
			discoveryIntervalSeconds: number;
			cacheMaxAgeSeconds: number;
			defaultSourceMode: LiveSourceMode;
			searchFallbackEnabled: boolean;
			searchDailyAllowance: number;
		};
		stats: {
			generalApiCalls: number;
			searchQueries: number;
			cacheHits: number;
			duplicatesPrevented: number;
			lastConfirmAt: string | null;
			lastDiscoverAt: string | null;
			nextConfirmAt: string | null;
			nextDiscoverAt: string | null;
			lastDurationMs: number | null;
			lastError: string | null;
		};
		counts: { knownLive: number; knownUpcoming: number; offline: number; alwaysOn: number; onDemand: number };
		searchRemaining: number;
		quotaNote: string;
	} | null>(null);
	const [confirmSearch, setConfirmSearch] = useState(false);
	const [filterCat, setFilterCat] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [activeSlot, setActiveSlot] = useState(1);
	const [editing, setEditing] = useState<LiveSourceRecord | null>(null);
	const [name, setName] = useState('');
	const [channel, setChannel] = useState('');
	const [notes, setNotes] = useState('');
	const [categoryIds, setCategoryIds] = useState<string[]>([]);
	const [newCategory, setNewCategory] = useState('');
	const [layoutName, setLayoutName] = useState('');
	const [editingLayout, setEditingLayout] = useState<LiveLayoutRecord | null>(null);
	const [layoutEditName, setLayoutEditName] = useState('');
	const [layoutEditDesc, setLayoutEditDesc] = useState('');
	const [layoutEditGrid, setLayoutEditGrid] = useState<LiveGridSize>(4);
	const [layoutDeleteConfirm, setLayoutDeleteConfirm] = useState(false);
	const [formOpen, setFormOpen] = useState(false);
	const slotRefs = useRef<Record<number, HTMLDivElement | null>>({});

	const load = useCallback(async () => {
		const [srcRes, layRes, catRes, monRes] = await Promise.all([
			fetch('/api/live/session', { credentials: 'same-origin' }),
			fetch('/api/live/layouts', { credentials: 'same-origin' }),
			fetch('/api/live/categories', { credentials: 'same-origin' }),
			fetch('/api/live/monitor', { credentials: 'same-origin' }),
		]);
		if (!srcRes.ok) throw new Error('Could not load Live.');
		const srcBody = (await srcRes.json()) as { session: LiveSessionRecord; sources: LiveSourceRecord[] };
		setSession(srcBody.session);
		setSources(srcBody.sources);
		if (layRes.ok) setLayouts(((await layRes.json()) as { layouts: LiveLayoutRecord[] }).layouts);
		if (catRes.ok) setCategories(((await catRes.json()) as { categories: CategoryRecord[] }).categories);
		if (monRes.ok) setMonitor(await monRes.json());
	}, []);

	useEffect(() => {
		load().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load Live.'));
	}, [load]);

	const enabledSources = sources.filter((s) => s.enabled);
	const liveCount = enabledSources.reduce((n, s) => n + livesOf(s).length + blockedLiveOf(s).length, 0);
	const liveChannels = enabledSources.filter((s) => livesOf(s).length + blockedLiveOf(s).length > 0).length;
	const lastUpdate = sources.reduce<string | null>((acc, s) => {
		if (!s.liveCheckedAt) return acc;
		if (!acc || s.liveCheckedAt > acc) return s.liveCheckedAt;
		return acc;
	}, null);

	useEffect(() => {
		const text =
			status || error
				? [status, error].filter(Boolean).join(' — ')
				: `${liveCount} live ${liveCount === 1 ? 'stream' : 'streams'}${
						liveChannels ? ` · ${liveChannels} ${liveChannels === 1 ? 'channel' : 'channels'}` : ''
					} · Last update ${relativeTime(lastUpdate)}`;
		onHeaderStatus({ text, error: Boolean(error) });
	}, [status, error, liveCount, liveChannels, lastUpdate, onHeaderStatus]);

	useEffect(() => () => onHeaderStatus(null), [onHeaderStatus]);

	const filtered = useMemo(() => {
		if (!filterCat) return sources;
		return sources.filter((s) => s.categoryIds.includes(filterCat));
	}, [sources, filterCat]);

	function applyPayload(body: { sources?: LiveSourceRecord[]; session?: LiveSessionRecord }) {
		if (body.sources) setSources(body.sources);
		if (body.session) setSession(body.session);
	}

	async function postJob(url: string, body: Record<string, unknown>, queued: string) {
		setBusy(true);
		setError(null);
		setStatus(`Refresh queued — ${queued}`);
		try {
			setStatus('Refresh running…');
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(body),
			});
			const payload = (await res.json().catch(() => ({}))) as Parameters<typeof formatQuadJobStatus>[0] & {
				error?: { message?: string };
				sources?: LiveSourceRecord[];
				session?: LiveSessionRecord;
			};
			if (!res.ok) throw new Error(apiMessage(payload, 'Request failed.'));
			applyPayload(payload);
			setStatus(formatQuadJobStatus(payload));
			await load();
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Request failed.');
		} finally {
			setBusy(false);
		}
	}

	async function refreshStatuses() {
		await postJob('/api/live/refresh', { force: false }, 'status confirmation');
	}

	async function discoverStreams() {
		await postJob('/api/live/discover', { force: false }, 'discovery');
	}

	async function refreshCategory() {
		if (!filterCat) return;
		await postJob('/api/live/discover', { categoryId: filterCat, force: true }, 'selected category');
	}

	async function recoverOne(id: string) {
		await postJob(`/api/live/sources/${encodeURIComponent(id)}/refresh`, {}, 'source recover');
	}

	function startEdit(source: LiveSourceRecord | null) {
		setEditing(source);
		setName(source?.displayName ?? '');
		setChannel(source?.youtubeUrl ?? '');
		setNotes(source?.notes ?? '');
		setSourceMode(source?.sourceMode ?? 'normal');
		setCategoryIds(source?.categoryIds ?? []);
		setFormOpen(true);
	}

	function closeForm() {
		setFormOpen(false);
		setEditing(null);
		setName('');
		setChannel('');
		setNotes('');
		setSourceMode('normal');
		setCategoryIds([]);
	}

	async function saveSource(event: FormEvent) {
		event.preventDefault();
		setError(null);
		const payload = { displayName: name, channel, notes, enabled: sourceMode !== 'disabled', skipDiscovery: sourceMode === 'always_on', sourceMode, categoryIds };
		const res = await fetch(editing ? `/api/live/sources/${encodeURIComponent(editing.id)}` : '/api/live/sources', {
			method: editing ? 'PATCH' : 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(payload),
		});
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(apiMessage(body, 'Could not save stream.'));
			return;
		}
		closeForm();
		await load();
	}

	async function removeSource(id: string) {
		setError(null);
		const res = await fetch(`/api/live/sources/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
			setError(apiMessage(body, 'Could not delete stream.'));
			return;
		}
		closeForm();
		await load();
	}

	async function saveQuadSettings(patch: Record<string, unknown>) {
		const res = await fetch('/api/live/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(patch),
		});
		if (!res.ok) return;
		await load();
	}

	async function runEmergencySearch() {
		setConfirmSearch(false);
		const failed = sources.filter((s) => s.sourceMode === 'always_on' && !s.isLive);
		for (const source of failed) {
			if ((monitor?.searchRemaining ?? 0) < 1) break;
			await recoverOne(source.id);
		}
	}

	async function toggleEnabled(source: LiveSourceRecord) {
		const res = await fetch(`/api/live/sources/${encodeURIComponent(source.id)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ sourceMode: source.sourceMode === 'disabled' ? 'normal' : 'disabled' }),
		});
		if (!res.ok) return;
		const nextMode = source.sourceMode === 'disabled' ? 'normal' : 'disabled';
		setSourceMode(nextMode);
		await load();
	}

	const setGrid = useCallback(async (size: LiveGridSize) => {
		const res = await fetch('/api/live/session', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ gridSize: size }),
		});
		if (!res.ok) return;
		const body = (await res.json()) as { session: LiveSessionRecord };
		setSession(body.session);
	}, []);

	async function assignSlot(slotNumber: number, sourceId: string | null, videoId: string | null = null) {
		const res = await fetch(`/api/live/slots/${slotNumber}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ sourceId, videoId }),
		});
		if (!res.ok) return;
		const body = (await res.json()) as { session: LiveSessionRecord };
		setSession(body.session);
	}

	async function addCategory(event: FormEvent) {
		event.preventDefault();
		const res = await fetch('/api/live/categories', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: newCategory }),
		});
		if (!res.ok) return;
		setNewCategory('');
		await load();
	}

	async function removeCategory(id: string) {
		await fetch(`/api/live/categories/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
		if (filterCat === id) setFilterCat(null);
		await load();
	}

	async function saveLayout(event: FormEvent) {
		event.preventDefault();
		setError(null);
		const res = await fetch('/api/live/layouts', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: layoutName }),
		});
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(apiMessage(body, 'Could not save layout.'));
			return;
		}
		setLayoutName('');
		await load();
	}

	async function applyLayout(id: string) {
		const res = await fetch(`/api/live/layouts/${encodeURIComponent(id)}/apply`, { method: 'POST', credentials: 'same-origin' });
		if (!res.ok) return;
		const body = (await res.json()) as { session: LiveSessionRecord };
		setSession(body.session);
	}

	async function removeLayout(id: string) {
		await fetch(`/api/live/layouts/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
		setEditingLayout(null);
		setLayoutDeleteConfirm(false);
		await load();
	}

	function openLayoutEdit(layout: LiveLayoutRecord) {
		setEditingLayout(layout);
		setLayoutEditName(layout.name);
		setLayoutEditDesc(layout.description);
		setLayoutEditGrid(layout.gridSize);
		setLayoutDeleteConfirm(false);
	}

	async function saveLayoutEdit(event: FormEvent) {
		event.preventDefault();
		if (!editingLayout) return;
		setError(null);
		const res = await fetch(`/api/live/layouts/${encodeURIComponent(editingLayout.id)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: layoutEditName, description: layoutEditDesc, gridSize: layoutEditGrid }),
		});
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(apiMessage(body, 'Could not save layout.'));
			return;
		}
		setEditingLayout(null);
		await load();
	}

	const gridSize = session?.gridSize ?? 4;
	const visibleSlots = session?.slots.filter((s) => s.slotNumber <= gridSize) ?? [];
	const editSource = editing ? (sources.find((s) => s.id === editing.id) ?? editing) : null;

	useEffect(() => {
		onGridChrome({ gridSize, setGrid });
	}, [gridSize, setGrid, onGridChrome]);

	useEffect(() => () => onGridChrome(null), [onGridChrome]);

	return (
		<div className="live-shell">
			<div className={sidebarOpen ? 'live-body' : 'live-body sidebar-closed'}>
				{sidebarOpen ? (
				<aside className="live-side">
					<div className="live-side-head">
						<div className="tabs">
							<button className={leftTab === 'streams' ? 'tab active' : 'tab'} type="button" onClick={() => setLeftTab('streams')}>
								Streams
							</button>
							<button className={leftTab === 'categories' ? 'tab active' : 'tab'} type="button" onClick={() => setLeftTab('categories')}>
								Categories
							</button>
						</div>
						<div className="live-side-tools">
							{leftTab === 'streams' ? (
								<button className="icon-btn" type="button" title="Add stream" aria-label="Add stream" onClick={() => startEdit(null)}>
									+
								</button>
							) : null}
							<button
								className={leftTab === 'layouts' ? 'icon-btn active' : 'icon-btn'}
								type="button"
								title="Layouts"
								aria-label="Layouts"
								aria-pressed={leftTab === 'layouts'}
								onClick={() => setLeftTab('layouts')}
							>
								<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
									<path fill="currentColor" d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />
								</svg>
							</button>
							<button
								className={leftTab === 'settings' ? 'icon-btn active' : 'icon-btn'}
								type="button"
								title="Settings"
								aria-label="Settings"
								aria-pressed={leftTab === 'settings'}
								onClick={() => setLeftTab('settings')}
							>
								<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
									<path
										fill="currentColor"
										d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.61-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.49.49 0 0 0 13.92 2h-3.84a.49.49 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.61.22L2.7 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.82 14.52a.49.49 0 0 0-.12.61l1.92 3.32c.14.24.4.34.61.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .43-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.12.47.02.61-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
									/>
								</svg>
							</button>
						</div>
					</div>
					{leftTab === 'streams' ? (
						<div className="left-scroll">
							<div className="live-filter">
								<select value={filterCat ?? ''} onChange={(e) => setFilterCat(e.target.value || null)}>
									<option value="">All</option>
									{categories.map((cat) => (
										<option key={cat.id} value={cat.id}>
											{cat.name}
										</option>
									))}
								</select>
								{filterCat ? (
									<button
										className="live-filter-refresh"
										type="button"
										title="Refresh this category"
										aria-label="Refresh this category"
										disabled={busy}
										onClick={() => void refreshCategory()}
									>
										<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
											<path
												fill="currentColor"
												d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 13.65-6.65z"
											/>
										</svg>
									</button>
								) : null}
							</div>
							{filtered.map((source) => (
								<div key={source.id} className={source.enabled ? 'live-card' : 'live-card dim'}>
									<div className="live-card-head">
										<strong>{source.displayName}</strong>
										<span className="live-card-badges">
											{source.sourceMode === 'always_on' ? <span className="live-badge skip">Always On</span> : null}
											{source.sourceMode === 'on_demand' ? <span className="live-badge skip">On Demand</span> : null}
											{source.sourceMode === 'disabled' ? <span className="live-badge skip">Disabled</span> : null}
											{livesOf(source).length || blockedLiveOf(source).length ? (
												<span className="live-badge">
													{livesOf(source).length + blockedLiveOf(source).length} LIVE
												</span>
											) : null}
										</span>
									</div>
									{source.notes ? <p className="muted small">{source.notes}</p> : null}
									<p className="muted small">
										{[
											channelStatus(source),
											relativeTime(source.lastStatusCheckAt ?? source.liveCheckedAt),
											source.categoryIds
												.map((id) => categories.find((c) => c.id === id)?.name)
												.filter(Boolean)
												.join(' · ') || 'No category',
										].join(' · ')}
									</p>
									{source.verifyError ? <p className="error">{source.verifyError}</p> : null}
									<div className="live-card-actions">
										<button className="ghost tiny" type="button" disabled={busy} onClick={() => void recoverOne(source.id)}>
											Recover
										</button>
										<button className="ghost tiny" type="button" onClick={() => startEdit(source)}>
											Edit
										</button>
									</div>
								</div>
							))}
							{sources.length === 0 ? <p className="muted pad">Add a YouTube channel to watch when it goes live.</p> : null}
						</div>
					) : null}
					{leftTab === 'categories' ? (
						<div className="left-scroll">
							<p className="muted pad">Live categories are separate from Feed. Tag streams in the add/edit popup.</p>
							<form className="cat-add" onSubmit={(e) => void addCategory(e)}>
								<input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="New live category" />
								<button className="ghost" type="submit">
									Add
								</button>
							</form>
							{categories.map((cat) => (
								<div key={cat.id} className="sub-row">
									<span className="sub">{cat.name}</span>
									<button className="ghost tiny" type="button" onClick={() => void removeCategory(cat.id)}>
										Delete
									</button>
								</div>
							))}
						</div>
					) : null}
					{leftTab === 'layouts' ? (
						<div className="left-scroll">
							<form className="cat-add" onSubmit={(e) => void saveLayout(e)}>
								<input value={layoutName} onChange={(e) => setLayoutName(e.target.value)} placeholder="Layout name" />
								<button className="ghost" type="submit">
									Save current
								</button>
							</form>
							{layouts.map((layout) => (
								<div key={layout.id} className="sub-row layout-row">
									<button className="layout-apply" type="button" onClick={() => void applyLayout(layout.id)}>
										<span>
											{layout.name} · {layout.gridSize} grid
										</span>
										{layout.description ? <span className="muted small">{layout.description}</span> : null}
									</button>
									<button className="ghost tiny" type="button" onClick={() => openLayoutEdit(layout)}>
										Edit
									</button>
								</div>
							))}
							{layouts.length === 0 ? <p className="muted pad">Save the current grid and slot assignments as a layout.</p> : null}
						</div>
					) : null}
					{leftTab === 'settings' ? (
						<div className="left-scroll">
							<h3 className="live-settings-heading">Refresh</h3>
							<div className="live-field">
								<div className="live-field-copy">
									<strong>Refresh statuses</strong>
									<p>Recheck known live video IDs with batched videos.list. Cheap, no search, no playlist discovery.</p>
								</div>
								<button className="ghost tiny live-settings-action" type="button" disabled={busy} onClick={() => void refreshStatuses()}>
									Refresh Statuses
								</button>
							</div>
							<div className="live-field">
								<div className="live-field-copy">
									<strong>Discover new live streams</strong>
									<p>Check recent uploads on normal/offline channels. Skips Always On sources that are still live. No search.</p>
								</div>
								<button className="ghost tiny live-settings-action" type="button" disabled={busy} onClick={() => void discoverStreams()}>
									Discover
								</button>
							</div>
							<div className="live-field">
								<div className="live-field-copy">
									<strong>Emergency search recovery</strong>
									<p>Last-resort search.list for Always On sources that are offline. Costs 100 quota units and 1 Search Query each.</p>
								</div>
								<button
									className="ghost tiny live-settings-action"
									type="button"
									disabled={busy || (monitor?.searchRemaining ?? 0) < 1}
									onClick={() => setConfirmSearch(true)}
								>
									Emergency search
								</button>
							</div>
							<div className="live-settings-break" />
							<h3 className="live-settings-heading">Polling</h3>
							<p className="live-settings-lead">
								These controls only affect Quad live checks. They do not change Feed sync. Quota here means YouTube Data API units and Search Queries, not Feed usage.
							</p>
							<div className="live-field">
								<div className="live-field-copy">
									<strong>Automatic Quad polling</strong>
									<p>
										When off, Quad uses no scheduled API calls. When on, confirm and discover can run on the existing Worker cron (still the Feed hours unless that schedule is changed later). Turning this on is the largest quota increase.
									</p>
								</div>
								<label className="live-switch">
									<input
										type="checkbox"
										checked={monitor?.settings.pollingEnabled ?? false}
										onChange={(e) => void saveQuadSettings({ pollingEnabled: e.target.checked })}
									/>
									<span />
								</label>
							</div>
							<label className="live-field stacked">
								<span className="live-field-copy">
									<strong>Status interval (seconds)</strong>
									<p>
										How often known live IDs are rechecked with batched videos.list (about 1 quota unit per 50 IDs). Minimum 5 minutes. Shorter uses more units. Never uses search.
									</p>
								</span>
								<input
									type="number"
									min={300}
									step={60}
									defaultValue={monitor?.settings.confirmIntervalSeconds ?? 300}
									onBlur={(e) => void saveQuadSettings({ confirmIntervalSeconds: Number(e.target.value) })}
								/>
							</label>
							<label className="live-field stacked">
								<span className="live-field-copy">
									<strong>Discovery interval (seconds)</strong>
									<p>
										How often offline/normal channels check recent uploads (1 playlistItems unit per channel, then batched videos.list). Minimum 15 minutes. Always-on streams that are still live are skipped. Never uses search.
									</p>
								</span>
								<input
									type="number"
									min={900}
									step={60}
									defaultValue={monitor?.settings.discoveryIntervalSeconds ?? 900}
									onBlur={(e) => void saveQuadSettings({ discoveryIntervalSeconds: Number(e.target.value) })}
								/>
							</label>
							<div className="live-field">
								<div className="live-field-copy">
									<strong>Search fallback</strong>
									<p>
										Last-resort search.list after cheaper recover methods fail. Each use costs 100 quota units and 1 Search Query. Confirm and discover never search.
									</p>
								</div>
								<label className="live-switch">
									<input
										type="checkbox"
										checked={monitor?.settings.searchFallbackEnabled ?? true}
										onChange={(e) => void saveQuadSettings({ searchFallbackEnabled: e.target.checked })}
									/>
									<span />
								</label>
							</div>
							<label className="live-field stacked">
								<span className="live-field-copy">
									<strong>Max Search Queries / day</strong>
									<p>
										Caps Quad search.list calls per UTC day. Google Search Queries are a separate scarce limit (often ~100/day). Keep this low. Unused if search fallback is off.
									</p>
								</span>
								<input
									type="number"
									min={0}
									defaultValue={monitor?.settings.searchDailyAllowance ?? 20}
									onBlur={(e) => void saveQuadSettings({ searchDailyAllowance: Number(e.target.value) })}
								/>
							</label>
							<div className="live-settings-break" />
							<h3 className="live-settings-heading">Other settings</h3>
							{monitor ? (
								<div className="live-monitor">
									<strong>Quad monitor</strong>
									<dl>
										<div>
											<dt>Auto poll</dt>
											<dd>{monitor.settings.pollingEnabled ? 'on' : 'off'}</dd>
										</div>
										<div>
											<dt>Status</dt>
											<dd>every {monitor.settings.confirmIntervalSeconds / 60}m</dd>
										</div>
										<div>
											<dt>Discover</dt>
											<dd>every {monitor.settings.discoveryIntervalSeconds / 60}m</dd>
										</div>
										<div>
											<dt>Last confirm</dt>
											<dd>{relativeTime(monitor.stats.lastConfirmAt)}</dd>
										</div>
										<div>
											<dt>Last discover</dt>
											<dd>{relativeTime(monitor.stats.lastDiscoverAt)}</dd>
										</div>
										<div>
											<dt>Next confirm</dt>
											<dd>{relativeTime(monitor.stats.nextConfirmAt)}</dd>
										</div>
										<div>
											<dt>Next discover</dt>
											<dd>{relativeTime(monitor.stats.nextDiscoverAt)}</dd>
										</div>
										<div>
											<dt>Live</dt>
											<dd>{monitor.counts.knownLive}</dd>
										</div>
										<div>
											<dt>Offline</dt>
											<dd>{monitor.counts.offline}</dd>
										</div>
										<div>
											<dt>Always-on</dt>
											<dd>{monitor.counts.alwaysOn}</dd>
										</div>
										<div>
											<dt>On-demand</dt>
											<dd>{monitor.counts.onDemand}</dd>
										</div>
										<div>
											<dt>Quad API calls today</dt>
											<dd>~{monitor.stats.generalApiCalls}</dd>
										</div>
										<div>
											<dt>Search Queries today</dt>
											<dd>~{monitor.stats.searchQueries}</dd>
										</div>
										<div>
											<dt>Cache hits</dt>
											<dd>{monitor.stats.cacheHits}</dd>
										</div>
										<div>
											<dt>Dupes blocked</dt>
											<dd>{monitor.stats.duplicatesPrevented}</dd>
										</div>
										<div>
											<dt>Last duration</dt>
											<dd>{monitor.stats.lastDurationMs ?? 0}ms</dd>
										</div>
									</dl>
									{monitor.stats.lastError ? <p className="error">{monitor.stats.lastError}</p> : null}
									<p className="muted">{monitor.quotaNote}</p>
								</div>
							) : null}
						</div>
					) : null}
				</aside>
				) : null}
				<div className={`live-grid grid-${gridSize}`}>
					{visibleSlots.map((slot) => {
						const source = slot.source;
						const videos = source ? livesOf(source) : [];
						const embedId = slot.videoId ?? videos[0]?.videoId ?? source?.liveVideoId ?? null;
						const live = Boolean(embedId);
						const focused = activeSlot === slot.slotNumber;
						const slotValue = slot.sourceId && embedId ? `${slot.sourceId}::${embedId}` : slot.sourceId ?? '';
						return (
							<div
								key={slot.slotNumber}
								className={focused ? 'live-slot focused' : 'live-slot'}
								ref={(el) => {
									slotRefs.current[slot.slotNumber] = el;
								}}
								onClick={() => setActiveSlot(slot.slotNumber)}
							>
								<header className="live-slot-head">
									<label>
										Slot {slot.slotNumber}
										<select
											value={slotValue}
											onChange={(e) => {
												const raw = e.target.value;
												if (!raw) {
													void assignSlot(slot.slotNumber, null, null);
													return;
												}
												const sep = raw.indexOf('::');
												if (sep === -1) {
													void assignSlot(slot.slotNumber, raw, null);
													return;
												}
												void assignSlot(slot.slotNumber, raw.slice(0, sep), raw.slice(sep + 2));
											}}
										>
											<option value="">Unassigned</option>
											{enabledSources.map((s) => {
												const lives = livesOf(s);
												if (!lives.length) {
													return (
														<option key={s.id} value={s.id} disabled>
															{s.displayName} · {channelStatus(s)}
														</option>
													);
												}
												return (
													<optgroup key={s.id} label={`${s.displayName} (${lives.length} live)`}>
														{lives.map((video) => (
															<option key={`${s.id}::${video.videoId}`} value={`${s.id}::${video.videoId}`}>
																{video.title}
															</option>
														))}
													</optgroup>
												);
											})}
										</select>
									</label>
									<button
										className="ghost tiny"
										type="button"
										onClick={() => void slotRefs.current[slot.slotNumber]?.requestFullscreen()}
									>
										Fullscreen
									</button>
								</header>
								<div className="live-slot-body">
									{live && embedId ? (
										<iframe
											title={source?.displayName ?? 'Live'}
											src={youtubeEmbedUrl(embedId, { mute: !focused, autoplay: true })}
											allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
											allowFullScreen
										/>
									) : (
										<p className="live-offline">
											{source
												? `${source.displayName} is offline. Use Recover on the source, or Discover New Live Streams.`
												: 'Assign a stream to this slot.'}
										</p>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>
			{formOpen ? (
				<div className="modal-backdrop" onClick={closeForm}>
					<form className="modal live-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void saveSource(e)}>
						<h2>{editing ? 'Edit stream' : 'Add stream'}</h2>
						<label>
							Name
							<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" required />
						</label>
						<label>
							Channel
							<input
								value={channel}
								onChange={(e) => setChannel(e.target.value)}
								placeholder="Channel URL, @handle, or UC… ID"
								required
							/>
						</label>
						<label>
							Notes
							<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
						</label>
						<label>
							Source mode
							<select value={sourceMode} onChange={(e) => setSourceMode(e.target.value as LiveSourceMode)}>
								<option value="normal">Normal - Playlist Discovery</option>
								<option value="always_on">Always On — 24/7 news, confirm known ID</option>
								<option value="on_demand">On Demand — only when assigned or recovered</option>
								<option value="disabled">Disabled — no polling</option>
							</select>
						</label>
						<div className="live-cats-box">
							<p className="live-cats-legend">Live categories</p>
							<div className="modal-cats">
								{categories.map((cat) => (
									<label key={cat.id} className="check">
										<input
											type="checkbox"
											checked={categoryIds.includes(cat.id)}
											onChange={(e) =>
												setCategoryIds((ids) => (e.target.checked ? [...ids, cat.id] : ids.filter((id) => id !== cat.id)))
											}
										/>
										{cat.name}
									</label>
								))}
								{categories.length === 0 ? <p className="muted">Create Live categories on the Categories tab first.</p> : null}
							</div>
						</div>
						{editSource ? (
							<div className="live-edit-details">
								<p className="muted small">
									Mode {modeLabel(editSource.sourceMode)} · Video ID {editSource.knownLiveVideoId || editSource.liveVideoId || 'none'}
								</p>
								<p className="muted small">
									Status {channelStatus(editSource)} · Last check {relativeTime(editSource.lastStatusCheckAt ?? editSource.liveCheckedAt)} · Next{' '}
									{editSource.nextStatusCheckAt ? relativeTime(editSource.nextStatusCheckAt) : 'Never'}
								</p>
								{streamList(editSource)}
								<div className="live-card-actions">
									<button className="ghost tiny" type="button" onClick={() => void toggleEnabled(editSource)}>
										{editSource.sourceMode === 'disabled' ? 'Enable' : 'Disable'}
									</button>
									<button className="ghost tiny" type="button" onClick={() => void removeSource(editSource.id)}>
										Delete
									</button>
								</div>
							</div>
						) : null}
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={closeForm}>
								Cancel
							</button>
							<button className="ghost" type="submit">
								{editing ? 'Save' : 'Add'}
							</button>
						</div>
					</form>
				</div>
			) : null}
			{editingLayout ? (
				<div className="modal-backdrop" onClick={() => setEditingLayout(null)}>
					<form className="modal live-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void saveLayoutEdit(e)}>
						<h2>Edit layout</h2>
						<label>
							Name
							<input value={layoutEditName} onChange={(e) => setLayoutEditName(e.target.value)} required />
						</label>
						<label>
							Description
							<textarea
								value={layoutEditDesc}
								onChange={(e) => setLayoutEditDesc(e.target.value)}
								placeholder="Optional"
								rows={3}
							/>
						</label>
						<label>
							Grid
							<select value={layoutEditGrid} onChange={(e) => setLayoutEditGrid(Number(e.target.value) as LiveGridSize)}>
								{LIVE_GRID_SIZES.map((size) => (
									<option key={size} value={size}>
										{size}
									</option>
								))}
							</select>
						</label>
						<div className="live-edit-details">
							{layoutDeleteConfirm ? (
								<div className="live-card-actions">
									<p className="muted small">Delete this layout? Slot assignments on the current grid stay as they are.</p>
									<button className="ghost tiny" type="button" onClick={() => setLayoutDeleteConfirm(false)}>
										Keep
									</button>
									<button className="ghost tiny" type="button" onClick={() => void removeLayout(editingLayout.id)}>
										Confirm delete
									</button>
								</div>
							) : (
								<div className="live-card-actions">
									<button className="ghost tiny" type="button" onClick={() => setLayoutDeleteConfirm(true)}>
										Delete
									</button>
								</div>
							)}
						</div>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setEditingLayout(null)}>
								Cancel
							</button>
							<button className="ghost" type="submit">
								Save
							</button>
						</div>
					</form>
				</div>
			) : null}
			{confirmSearch ? (
				<div className="modal-backdrop" onClick={() => setConfirmSearch(false)}>
					<div className="modal live-modal" onClick={(e) => e.stopPropagation()}>
						<h2>Emergency search recovery</h2>
						<p>
							This uses YouTube <code>search.list</code> only for Always On sources that are not live. It would consume about{' '}
							{sources.filter((s) => s.sourceMode === 'always_on' && !s.isLive).length} Search Query
							{sources.filter((s) => s.sourceMode === 'always_on' && !s.isLive).length === 1 ? '' : 's'}. Remaining Quad allowance:{' '}
							{monitor?.searchRemaining ?? 0}. Automatic polling never runs this.
						</p>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setConfirmSearch(false)}>
								Cancel
							</button>
							<button
								className="ghost"
								type="button"
								disabled={(monitor?.searchRemaining ?? 0) < 1}
								onClick={() => void runEmergencySearch()}
							>
								Confirm search
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
