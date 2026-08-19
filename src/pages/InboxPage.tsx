import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CategoryRecord, ChannelRecord, CurrentUser, InboxItem, InboxWatchFields, LiveGridSize, PodcastSubscriptionRecord, WatchedFilter, WatchlistRecord } from '../types';
import { LIVE_GRID_SIZES } from '../types';
import { youtubeWatchUrl } from '../lib/youtubeUrl';
import { FeedYouTubePlayer, type WatchPersistPayload } from '../components/FeedYouTubePlayer';
import { matchesWatchedFilter } from '../lib/watchProgress';
import { isAndroidClient, isNarrowFeeder } from '../lib/androidClient';
import { TEST_APK_PATH, STREAMFEEDER_DISPLAY_NAME } from '../lib/androidRelease';
import { UNCATEGORIZED_CATEGORY_ID, isUncategorizedFilter } from '../lib/categories';
import { qrSvgForUrl } from '../lib/qrSvg';
import { formatSyncCompletion, skippedChannelNames, type SyncWarning } from '../lib/syncStatus';
import { formatFeedHealth, inboxIsStale, inboxItemHeadAt, inboxPageHasMore, prependNewerInboxItems, appendOlderInboxItems } from '../lib/inboxFreshness';
import { playthroughNextId, playthroughQueue, playthroughStartId } from '../lib/playthrough';
import { LivePage } from './LivePage';
import { DiscoverPage } from './DiscoverPage';
import '../styles/app.css';
import '../styles/live.css';
import '../styles/download.css';

interface SyncApiBody {
	error?: { message: string };
	errorSummary?: string | null;
	channelsChecked?: number;
	videosAdded?: number;
	done?: boolean;
	nextOffset?: number;
	nextPageToken?: string;
	pulled?: number;
	want?: number;
	totalChannels?: number;
	channelsSkipped?: number;
	warnings?: SyncWarning[];
	status?: string;
	budgetExhausted?: boolean;
	remainingBudget?: number;
}

interface FeedSyncStatusBody {
	newestInboxPublishedAt?: string | null;
	overdueCount?: number;
	quotaLimited?: boolean;
	reconciledLastTwoHours?: number;
	activeChannels?: number;
}

function syncMessage(body: SyncApiBody, fallback: string): string {
	return body.error?.message || body.errorSummary || fallback;
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	return target.isContentEditable;
}

function buildInboxListQuery(opts: {
	leftTab: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' | 'streams' | 'categories';
	channelId: string | null;
	categoryId: string | null;
	watchlistId: string | null;
	watchedFilter: WatchedFilter;
}): string {
	const inboxQuery = new URLSearchParams();
	if (opts.leftTab === 'streams' && opts.channelId) inboxQuery.set('channelId', opts.channelId);
	if (
		(opts.leftTab === 'inbox' || opts.leftTab === 'snoozed' || opts.leftTab === 'deleted' || opts.leftTab === 'categories') &&
		opts.categoryId
	) {
		inboxQuery.set('categoryId', opts.categoryId);
	}
	if (opts.leftTab === 'snoozed') inboxQuery.set('view', 'snoozed');
	if (opts.leftTab === 'deleted') inboxQuery.set('view', 'deleted');
	if (opts.leftTab === 'watchlist') {
		inboxQuery.set('view', 'watchlist');
		if (opts.watchlistId) inboxQuery.set('watchlistId', opts.watchlistId);
	}
	if (opts.watchedFilter !== 'all') inboxQuery.set('watched', opts.watchedFilter);
	return inboxQuery.toString();
}

function toLocalInputValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function tomorrowMorning(): Date {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(8, 0, 0, 0);
	return d;
}

function relativeRelease(iso: string | null): string {
	if (!iso) return 'Unknown date';
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return 'Unknown date';
	const delta = Date.now() - then;
	const future = delta < 0;
	const seconds = Math.round(Math.abs(delta) / 1000);
	const phrase = (unit: string, n: number) => {
		const label = n === 1 ? `1 ${unit}` : `${n} ${unit}s`;
		return future ? `In ${label}` : `${label} ago`;
	};
	if (seconds < 60) return future ? 'Soon' : 'Just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return phrase('minute', minutes);
	const hours = Math.round(minutes / 60);
	if (hours < 24) return phrase('hour', hours);
	const days = Math.round(hours / 24);
	if (days < 14) return phrase('day', days);
	const weeks = Math.round(days / 7);
	if (weeks < 8) return phrase('week', weeks);
	const months = Math.round(days / 30);
	if (months < 18) return phrase('month', months);
	return phrase('year', Math.round(days / 365));
}

function IconWatchMark() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path fill="currentColor" d="M9.2 16.6 4.8 12.2l1.4-1.4 3 3 8-8 1.4 1.4-9.4 9.4z" />
		</svg>
	);
}

function IconPencil() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
			/>
		</svg>
	);
}

function IconTrash() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v10h-2V9zm4 0h2v10h-2V9zM7 9h2v10H7V9zm-1 12h12a1 1 0 0 0 1-1V8H5v12a1 1 0 0 0 1 1z"
			/>
		</svg>
	);
}

function IconClock() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6 3.2 1.9-.8 1.3L11 13.5V7h2v5.6z"
			/>
		</svg>
	);
}

function IconReload() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M12 6V3L8 7l4 4V8a4 4 0 1 1-4 4H6a6 6 0 1 0 6-6z"
			/>
		</svg>
	);
}

function IconPlay() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path fill="currentColor" d="M8 5v14l11-7z" />
		</svg>
	);
}

function IconRestore() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
		</svg>
	);
}

function IconList() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path fill="currentColor" d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z" />
		</svg>
	);
}

function IconYouTube() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.5V8.5L16 12l-6.4 3.5z"
			/>
		</svg>
	);
}

function IconPhone() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v12h10V5H7zm5 15.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5z"
			/>
		</svg>
	);
}

function IconGear() {
	return (
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.36 2.54c-.59.22-1.14.53-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.63 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.75 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.48.41 1.03.73 1.62.94l.36 2.54c.05.24.25.42.49.42h4c.24 0 .44-.18.49-.42l.36-2.54c.59-.22 1.14-.53 1.62-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
			/>
		</svg>
	);
}

function categoryNames(ids: string[], all: CategoryRecord[]): string {
	const names = ids
		.map((id) => all.find((cat) => cat.id === id)?.name)
		.filter((name): name is string => Boolean(name));
	return names.length ? names.join(', ') : 'No category';
}

function channelCategoryNames(channel: ChannelRecord, all: CategoryRecord[]): string {
	return categoryNames(channel.categoryIds, all);
}

export function InboxPage({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
	const [channels, setChannels] = useState<ChannelRecord[]>([]);
	const [podcasts, setPodcasts] = useState<PodcastSubscriptionRecord[]>([]);
	const [categories, setCategories] = useState<CategoryRecord[]>([]);
	const [items, setItems] = useState<InboxItem[] | null>(null);
	const [inboxCount, setInboxCount] = useState<number | null>(null);
	const [unwatchedCount, setUnwatchedCount] = useState<number | null>(null);
	const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>('all');
	const [channelId, setChannelId] = useState<string | null>(null);
	const [categoryId, setCategoryId] = useState<string | null>(null);
	const [leftTab, setLeftTab] = useState<'inbox' | 'snoozed' | 'deleted' | 'watchlist' | 'streams' | 'categories'>('inbox');
	const [mainSection, setMainSection] = useState<'feed' | 'live' | 'discover'>('feed');
	const [liveSidebarOpen, setLiveSidebarOpen] = useState(true);
	const [liveHeaderStatus, setLiveHeaderStatus] = useState<{ text: string; error: boolean } | null>(null);
	const [liveGridChrome, setLiveGridChrome] = useState<{
		gridSize: LiveGridSize;
		setGrid: (size: LiveGridSize) => void;
	} | null>(null);
	const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
	const leftScrollRef = useRef<HTMLDivElement | null>(null);
	const [watchlists, setWatchlists] = useState<WatchlistRecord[]>([]);
	const [watchlistId, setWatchlistId] = useState<string | null>(null);
	const [newWatchlist, setNewWatchlist] = useState('');
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);
	const [categoryRenameValue, setCategoryRenameValue] = useState('');
	const [watchlisting, setWatchlisting] = useState<InboxItem | null>(null);
	const [snoozing, setSnoozing] = useState<InboxItem | null>(null);
	const [snoozeUntil, setSnoozeUntil] = useState(toLocalInputValue(tomorrowMorning()));
	const [editing, setEditing] = useState<ChannelRecord | null>(null);
	const [editingPodcast, setEditingPodcast] = useState<PodcastSubscriptionRecord | null>(null);
	const [newCategory, setNewCategory] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [syncWarnings, setSyncWarnings] = useState<SyncWarning[]>([]);
	const [showSkipDetails, setShowSkipDetails] = useState(false);
	const [feedHealth, setFeedHealth] = useState<FeedSyncStatusBody | null>(null);
	const inboxHeadRef = useRef<string | null>(null);
	const itemsRef = useRef<InboxItem[] | null>(null);
	const selectedVideoIdRef = useRef<string | null>(null);
	const narrowRef = useRef(false);
	const mergeInboxRef = useRef(false);
	const loadInFlightRef = useRef(0);
	const loadingMoreRef = useRef(false);
	const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
	const [inboxHasMore, setInboxHasMore] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const playerShellRef = useRef<HTMLDivElement | null>(null);
	const playthroughActiveRef = useRef(false);
	const playthroughQueueRef = useRef<InboxItem[]>([]);
	const playthroughAdvancingRef = useRef(false);
	const playthroughHadFullscreenRef = useRef(false);
	const [playthroughActive, setPlaythroughActive] = useState(false);
	const [playthroughItems, setPlaythroughItems] = useState<InboxItem[]>([]);
	const autoStarted = useRef(false);
	const androidClient = isAndroidClient();
	const [narrow, setNarrow] = useState(isNarrowFeeder());
	const [offline, setOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);
	const [mobilePanel, setMobilePanel] = useState<'inbox' | 'watchlists' | 'filters' | 'account'>('inbox');
	const [androidQrOpen, setAndroidQrOpen] = useState(false);
	const [androidQrSvg, setAndroidQrSvg] = useState('');
	const [androidAppVersion, setAndroidAppVersion] = useState<{ versionName: string; versionCode: number } | null>(null);
	const [inboxSelectedIds, setInboxSelectedIds] = useState<string[]>([]);
	const [bulkSnoozeIds, setBulkSnoozeIds] = useState<string[] | null>(null);
	const [bulkWatchlistIds, setBulkWatchlistIds] = useState<string[] | null>(null);

	itemsRef.current = items;
	selectedVideoIdRef.current = selectedVideoId;
	narrowRef.current = narrow;

	const load = useCallback(
		async (signal?: AbortSignal) => {
			loadInFlightRef.current += 1;
			try {
			const qs = buildInboxListQuery({ leftTab, channelId, categoryId, watchlistId, watchedFilter });
			const inboxCountQuery = new URLSearchParams();
			if (categoryId && leftTab !== 'watchlist' && leftTab !== 'categories') {
				inboxCountQuery.set('categoryId', categoryId);
			}
			const countQs = inboxCountQuery.toString();
			const needsSeparateInboxCount = leftTab !== 'inbox';
			const [chRes, inRes, catRes, wlRes, inboxCountRes] = await Promise.all([
				fetch('/api/channels', { credentials: 'same-origin', signal }),
				fetch(qs ? `/api/inbox?${qs}` : '/api/inbox', { credentials: 'same-origin', signal }),
				fetch('/api/categories', { credentials: 'same-origin', signal }),
				fetch('/api/watchlists', { credentials: 'same-origin', signal }),
				needsSeparateInboxCount
					? fetch(countQs ? `/api/inbox?${countQs}` : '/api/inbox', { credentials: 'same-origin', signal })
					: Promise.resolve(null),
			]);
			if (!chRes.ok || !inRes.ok || !catRes.ok || !wlRes.ok || (inboxCountRes && !inboxCountRes.ok)) {
				throw new Error('Could not load subscriptions.');
			}
			const chBody = (await chRes.json()) as { channels: ChannelRecord[]; podcasts?: PodcastSubscriptionRecord[] };
			setChannels(chBody.channels);
			setPodcasts(chBody.podcasts ?? []);
			const inboxBody = (await inRes.json()) as { items: InboxItem[]; count?: number; unwatchedCount?: number; hasMore?: boolean };
			setItems(inboxBody.items);
			setCategories(((await catRes.json()) as { categories: CategoryRecord[] }).categories);
			const nextLists = ((await wlRes.json()) as { watchlists: WatchlistRecord[] }).watchlists;
			setWatchlists(nextLists);
			if (inboxCountRes) {
				const countBody = (await inboxCountRes.json()) as { count?: number; items: InboxItem[]; unwatchedCount?: number };
				setInboxCount(typeof countBody.count === 'number' ? countBody.count : countBody.items.length);
			} else {
				setInboxCount(typeof inboxBody.count === 'number' ? inboxBody.count : inboxBody.items.length);
			}
			setUnwatchedCount(
				typeof inboxBody.unwatchedCount === 'number'
					? inboxBody.unwatchedCount
					: inboxBody.items.filter((item) => !item.watchedAt).length,
			);
			inboxHeadRef.current = inboxBody.items[0] ? inboxItemHeadAt(inboxBody.items[0]) : null;
			setInboxHasMore(typeof inboxBody.hasMore === 'boolean' ? inboxBody.hasMore : inboxPageHasMore(inboxBody.items.length));
			setLoadingMore(false);
			loadingMoreRef.current = false;
			} finally {
				loadInFlightRef.current = Math.max(0, loadInFlightRef.current - 1);
			}
		},
		[channelId, categoryId, leftTab, watchlistId, watchedFilter],
	);

	const checkInboxFreshness = useCallback(async () => {
		if (androidClient) return;
		try {
			const res = await fetch('/api/sync/status', { credentials: 'same-origin' });
			if (!res.ok) return;
			const body = (await res.json()) as FeedSyncStatusBody;
			setFeedHealth(body);
			if (!inboxIsStale(inboxHeadRef.current, body.newestInboxPublishedAt)) return;
			const current = itemsRef.current;
			if (!current || mergeInboxRef.current || loadInFlightRef.current) return;
			mergeInboxRef.current = true;
			try {
				const qs = buildInboxListQuery({ leftTab, channelId, categoryId, watchlistId, watchedFilter });
				const inRes = await fetch(qs ? `/api/inbox?${qs}` : '/api/inbox', { credentials: 'same-origin' });
				if (!inRes.ok || loadInFlightRef.current) return;
				const inboxBody = (await inRes.json()) as { items: InboxItem[]; count?: number; unwatchedCount?: number };
				const latest = itemsRef.current ?? current;
				const previousFirstId = latest[0]?.videoId ?? null;
				const merged = prependNewerInboxItems(latest, inboxBody.items, inboxHeadRef.current);
				inboxHeadRef.current =
					body.newestInboxPublishedAt ?? (merged[0] ? inboxItemHeadAt(merged[0]) : null);
				if (typeof inboxBody.unwatchedCount === 'number') setUnwatchedCount(inboxBody.unwatchedCount);
				if (leftTab === 'inbox' && typeof inboxBody.count === 'number') setInboxCount(inboxBody.count);
				if (merged === latest) return;
				setItems(merged);
				if (!selectedVideoIdRef.current && !narrowRef.current && previousFirstId) {
					setSelectedVideoId(previousFirstId);
				}
			} finally {
				mergeInboxRef.current = false;
			}
		} catch {
			/* keep the current list */
		}
	}, [androidClient, channelId, categoryId, leftTab, watchlistId, watchedFilter]);

	const loadMoreInbox = useCallback(async () => {
		if (!inboxHasMore || loadingMoreRef.current || loadInFlightRef.current || mergeInboxRef.current) return;
		const current = itemsRef.current;
		const lastId = current?.[current.length - 1]?.videoId;
		if (!lastId) return;
		loadingMoreRef.current = true;
		setLoadingMore(true);
		try {
			const qs = buildInboxListQuery({ leftTab, channelId, categoryId, watchlistId, watchedFilter });
			const pageQuery = new URLSearchParams(qs);
			pageQuery.set('beforeId', lastId);
			const inRes = await fetch(`/api/inbox?${pageQuery.toString()}`, { credentials: 'same-origin' });
			if (!inRes.ok || loadInFlightRef.current) return;
			const inboxBody = (await inRes.json()) as { items: InboxItem[]; hasMore?: boolean };
			const latest = itemsRef.current ?? current ?? [];
			const merged = appendOlderInboxItems(latest, inboxBody.items);
			const pageHasMore = typeof inboxBody.hasMore === 'boolean' ? inboxBody.hasMore : inboxPageHasMore(inboxBody.items.length);
			setInboxHasMore(merged !== latest && pageHasMore);
			if (merged !== latest) setItems(merged);
		} catch {
			/* keep the current list */
		} finally {
			loadingMoreRef.current = false;
			setLoadingMore(false);
		}
	}, [inboxHasMore, leftTab, channelId, categoryId, watchlistId, watchedFilter]);

	useEffect(() => {
		const ac = new AbortController();
		load(ac.signal).catch((err: unknown) => {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			setError(err instanceof Error ? err.message : 'Could not load inbox.');
		});
		return () => ac.abort();
	}, [load]);

	useEffect(() => {
		const onResize = () => setNarrow(isNarrowFeeder());
		const onOffline = () => setOffline(true);
		const onOnline = () => {
			setOffline(false);
			void load().catch(() => undefined);
		};
		const onVisible = () => {
			if (document.visibilityState === 'visible') void checkInboxFreshness();
		};
		window.addEventListener('resize', onResize);
		window.addEventListener('offline', onOffline);
		window.addEventListener('online', onOnline);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			window.removeEventListener('resize', onResize);
			window.removeEventListener('offline', onOffline);
			window.removeEventListener('online', onOnline);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}, [load, checkInboxFreshness]);

	useEffect(() => {
		if (androidClient || mainSection !== 'feed') return;
		const id = window.setInterval(() => {
			void checkInboxFreshness();
		}, 60_000);
		void checkInboxFreshness();
		return () => window.clearInterval(id);
	}, [androidClient, mainSection, checkInboxFreshness]);

	useEffect(() => {
		const sentinel = loadMoreSentinelRef.current;
		if (!sentinel || !inboxHasMore) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) void loadMoreInbox();
			},
			{ root: leftScrollRef.current, rootMargin: '480px' },
		);
		io.observe(sentinel);
		return () => io.disconnect();
	}, [inboxHasMore, loadMoreInbox, items?.length, leftTab]);

	useEffect(() => {
		if (!playthroughActive || !selectedVideoId) return;
		const el = playerShellRef.current;
		if (!el || document.fullscreenElement === el) return;
		const req = el.requestFullscreen?.bind(el) ?? (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(el);
		if (!req) return;
		void Promise.resolve(req())
			.then(() => {
				playthroughHadFullscreenRef.current = true;
			})
			.catch(() => undefined);
	}, [playthroughActive, selectedVideoId]);

	useEffect(() => {
		const onFs = () => {
			const doc = document as Document & { webkitFullscreenElement?: Element | null };
			const active = document.fullscreenElement ?? doc.webkitFullscreenElement;
			if (playthroughActiveRef.current && playthroughHadFullscreenRef.current && !active) {
				stopPlaythrough();
			}
		};
		document.addEventListener('fullscreenchange', onFs);
		document.addEventListener('webkitfullscreenchange', onFs);
		return () => {
			document.removeEventListener('fullscreenchange', onFs);
			document.removeEventListener('webkitfullscreenchange', onFs);
		};
	}, []);

	useEffect(() => {
		if (androidClient && mainSection !== 'feed') setMainSection('feed');
	}, [androidClient, mainSection]);

	useEffect(() => {
		const onPop = () => setSelectedVideoId(null);
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	}, []);

	useEffect(() => {
		leftScrollRef.current?.scrollTo({ top: 0 });
	}, [categoryId, leftTab, watchlistId, channelId]);

	function selectFeedView(tab: 'inbox' | 'snoozed' | 'deleted' | 'streams') {
		stopPlaythrough();
		setLeftTab(tab);
		setCategoryId(null);
		setInboxSelectedIds([]);
		requestAnimationFrame(() => {
			leftScrollRef.current?.scrollTo({ top: 0 });
			requestAnimationFrame(() => leftScrollRef.current?.scrollTo({ top: 0 }));
		});
	}

	useEffect(() => {
		setInboxSelectedIds([]);
		setBulkSnoozeIds(null);
		setBulkWatchlistIds(null);
	}, [leftTab]);

	useEffect(() => {
		if (leftTab !== 'streams' || !channelId || !categoryId) return;
		const selected = channels.find((ch) => ch.channelId === channelId);
		const matches = isUncategorizedFilter(categoryId)
			? (selected?.categoryIds.length ?? 0) === 0
			: Boolean(selected?.categoryIds.includes(categoryId));
		if (selected && !matches) {
			setChannelId(null);
			setSelectedVideoId(null);
		}
	}, [leftTab, channelId, categoryId, channels]);

	function channelMatchesCategory(channel: ChannelRecord, filterId: string | null): boolean {
		if (!filterId) return true;
		if (isUncategorizedFilter(filterId)) return channel.categoryIds.length === 0;
		return channel.categoryIds.includes(filterId);
	}

	function podcastMatchesCategory(podcast: PodcastSubscriptionRecord, filterId: string | null): boolean {
		if (!filterId) return true;
		if (isUncategorizedFilter(filterId)) return podcast.categoryIds.length === 0;
		return podcast.categoryIds.includes(filterId);
	}

	const listMultiSelectEnabled =
		!androidClient && (leftTab === 'inbox' || leftTab === 'snoozed' || leftTab === 'deleted');

	function dismissStatusBanner() {
		setStatus(null);
		setError(null);
		setSyncWarnings([]);
		setShowSkipDetails(false);
	}

	function nextVideoIdAfterRemoval(list: InboxItem[], removedId: string): string | null {
		const index = list.findIndex((item) => item.videoId === removedId);
		if (index < 0) return list[0]?.videoId ?? null;
		return list[index + 1]?.videoId ?? list[index - 1]?.videoId ?? null;
	}

	async function syncNow() {
		setSyncing(true);
		setError(null);
		setSyncWarnings([]);
		setShowSkipDetails(false);
		const targetCount = streamsList.length;
		setStatus(`Fetching videos… 0 / ${targetCount} channels`);
		try {
			let offset = 0;
			let added = 0;
			const accumulatedWarnings: SyncWarning[] = [];
			const params = new URLSearchParams({ force: '1', offset: '0' });
			if (categoryId) params.set('categoryId', categoryId);
			else params.set('scope', 'all');
			for (;;) {
				params.set('offset', String(offset));
				const content = await fetch(`/api/sync/content?${params.toString()}`, { method: 'POST', credentials: 'same-origin' });
				const contentBody = (await content.json()) as SyncApiBody;
				if (!content.ok) throw new Error(syncMessage(contentBody, 'Video sync failed.'));
				added += contentBody.videosAdded ?? 0;
				if (contentBody.warnings?.length) accumulatedWarnings.push(...contentBody.warnings);
				const next = contentBody.nextOffset ?? offset;
				setStatus(`Fetching videos… ${next} / ${contentBody.totalChannels ?? targetCount} channels`);
				await load();
				if (contentBody.done) break;
				if (next === offset) throw new Error('Video sync stalled without progressing.');
				offset = next;
			}
			setSyncWarnings(accumulatedWarnings);
			setStatus(formatSyncCompletion(added, accumulatedWarnings));
		} catch (err: unknown) {
			setStatus(null);
			setSyncWarnings([]);
			setError(err instanceof Error ? err.message : 'Sync failed.');
			await load().catch(() => undefined);
		} finally {
			setSyncing(false);
		}
	}

	async function catchUpPodcast(podcast: PodcastSubscriptionRecord) {
		const pull = podcast.maxEpisodesToPull;
		if (pull < 1) {
			setError('Set max episodes to pull above 0 on Edit, then catch up.');
			return;
		}
		setSyncing(true);
		setError(null);
		setStatus(`Catching up ${podcast.title}… 0 / ${pull}`);
		try {
			let pulled = 0;
			let added = 0;
			const want = Math.min(500, pull);
			for (;;) {
				setStatus(`Catching up ${podcast.title}… ${pulled} / ${want}`);
				const res = await fetch(`/api/podcasts/${encodeURIComponent(podcast.podcastId)}/catchup`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ pulled }),
				});
				const body = (await res.json().catch(() => ({}))) as SyncApiBody & {
					episodesAdded?: number;
					pulled?: number;
					want?: number;
					done?: boolean;
					errorSummary?: string;
				};
				if (!res.ok) throw new Error(syncMessage(body, 'Catch up failed.'));
				added += body.episodesAdded ?? 0;
				pulled = body.pulled ?? pulled;
				const nextWant = body.want ?? want;
				setStatus(`Catching up ${podcast.title}… ${pulled} / ${nextWant}`);
				await load();
				if (body.done) break;
				if ((body.episodesAdded ?? 0) < 1) break;
			}
			setStatus(`Added ${added} episodes from ${podcast.title}.`);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Catch up failed.');
			await load().catch(() => undefined);
		} finally {
			setSyncing(false);
		}
	}

	async function catchUpChannel(channelId: string, title: string, pull: number) {
		if (pull < 1) {
			setError('Set max videos to pull above 0 on Edit, then catch up.');
			return;
		}
		setSyncing(true);
		setError(null);
		setStatus(`Catching up ${title}… 0 / ${pull}`);
		try {
			let pageToken = '';
			let pulled = 0;
			let added = 0;
			const want = Math.min(500, pull);
			for (;;) {
				setStatus(`Catching up ${title}… ${pulled} / ${want}`);
				const res = await fetch('/api/sync/catchup', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ channelId, pageToken, pulled }),
				});
				const body = (await res.json().catch(() => ({}))) as SyncApiBody;
				if (!res.ok) throw new Error(syncMessage(body, 'Catch up failed.'));
				added += body.videosAdded ?? 0;
				pulled = body.pulled ?? pulled;
				const nextWant = body.want ?? want;
				setStatus(`Catching up ${title}… ${pulled} / ${nextWant}`);
				await load();
				if (body.budgetExhausted) {
					setStatus(body.errorSummary || 'Catch-up paused: API budget exhausted. Resume to continue.');
					break;
				}
				if (body.done) break;
				pageToken = body.nextPageToken ?? '';
				if (!pageToken) break;
			}
			setStatus(`Added ${added} videos from ${title}.`);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Catch up failed.');
			await load().catch(() => undefined);
		} finally {
			setSyncing(false);
		}
	}

	async function syncSubscriptionsOnly() {
		setSyncing(true);
		setError(null);
		setStatus('Syncing subscriptions…');
		try {
			const sub = await fetch('/api/sync/subscriptions?force=1', { method: 'POST', credentials: 'same-origin' });
			const subBody = (await sub.json()) as SyncApiBody;
			if (!sub.ok) throw new Error(syncMessage(subBody, 'Subscription sync failed.'));
			await load();
			setStatus(`Updated ${subBody.channelsChecked ?? 0} subscriptions.`);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Subscription sync failed.');
			await load().catch(() => undefined);
		} finally {
			setSyncing(false);
		}
	}

	useEffect(() => {
		if (autoStarted.current) return;
		if (items === null || syncing) return;
		if (channels.length > 0) return;
		autoStarted.current = true;
		void syncNow();
	}, [channels.length, items, syncing]);

	async function addCategory(event: FormEvent) {
		event.preventDefault();
		const res = await fetch('/api/categories', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: newCategory }),
		});
		if (!res.ok) return;
		setNewCategory('');
		await load();
	}

	async function persistPodcastEdit(podcast: PodcastSubscriptionRecord, form: FormData): Promise<number | null> {
		const maxEpisodesToPull = Number(form.get('maxEpisodesToPull') || 0);
		const res = await fetch(`/api/podcasts/${encodeURIComponent(podcast.podcastId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({
				followInInbox: form.get('followInInbox') === 'on',
				maxEpisodesToPull,
				categoryIds: form.getAll('categoryIds').map(String),
			}),
		});
		if (!res.ok) return null;
		return maxEpisodesToPull;
	}

	async function savePodcastEdit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!editingPodcast) return;
		const pull = await persistPodcastEdit(editingPodcast, new FormData(event.currentTarget));
		setEditingPodcast(null);
		if (pull === null) {
			setError('Could not save podcast settings.');
			return;
		}
		await load();
	}

	async function catchUpPodcastFromEdit(form: HTMLFormElement) {
		if (!editingPodcast || syncing) return;
		const formData = new FormData(form);
		const pull = Number(formData.get('maxEpisodesToPull') || editingPodcast.maxEpisodesToPull);
		const podcast = editingPodcast;
		setEditingPodcast(null);
		await persistPodcastEdit(podcast, formData);
		await load();
		await catchUpPodcast({ ...podcast, maxEpisodesToPull: pull });
	}

	async function persistChannelEdit(channel: ChannelRecord, form: FormData): Promise<number | null> {
		const selected = form.getAll('categoryIds').map(String);
		const maxVideosToPull = Number(form.get('maxVideosToPull') || 0);
		const res = await fetch(`/api/channels/${encodeURIComponent(channel.channelId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({
				followInInbox: form.get('followInInbox') === 'on',
				maxVideosToPull,
				categoryIds: selected,
			}),
		});
		if (!res.ok) {
			setError('Could not save channel settings.');
			return null;
		}
		return maxVideosToPull;
	}

	async function saveEdit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!editing) return;
		const pull = await persistChannelEdit(editing, new FormData(event.currentTarget));
		if (pull === null) return;
		setEditing(null);
		await load();
	}

	async function catchUpFromEdit(form: HTMLFormElement) {
		if (!editing || syncing) return;
		const channel = editing;
		const pull = await persistChannelEdit(channel, new FormData(form));
		if (pull === null) return;
		setEditing(null);
		await load();
		await catchUpChannel(channel.channelId, channel.title, pull);
	}

	async function removeCategory(id: string) {
		const attached = channels.some((ch) => ch.categoryIds.includes(id));
		if (attached) {
			setError('Remove this category from all streams (Edit on Subscriptions) before deleting it.');
			return;
		}
		if (!window.confirm('Delete this category?')) return;
		setError(null);
		const res = await fetch(`/api/categories/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(body.error?.message || 'Could not delete category.');
			return;
		}
		if (categoryId === id) setCategoryId(null);
		if (renamingCategoryId === id) setRenamingCategoryId(null);
		await load();
	}

	async function saveCategoryName(event: FormEvent) {
		event.preventDefault();
		if (!renamingCategoryId) return;
		setError(null);
		const res = await fetch(`/api/categories/${encodeURIComponent(renamingCategoryId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: categoryRenameValue }),
		});
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(body.error?.message || 'Could not rename category.');
			return;
		}
		setRenamingCategoryId(null);
		setCategoryRenameValue('');
		await load();
	}

	async function addWatchlist(event: FormEvent) {
		event.preventDefault();
		setError(null);
		const res = await fetch('/api/watchlists', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: newWatchlist }),
		});
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(body.error?.message || 'Could not create watchlist.');
			return;
		}
		setNewWatchlist('');
		await load();
	}

	async function saveWatchlistName(event: FormEvent) {
		event.preventDefault();
		if (!renamingId) return;
		setError(null);
		const res = await fetch(`/api/watchlists/${encodeURIComponent(renamingId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ name: renameValue }),
		});
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(body.error?.message || 'Could not rename watchlist.');
			return;
		}
		setRenamingId(null);
		setRenameValue('');
		await load();
	}

	async function removeWatchlist(id: string, videoCount: number) {
		if (videoCount > 0) {
			setError('Remove all videos from this watchlist before deleting it.');
			return;
		}
		if (!window.confirm('Delete this empty watchlist?')) return;
		setError(null);
		const res = await fetch(`/api/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
		if (!res.ok) {
			setError(body.error?.message || 'Could not delete watchlist.');
			return;
		}
		if (watchlistId === id) setWatchlistId(null);
		await load();
	}

	async function saveToWatchlist(videoId: string, listId: string) {
		if (!listId) {
			setError('Create a watchlist first.');
			return;
		}
		const res = await fetch(`/api/watchlists/${encodeURIComponent(listId)}/items`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ videoId }),
		});
		if (!res.ok) {
			setError('Could not add to watchlist.');
			return;
		}
		setWatchlisting(null);
		if (selectedVideoId === videoId) setSelectedVideoId(null);
		await load();
	}

	async function saveBulkToWatchlist(listId: string) {
		if (!bulkWatchlistIds?.length) return;
		if (!listId) {
			setError('Create a watchlist first.');
			return;
		}
		const ids = [...bulkWatchlistIds];
		setBulkWatchlistIds(null);
		setInboxSelectedIds([]);
		let failed = false;
		for (const videoId of ids) {
			const res = await fetch(`/api/watchlists/${encodeURIComponent(listId)}/items`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ videoId }),
			});
			if (!res.ok) failed = true;
		}
		if (failed) setError('Could not add some videos to the watchlist.');
		await load();
	}

	async function takeOffWatchlist(videoId: string) {
		if (!watchlistId) return;
		const previous = items;
		const nextId = selectedVideoId === videoId && previous ? nextVideoIdAfterRemoval(previous, videoId) : selectedVideoId;
		if (previous) setItems(previous.filter((item) => item.videoId !== videoId));
		await fetch(`/api/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(videoId)}`, {
			method: 'DELETE',
			credentials: 'same-origin',
		});
		if (selectedVideoId === videoId) setSelectedVideoId(nextId);
		await load();
	}

	async function patchInbox(
		videoId: string,
		body: { action: 'delete' | 'snooze' | 'unsnooze' | 'restore' | 'notes'; until?: string; notes?: string },
	) {
		const previous = items;
		const nextId =
			body.action !== 'notes' && selectedVideoId === videoId && previous
				? nextVideoIdAfterRemoval(previous, videoId)
				: selectedVideoId;
		if (previous && body.action !== 'notes') {
			setItems(previous.filter((item) => item.videoId !== videoId));
		}
		const res = await fetch(`/api/inbox/${encodeURIComponent(videoId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			if (previous) setItems(previous);
			setError('Could not update that video.');
			return false;
		}
		if (body.action !== 'notes' && selectedVideoId === videoId) setSelectedVideoId(nextId);
		await load();
		return true;
	}

	function applyWatchFields(videoId: string, fields: InboxWatchFields) {
		setItems((prev) => {
			if (!prev) return prev;
			const next = prev.map((item) => (item.videoId === videoId ? { ...item, ...fields } : item));
			return next.filter((item) => matchesWatchedFilter(item.watchedAt, watchedFilter));
		});
		const previous = items?.find((item) => item.videoId === videoId);
		if (previous && !previous.watchedAt && fields.watchedAt) {
			setUnwatchedCount((count) => Math.max(0, (count ?? 1) - 1));
		} else if (previous?.watchedAt && !fields.watchedAt) {
			setUnwatchedCount((count) => (count ?? 0) + 1);
		}
	}

	async function persistWatchProgress(
		videoId: string,
		payload: WatchPersistPayload,
		options?: { keepalive?: boolean },
	) {
		const body = JSON.stringify({
			action: 'progress',
			playbackSeconds: payload.playbackSeconds,
			lastPositionSeconds: payload.lastPositionSeconds,
			ended: payload.ended || undefined,
		});
		try {
			if (payload.ended) advancePlaythrough(videoId);
			if (options?.keepalive) {
				void fetch(`/api/inbox/${encodeURIComponent(videoId)}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					keepalive: true,
					body,
				});
				return;
			}
			const res = await fetch(`/api/inbox/${encodeURIComponent(videoId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body,
			});
			if (!res.ok) return;
			const data = (await res.json()) as InboxWatchFields;
			applyWatchFields(videoId, data);
		} catch {
			/* unload keepalive may not expose a body */
		}
	}

	async function toggleWatched(item: InboxItem) {
		const res = await fetch(`/api/inbox/${encodeURIComponent(item.videoId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ action: item.watchedAt ? 'unwatch' : 'watch' }),
		});
		if (!res.ok) {
			setError('Could not update watched status.');
			return;
		}
		const data = (await res.json()) as InboxWatchFields;
		applyWatchFields(item.videoId, data);
	}

	async function markAllWatched() {
		const pending = unwatchedCount ?? 0;
		if (pending >= 20 && !window.confirm(`Mark ${pending} videos as watched?`)) return;
		const query = new URLSearchParams();
		if (leftTab === 'streams' && channelId) query.set('channelId', channelId);
		if ((leftTab === 'inbox' || leftTab === 'snoozed' || leftTab === 'deleted' || leftTab === 'categories') && categoryId) {
			query.set('categoryId', categoryId);
		}
		if (leftTab === 'snoozed') query.set('view', 'snoozed');
		if (leftTab === 'deleted') query.set('view', 'deleted');
		if (leftTab === 'watchlist') {
			query.set('view', 'watchlist');
			if (watchlistId) query.set('watchlistId', watchlistId);
		}
		if (watchedFilter !== 'all') query.set('watched', watchedFilter);
		const qs = query.toString();
		const res = await fetch(qs ? `/api/inbox/watch-all?${qs}` : '/api/inbox/watch-all', {
			method: 'POST',
			credentials: 'same-origin',
		});
		if (!res.ok) {
			setError('Could not mark videos as watched.');
			return;
		}
		const now = new Date().toISOString();
		setItems((prev) => {
			if (!prev) return prev;
			const next = prev.map((item) =>
				item.watchedAt ? item : { ...item, watchedAt: now, watchUpdatedAt: now },
			);
			return next.filter((item) => matchesWatchedFilter(item.watchedAt, watchedFilter));
		});
		setUnwatchedCount(0);
	}

	function watchFilterBar() {
		return (
			<div className="watch-filter" role="group" aria-label="Watched filter">
				<button
					className={watchedFilter === 'all' ? 'tab active' : 'tab'}
					type="button"
					onClick={() => setWatchedFilter('all')}
				>
					All
				</button>
				<button
					className={watchedFilter === 'unwatched' ? 'tab active' : 'tab'}
					type="button"
					onClick={() => setWatchedFilter('unwatched')}
				>
					Unwatched
				</button>
				<button
					className={watchedFilter === 'watched' ? 'tab active' : 'tab'}
					type="button"
					onClick={() => setWatchedFilter('watched')}
				>
					Watched
				</button>
				{unwatchedCount == null ? null : <span className="muted">{unwatchedCount} unwatched</span>}
				<button className="ghost tiny" type="button" onClick={() => void markAllWatched()}>
					Mark all watched
				</button>
			</div>
		);
	}

	async function confirmSnooze(event: FormEvent) {
		event.preventDefault();
		const until = new Date(snoozeUntil);
		if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) {
			setError('Pick a future date and time.');
			return;
		}
		if (bulkSnoozeIds?.length) {
			const ids = [...bulkSnoozeIds];
			const previous = items;
			if (previous) setItems(previous.filter((item) => !ids.includes(item.videoId)));
			setBulkSnoozeIds(null);
			setInboxSelectedIds([]);
			if (selectedVideoId && ids.includes(selectedVideoId) && previous) {
				const remaining = previous.filter((item) => !ids.includes(item.videoId));
				setSelectedVideoId(remaining[0]?.videoId ?? null);
			}
			let failed = false;
			for (const videoId of ids) {
				const res = await fetch(`/api/inbox/${encodeURIComponent(videoId)}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ action: 'snooze', until: until.toISOString() }),
				});
				if (!res.ok) failed = true;
			}
			if (failed) {
				if (previous) setItems(previous);
				setError('Could not snooze some videos.');
			}
			await load();
			return;
		}
		if (!snoozing) return;
		const ok = await patchInbox(snoozing.videoId, { action: 'snooze', until: until.toISOString() });
		if (ok) setSnoozing(null);
	}

	async function bulkPatchSelected(action: 'delete' | 'unsnooze' | 'restore', errorMessage: string) {
		const ids = [...inboxSelectedIds];
		if (!ids.length) return;
		const previous = items;
		if (previous) setItems(previous.filter((item) => !ids.includes(item.videoId)));
		setInboxSelectedIds([]);
		if (selectedVideoId && ids.includes(selectedVideoId) && previous) {
			const remaining = previous.filter((item) => !ids.includes(item.videoId));
			setSelectedVideoId(remaining[0]?.videoId ?? null);
		}
		let failed = false;
		for (const videoId of ids) {
			const res = await fetch(`/api/inbox/${encodeURIComponent(videoId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ action }),
			});
			if (!res.ok) failed = true;
		}
		if (failed) {
			if (previous) setItems(previous);
			setError(errorMessage);
		}
		await load();
	}

	async function bulkDeleteSelected() {
		await bulkPatchSelected('delete', 'Could not delete some videos.');
	}

	async function bulkUnsnoozeSelected() {
		await bulkPatchSelected('unsnooze', 'Could not remove snooze from some videos.');
	}

	async function bulkRestoreSelected() {
		await bulkPatchSelected('restore', 'Could not restore some videos.');
	}

	function listDeleteKeyBlocked(): boolean {
		if (androidClient || mainSection !== 'feed' || playthroughActive) return true;
		if (snoozing || bulkSnoozeIds || watchlisting || bulkWatchlistIds || editing) return true;
		if (mobilePanel === 'account' || androidQrOpen) return true;
		return false;
	}

	function currentFeedDeleteMode(): 'inbox' | 'snoozed' | 'watchlist' | 'streams' | null {
		switch (leftTab) {
			case 'inbox':
				return 'inbox';
			case 'snoozed':
				return 'snoozed';
			case 'deleted':
				return null;
			case 'watchlist':
				return watchlistId ? 'watchlist' : null;
			case 'streams':
				return channelId ? 'streams' : null;
			case 'categories':
				return categoryId ? 'inbox' : null;
			default:
				return null;
		}
	}

	async function removeFromCurrentList() {
		if (listDeleteKeyBlocked()) return;
		const mode = currentFeedDeleteMode();
		if (inboxSelectedIds.length > 0 && listMultiSelectEnabled && (mode === 'inbox' || mode === 'snoozed')) {
			await bulkDeleteSelected();
			return;
		}
		if (!mode || !selectedVideoId) return;
		switch (mode) {
			case 'inbox':
			case 'snoozed':
			case 'streams':
				await patchInbox(selectedVideoId, { action: 'delete' });
				break;
			case 'watchlist':
				await takeOffWatchlist(selectedVideoId);
				break;
		}
	}

	const listDeleteKeyRef = useRef<(event: KeyboardEvent) => void>(() => {});
	listDeleteKeyRef.current = (event: KeyboardEvent) => {
		if (event.key !== 'Delete' && event.key !== 'Backspace') return;
		if (isTypingTarget(event.target)) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (listDeleteKeyBlocked()) return;
		const mode = currentFeedDeleteMode();
		const hasBulkDelete =
			inboxSelectedIds.length > 0 && listMultiSelectEnabled && (mode === 'inbox' || mode === 'snoozed');
		if (!hasBulkDelete && (!mode || !selectedVideoId)) return;
		event.preventDefault();
		void removeFromCurrentList();
	};

	useEffect(() => {
		function onListDeleteKey(event: KeyboardEvent) {
			listDeleteKeyRef.current(event);
		}
		window.addEventListener('keydown', onListDeleteKey);
		return () => window.removeEventListener('keydown', onListDeleteKey);
	}, []);

	function toggleInboxSelect(videoId: string) {
		setInboxSelectedIds((current) =>
			current.includes(videoId) ? current.filter((id) => id !== videoId) : [...current, videoId],
		);
	}

	const phoneLayout = androidClient || narrow;
	const streamsThreeCol = !androidClient && !phoneLayout && leftTab === 'streams';
	const watchlistThreeCol = !androidClient && !phoneLayout && leftTab === 'watchlist';
	const categoryThreeCol = !androidClient && !phoneLayout && leftTab === 'categories';
	const feedThreeCol = streamsThreeCol || watchlistThreeCol || categoryThreeCol;
	const streamsList = categoryId ? channels.filter((ch) => channelMatchesCategory(ch, categoryId)) : channels;
	const podcastsList = categoryId ? podcasts.filter((p) => podcastMatchesCategory(p, categoryId)) : podcasts;
	type SubscriptionRow =
		| { kind: 'youtube'; data: ChannelRecord }
		| { kind: 'podcast'; data: PodcastSubscriptionRecord };
	const subscriptionRows: SubscriptionRow[] = [
		...streamsList.map((data) => ({ kind: 'youtube' as const, data })),
		...podcastsList.map((data) => ({ kind: 'podcast' as const, data })),
	].sort((a, b) => a.data.title.localeCompare(b.data.title));
	const visibleItems = items?.filter((item) => matchesWatchedFilter(item.watchedAt, watchedFilter)) ?? null;
	const playthroughCurrent = playthroughActive
		? playthroughItems.find((item) => item.videoId === selectedVideoId) ?? null
		: null;
	const selectedVideo =
		playthroughCurrent ??
		visibleItems?.find((item) => item.videoId === selectedVideoId) ??
		(phoneLayout ? null : (visibleItems?.[0] ?? null));

	function stopPlaythrough() {
		playthroughActiveRef.current = false;
		playthroughHadFullscreenRef.current = false;
		setPlaythroughActive(false);
		setPlaythroughItems([]);
		playthroughQueueRef.current = [];
		const doc = document as Document & {
			webkitFullscreenElement?: Element | null;
			webkitExitFullscreen?: () => Promise<void>;
		};
		const fs = document.fullscreenElement ?? doc.webkitFullscreenElement;
		if (fs) {
			void (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
		}
	}

	function advancePlaythrough(currentId: string) {
		if (!playthroughActiveRef.current) return;
		const ids = playthroughQueueRef.current.map((item) => item.videoId);
		const next = playthroughNextId(ids, currentId);
		if (!next) {
			stopPlaythrough();
			return;
		}
		playthroughAdvancingRef.current = true;
		openVideo(next);
		playthroughAdvancingRef.current = false;
	}

	function startPlaythrough(list: InboxItem[]) {
		const queue = playthroughQueue(list);
		const ids = queue.map((item) => item.videoId);
		const startId = playthroughStartId(ids, selectedVideoId);
		if (!startId) return;
		playthroughQueueRef.current = queue;
		playthroughActiveRef.current = true;
		playthroughHadFullscreenRef.current = false;
		setPlaythroughItems(queue);
		setPlaythroughActive(true);
		playthroughAdvancingRef.current = true;
		openVideo(startId);
		playthroughAdvancingRef.current = false;
	}

	function openVideo(videoId: string) {
		if (playthroughActiveRef.current && !playthroughAdvancingRef.current) stopPlaythrough();
		setSelectedVideoId(videoId);
		if (phoneLayout) history.pushState({ feederVideo: videoId }, '');
	}

	function watchlistButton(item: InboxItem) {
		return (
			<button
				className="icon-btn"
				type="button"
				title="Add to watchlist"
				aria-label="Add to watchlist"
				onClick={() => setWatchlisting(item)}
			>
				<IconList />
			</button>
		);
	}

	function youtubeOpenButton(item: InboxItem) {
		return (
			<a
				className="icon-btn"
				href={youtubeWatchUrl(item.videoId)}
				target="_blank"
				rel="noreferrer"
				title="Open on YouTube"
				aria-label="Open on YouTube"
			>
				<IconYouTube />
			</a>
		);
	}

	function watchToggleButton(item: InboxItem) {
		return (
			<button
				className="icon-btn"
				type="button"
				title={item.watchedAt ? 'Mark as unwatched' : 'Mark as watched'}
				aria-label={item.watchedAt ? 'Mark as unwatched' : 'Mark as watched'}
				aria-pressed={Boolean(item.watchedAt)}
				onClick={() => void toggleWatched(item)}
			>
				<IconWatchMark />
			</button>
		);
	}

	function renderPreview(item: InboxItem, mode: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' | 'streams') {
		return (
			<div className="preview">
				<header className="preview-header">
					<div className="preview-identity">
						<span className="video-title">{item.title}</span>
						<small className="muted">
							{item.channelTitle} · {relativeRelease(item.publishedAt)}
						</small>
					</div>
					<div className="preview-header-actions">
						{mode === 'deleted' ? (
							<>
								<button
									className="icon-btn"
									type="button"
									title="Restore"
									aria-label="Restore"
									onClick={() => void patchInbox(item.videoId, { action: 'restore' })}
								>
									<IconRestore />
								</button>
								{youtubeOpenButton(item)}
								{watchToggleButton(item)}
								{watchlistButton(item)}
							</>
						) : mode === 'streams' ? (
							<>
								<button
									className="icon-btn"
									type="button"
									title="Delete"
									aria-label="Delete"
									onClick={() => void patchInbox(item.videoId, { action: 'delete' })}
								>
									<IconTrash />
								</button>
								{youtubeOpenButton(item)}
								{watchToggleButton(item)}
								{watchlistButton(item)}
							</>
						) : (
							<>
								<button
									className="icon-btn"
									type="button"
									title="Delete"
									aria-label="Delete"
									onClick={() => void patchInbox(item.videoId, { action: 'delete' })}
								>
									<IconTrash />
								</button>
								{mode === 'watchlist' ? (
									<button
										className="icon-btn"
										type="button"
										title="Remove from watchlist"
										aria-label="Remove from watchlist"
										onClick={() => void takeOffWatchlist(item.videoId)}
									>
										<IconRestore />
									</button>
								) : mode === 'snoozed' ? (
									<button
										className="icon-btn"
										type="button"
										title="Remove snooze"
										aria-label="Remove snooze"
										onClick={() => void patchInbox(item.videoId, { action: 'unsnooze' })}
									>
										<IconClock />
									</button>
								) : (
									<button
										className="icon-btn"
										type="button"
										title="Snooze"
										aria-label="Snooze"
										onClick={() => {
											setSnoozeUntil(toLocalInputValue(tomorrowMorning()));
											setSnoozing(item);
										}}
									>
										<IconClock />
									</button>
								)}
								{youtubeOpenButton(item)}
								{watchToggleButton(item)}
								{mode === 'inbox' || mode === 'snoozed' ? watchlistButton(item) : null}
							</>
						)}
					</div>
				</header>
				<div className={`preview-player${playthroughActive ? ' playthrough-shell' : ''}`} ref={playerShellRef}>
					{item.mediaKind === 'podcast' && item.audioUrl ? (
						<audio className="podcast-player" controls src={item.audioUrl} preload="metadata">
							Your browser does not support audio playback.
						</audio>
					) : item.embeddable ? (
						<FeedYouTubePlayer
							videoId={item.videoId}
							title={item.title}
							durationSeconds={item.durationSeconds}
							initialPlaybackSeconds={item.playbackSeconds ?? 0}
							autoplay={playthroughActive}
							onPersist={persistWatchProgress}
						/>
					) : (
						<img src={item.thumbnailUrl} alt="" />
					)}
					{playthroughActive ? (
						<button className="playthrough-exit" type="button" onClick={() => stopPlaythrough()}>
							Exit playthrough
						</button>
					) : null}
				</div>
				{item.mediaKind === 'podcast' ? null : item.embeddable ? null : (
					<div className="preview-unavailable">
						<p className="muted">This video can’t be embedded. Opening it on YouTube does not mark it watched.</p>
						<button className="ghost tiny" type="button" onClick={() => void toggleWatched(item)}>
							{item.watchedAt ? 'Mark as unwatched' : 'Mark as watched'}
						</button>
					</div>
				)}
				<div className="preview-meta">
					{mode === 'snoozed' && item.snoozedUntil ? (
						<p className="muted">Snoozed until {new Date(item.snoozedUntil).toLocaleString()}</p>
					) : null}
					<p className="preview-description">{item.descriptionExcerpt}</p>
				</div>
				<label className="notes-label">
					<span className="muted">Notes</span>
					<textarea
						key={item.videoId}
						defaultValue={item.notes}
						rows={3}
						placeholder="Notes for this video"
						onBlur={(event) => {
							const next = event.target.value;
							if (next === item.notes) return;
							void patchInbox(item.videoId, { action: 'notes', notes: next });
						}}
					/>
				</label>
			</div>
		);
	}

	function renderFeed(
		list: InboxItem[] | null,
		compact: boolean,
		actions: 'inbox' | 'snoozed' | 'deleted' | 'watchlist' | 'streams' | 'none' = 'none',
	) {
		if (list === null && !error) return <p className="muted">Loading feed…</p>;
		if (list?.length === 0) return <p className="muted">No videos in this view.</p>;
		const allowMultiSelect = !androidClient && (actions === 'inbox' || actions === 'snoozed' || actions === 'deleted');
		const queue = playthroughQueue(list);
		return (
			<>
				{!androidClient && queue.length > 0 ? (
					<div className="playthrough-bar">
						<button
							className="playthrough-btn"
							type="button"
							onClick={() => (playthroughActive ? stopPlaythrough() : startPlaythrough(list ?? []))}
						>
							<IconPlay />
							{playthroughActive ? 'Exit playthrough' : 'Playthrough'}
						</button>
					</div>
				) : null}
				{(list ?? []).map((item) =>
			compact ? (
				<div
					key={item.videoId}
					className={`${selectedVideo?.videoId === item.videoId ? 'inbox-item active' : 'inbox-item'}${item.watchedAt ? ' watched' : ''}${inboxSelectedIds.includes(item.videoId) ? ' is-checked' : ''}`}
				>
					{allowMultiSelect ? (
						<button
							className={`inbox-avatar-select${inboxSelectedIds.includes(item.videoId) ? ' is-selected' : ''}`}
							type="button"
							title={inboxSelectedIds.includes(item.videoId) ? 'Deselect' : 'Select'}
							aria-label={inboxSelectedIds.includes(item.videoId) ? 'Deselect video' : 'Select video'}
							aria-pressed={inboxSelectedIds.includes(item.videoId)}
							onClick={() => toggleInboxSelect(item.videoId)}
						>
							<img className="channel-avatar" src={item.channelThumbnailUrl || item.thumbnailUrl} alt="" />
							<span className="inbox-check" aria-hidden="true">
								<svg viewBox="0 0 24 24" width="18" height="18">
									<path
										fill="currentColor"
										d="M9.2 16.6 4.8 12.2l1.4-1.4 3 3 8-8 1.4 1.4-9.4 9.4z"
									/>
								</svg>
							</span>
						</button>
					) : null}
					<button
						className="inbox-item-main"
						type="button"
						onClick={() => openVideo(item.videoId)}
						title={item.watchedAt ? 'Watched' : 'Unwatched'}
						aria-label={`${item.title}, ${item.watchedAt ? 'Watched' : 'Unwatched'}`}
					>
						{allowMultiSelect ? null : (
							<img className="channel-avatar" src={item.channelThumbnailUrl || item.thumbnailUrl} alt="" />
						)}
						<img className="video-thumb" src={item.thumbnailUrl} alt="" />
						<span>
							<strong className="video-title">
								{item.mediaKind === 'podcast' ? <span className="badge podcast">Podcast</span> : null}
								{item.title}
								{item.watchedAt ? (
									<span className="watch-mark" aria-hidden="true">
										<IconWatchMark />
									</span>
								) : null}
							</strong>
							<small className="muted">{item.channelTitle}</small>
							<small className="muted">{relativeRelease(item.publishedAt)}</small>
							{actions === 'snoozed' && item.snoozedUntil ? (
								<small className="muted">Until {new Date(item.snoozedUntil).toLocaleString()}</small>
							) : null}
						</span>
					</button>
					{actions !== 'none' ? (
						<div className="inbox-item-actions">
							{actions === 'deleted' ? (
								<>
									<button
										className="icon-btn"
										type="button"
										title="Restore"
										aria-label="Restore"
										onClick={() => void patchInbox(item.videoId, { action: 'restore' })}
									>
										<IconRestore />
									</button>
									{watchlistButton(item)}
								</>
							) : actions === 'streams' ? (
								<>
									<button
										className="icon-btn"
										type="button"
										title="Delete"
										aria-label="Delete"
										onClick={() => void patchInbox(item.videoId, { action: 'delete' })}
									>
										<IconTrash />
									</button>
									{watchlistButton(item)}
								</>
							) : (
								<>
									<button
										className="icon-btn"
										type="button"
										title="Delete"
										aria-label="Delete"
										onClick={() => void patchInbox(item.videoId, { action: 'delete' })}
									>
										<IconTrash />
									</button>
									{actions === 'watchlist' ? (
										<button
											className="icon-btn"
											type="button"
											title="Remove from watchlist"
											aria-label="Remove from watchlist"
											onClick={() => void takeOffWatchlist(item.videoId)}
										>
											<IconRestore />
										</button>
									) : actions === 'snoozed' ? (
										<button
											className="icon-btn"
											type="button"
											title="Remove snooze"
											aria-label="Remove snooze"
											onClick={() => void patchInbox(item.videoId, { action: 'unsnooze' })}
										>
											<IconClock />
										</button>
									) : (
										<button
											className="icon-btn"
											type="button"
											title="Snooze"
											aria-label="Snooze"
											onClick={() => {
												setSnoozeUntil(toLocalInputValue(tomorrowMorning()));
												setSnoozing(item);
											}}
										>
											<IconClock />
										</button>
									)}
									{actions === 'inbox' || actions === 'snoozed' ? watchlistButton(item) : null}
								</>
							)}
						</div>
					) : null}
				</div>
			) : (
				<a className="row" key={item.videoId} href={youtubeWatchUrl(item.videoId)} target="_blank" rel="noreferrer">
					<img src={item.thumbnailUrl} alt="" />
					<div>
						<div>
							<span className={`badge ${item.contentType}`}>{item.contentType}</span>
							<strong className="video-title">{item.title}</strong>
						</div>
						<div className="muted">
							{item.channelTitle} · {relativeRelease(item.publishedAt)}
						</div>
					</div>
				</a>
			),
				)}
				{inboxHasMore ? <div ref={loadMoreSentinelRef} className="inbox-load-more" aria-hidden="true" /> : null}
				{loadingMore ? <p className="muted inbox-load-more-status">Loading older videos…</p> : null}
			</>
		);
	}

	return (
		<div className={androidClient ? 'shell android-app' : 'shell'}>
			<header className="topbar">
				<div className="topbar-left">
					{mainSection === 'live' && !androidClient ? (
						<button
							className="icon-btn live-hamburger"
							type="button"
							title={liveSidebarOpen ? 'Hide stream list' : 'Show stream list'}
							aria-label={liveSidebarOpen ? 'Hide stream list' : 'Show stream list'}
							aria-expanded={liveSidebarOpen}
							onClick={() => setLiveSidebarOpen((open) => !open)}
						>
							<span className="hamburger" aria-hidden="true" />
						</button>
					) : null}
					<h1 className="brand">{STREAMFEEDER_DISPLAY_NAME}</h1>
					{androidClient ? null : (
					<div className="app-tabs" role="tablist" aria-label="Main">
						<button
							className={mainSection === 'feed' && leftTab !== 'watchlist' ? 'tab active' : 'tab'}
							type="button"
							role="tab"
							aria-selected={mainSection === 'feed' && leftTab !== 'watchlist'}
							onClick={() => {
								stopPlaythrough();
								setMainSection('feed');
								if (leftTab === 'watchlist') setLeftTab('inbox');
							}}
						>
							Feed
						</button>
						<button
							className={mainSection === 'feed' && leftTab === 'watchlist' ? 'tab active' : 'tab'}
							type="button"
							role="tab"
							aria-selected={mainSection === 'feed' && leftTab === 'watchlist'}
							onClick={() => {
								stopPlaythrough();
								setMainSection('feed');
								setLeftTab('watchlist');
							}}
						>
							WatchList
						</button>
						<button
							className={mainSection === 'live' ? 'tab active' : 'tab'}
							type="button"
							role="tab"
							aria-selected={mainSection === 'live'}
							onClick={() => setMainSection('live')}
						>
							Live
						</button>
						<button
							className={mainSection === 'discover' ? 'tab active' : 'tab'}
							type="button"
							role="tab"
							aria-selected={mainSection === 'discover'}
							onClick={() => {
								stopPlaythrough();
								setMainSection('discover');
							}}
						>
							Discover
						</button>
					</div>
					)}
					{mainSection === 'live' && !androidClient && liveGridChrome ? (
						<div className="live-toolbar-actions">
							<span className="muted">GRID</span>
							{LIVE_GRID_SIZES.map((size) => (
								<button
									key={size}
									className={liveGridChrome.gridSize === size ? 'ghost tiny active' : 'ghost tiny'}
									type="button"
									onClick={() => liveGridChrome.setGrid(size)}
								>
									{size}
								</button>
							))}
						</div>
					) : null}
					{mainSection === 'live' && liveHeaderStatus ? (
						<div className={liveHeaderStatus.error ? 'live-status live-header-status error' : 'live-status live-header-status'}>
							{liveHeaderStatus.text}
						</div>
					) : null}
				</div>
				<div className="topbar-actions">
					<span className="muted">{user.displayName}</span>
					<button className="ghost" type="button" onClick={onLogout}>
						Sign out
					</button>
					<Link className="icon-btn" to="/settings" title="Settings" aria-label="Settings">
						<IconGear />
					</Link>
					{androidClient ? null : (
						<button
							className="icon-btn"
							type="button"
							title="Get the Android app"
							aria-label="Get the Android app"
							onClick={() => {
								setAndroidQrOpen(true);
								void (async () => {
									const verRes = await fetch('/android-version.json');
									const ver = verRes.ok
										? ((await verRes.json()) as { versionName: string; versionCode: number })
										: null;
									if (ver) setAndroidAppVersion(ver);
									const qs = ver ? `?v=${encodeURIComponent(ver.versionName)}` : '';
									const url = `${window.location.origin}${TEST_APK_PATH}${qs}`;
									setAndroidQrSvg(await qrSvgForUrl(url));
								})();
							}}
						>
							<IconPhone />
						</button>
					)}
				</div>
			</header>
			{mainSection === 'feed' && leftTab !== 'watchlist' ? (
				<nav className="feed-toolbar" aria-label="Feed views">
					<button className={leftTab === 'inbox' ? 'tab active' : 'tab'} type="button" onClick={() => selectFeedView('inbox')}>
						Inbox{inboxCount === null ? '' : ` (${inboxCount})`}
					</button>
					<button
						className={leftTab === 'categories' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => setLeftTab('categories')}
					>
						By Category
					</button>
					<button
						className={leftTab === 'snoozed' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => selectFeedView('snoozed')}
					>
						Snoozed
					</button>
					<button
						className={leftTab === 'deleted' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => selectFeedView('deleted')}
					>
						Deleted
					</button>
					<button
						className={leftTab === 'streams' ? 'tab active' : 'tab'}
						type="button"
						onClick={() => selectFeedView('streams')}
					>
						Subscriptions
					</button>
					{leftTab !== 'categories' ? (
						<>
							{!androidClient ? (
								<button
									className="icon-btn"
									type="button"
									title="Sync subscriptions"
									aria-label="Sync subscriptions"
									disabled={syncing}
									onClick={() => void syncSubscriptionsOnly()}
								>
									<IconReload />
								</button>
							) : null}
							<label className="feed-toolbar-filter">
								<select
									value={categoryId ?? ''}
									aria-label="Category"
									onChange={(event) => {
										const next = event.target.value || null;
										setCategoryId(next);
										setSelectedVideoId(null);
										setInboxSelectedIds([]);
										if (leftTab === 'streams' && channelId) {
											const selected = channels.find((ch) => ch.channelId === channelId);
											if (next && selected && !channelMatchesCategory(selected, next)) {
												setChannelId(null);
											}
										}
										leftScrollRef.current?.scrollTo({ top: 0 });
									}}
								>
									<option value="">All categories</option>
									<option value={UNCATEGORIZED_CATEGORY_ID}>No category</option>
									{categories.map((cat) => (
										<option key={cat.id} value={cat.id}>
											{cat.name}
										</option>
									))}
								</select>
							</label>
							{watchFilterBar()}
							{!androidClient ? (
								<div className="feed-toolbar-sync-wrap">
									<button
										className="feed-toolbar-sync"
										type="button"
										disabled={syncing || streamsList.length === 0}
										onClick={() => void syncNow()}
									>
										{syncing ? 'Syncing…' : `Sync now (${streamsList.length})`}
									</button>
									{feedHealth ? (
										<p className="feed-sync-health">{formatFeedHealth(feedHealth)}</p>
									) : null}
								</div>
							) : null}
						</>
					) : null}
				</nav>
			) : null}
			{mainSection === 'feed' && leftTab === 'watchlist' ? (
				<nav className="feed-toolbar" aria-label="Watchlist filters">
					{watchFilterBar()}
				</nav>
			) : null}
			{offline ? <p className="status-line">Offline. Showing the last loaded inbox until you reconnect.</p> : null}
			{status || error ? (
				<div
					className={
						error
							? 'status-line error'
							: syncWarnings.length
								? 'status-line warning'
								: 'status-line'
					}
				>
					<div className="status-line-body">
						<p>{[status, error].filter(Boolean).join(' — ')}</p>
						{!error && syncWarnings.length > 1 ? (
							<>
								<button
									className="status-details-toggle"
									type="button"
									onClick={() => setShowSkipDetails((open) => !open)}
								>
									{showSkipDetails ? 'Hide skipped channels' : 'Show skipped channels'}
								</button>
								{showSkipDetails ? (
									<ul className="status-skip-list" title={skippedChannelNames(syncWarnings).join(', ')}>
										{skippedChannelNames(syncWarnings).map((name) => (
											<li key={name}>{name}</li>
										))}
									</ul>
								) : null}
							</>
						) : null}
						{!error && syncWarnings.length === 1 ? (
							<p className="status-skip-hint" title={syncWarnings[0]?.channelId}>
								{syncWarnings[0]?.message}
							</p>
						) : null}
					</div>
					<button className="status-dismiss" type="button" onClick={dismissStatusBanner}>
						Dismiss
					</button>
				</div>
			) : null}
			{mainSection === 'live' ? (
				<LivePage sidebarOpen={liveSidebarOpen} onHeaderStatus={setLiveHeaderStatus} onGridChrome={setLiveGridChrome} />
			) : mainSection === 'discover' ? (
				<DiscoverPage
					onSubscribed={() => void load()}
					onError={setError}
					onStatus={setStatus}
				/>
			) : (
			<div
				className={`${phoneLayout && selectedVideo ? 'home mobile-detail' : 'home'}${feedThreeCol ? ' home-streams' : ''}`}
			>
				<aside className="subs">
					{leftTab === 'inbox' ? (
						<>
							{listMultiSelectEnabled && leftTab === 'inbox' && inboxSelectedIds.length > 0 ? (
								<div className="inbox-bulk-bar" role="toolbar" aria-label="Bulk inbox actions">
									<span className="muted inbox-bulk-count">{inboxSelectedIds.length} selected</span>
									<button
										className="icon-btn"
										type="button"
										title="Snooze selected"
										aria-label="Snooze selected"
										onClick={() => {
											setSnoozeUntil(toLocalInputValue(tomorrowMorning()));
											setSnoozing(null);
											setBulkSnoozeIds([...inboxSelectedIds]);
										}}
									>
										<IconClock />
									</button>
									<button
										className="icon-btn"
										type="button"
										title="Add selected to watchlist"
										aria-label="Add selected to watchlist"
										onClick={() => {
											setWatchlisting(null);
											setBulkWatchlistIds([...inboxSelectedIds]);
										}}
									>
										<IconList />
									</button>
									<button
										className="icon-btn"
										type="button"
										title="Delete selected"
										aria-label="Delete selected"
										onClick={() => void bulkDeleteSelected()}
									>
										<IconTrash />
									</button>
									<button className="ghost tiny" type="button" onClick={() => setInboxSelectedIds([])}>
										Clear
									</button>
								</div>
							) : null}
							<div className="left-scroll" ref={leftScrollRef}>{renderFeed(visibleItems, true, 'inbox')}</div>
						</>
					) : null}
					{leftTab === 'snoozed' ? (
						<>
							{listMultiSelectEnabled && inboxSelectedIds.length > 0 ? (
								<div className="inbox-bulk-bar" role="toolbar" aria-label="Bulk snoozed actions">
									<span className="muted inbox-bulk-count">{inboxSelectedIds.length} selected</span>
									<button
										className="icon-btn"
										type="button"
										title="Remove snooze from selected"
										aria-label="Remove snooze from selected"
										onClick={() => void bulkUnsnoozeSelected()}
									>
										<IconClock />
									</button>
									<button
										className="icon-btn"
										type="button"
										title="Add selected to watchlist"
										aria-label="Add selected to watchlist"
										onClick={() => {
											setWatchlisting(null);
											setBulkWatchlistIds([...inboxSelectedIds]);
										}}
									>
										<IconList />
									</button>
									<button
										className="icon-btn"
										type="button"
										title="Delete selected"
										aria-label="Delete selected"
										onClick={() => void bulkDeleteSelected()}
									>
										<IconTrash />
									</button>
									<button className="ghost tiny" type="button" onClick={() => setInboxSelectedIds([])}>
										Clear
									</button>
								</div>
							) : null}
							<div className="left-scroll" ref={leftScrollRef}>{renderFeed(visibleItems, true, 'snoozed')}</div>
						</>
					) : null}
					{leftTab === 'deleted' ? (
						<>
							{listMultiSelectEnabled && inboxSelectedIds.length > 0 ? (
								<div className="inbox-bulk-bar" role="toolbar" aria-label="Bulk deleted actions">
									<span className="muted inbox-bulk-count">{inboxSelectedIds.length} selected</span>
									<button
										className="icon-btn"
										type="button"
										title="Restore selected"
										aria-label="Restore selected"
										onClick={() => void bulkRestoreSelected()}
									>
										<IconRestore />
									</button>
									<button
										className="icon-btn"
										type="button"
										title="Add selected to watchlist"
										aria-label="Add selected to watchlist"
										onClick={() => {
											setWatchlisting(null);
											setBulkWatchlistIds([...inboxSelectedIds]);
										}}
									>
										<IconList />
									</button>
									<button className="ghost tiny" type="button" onClick={() => setInboxSelectedIds([])}>
										Clear
									</button>
								</div>
							) : null}
							<div className="left-scroll" ref={leftScrollRef}>{renderFeed(visibleItems, true, 'deleted')}</div>
						</>
					) : null}
					{leftTab === 'watchlist' ? (
						<div className="left-scroll cat-panel">
							<form className="cat-add" onSubmit={(e) => void addWatchlist(e)}>
								<input value={newWatchlist} onChange={(e) => setNewWatchlist(e.target.value)} placeholder="New watchlist" />
								<button className="ghost" type="submit">
									Add
								</button>
							</form>
							{watchlists.map((list) => (
								<div key={list.id} className={watchlistId === list.id ? 'sub-row active watchlist-row' : 'sub-row watchlist-row'}>
									{renamingId === list.id ? (
										<form className="watchlist-rename" onSubmit={(e) => void saveWatchlistName(e)}>
											<input
												value={renameValue}
												onChange={(e) => setRenameValue(e.target.value)}
												aria-label="Watchlist name"
												autoFocus
												onKeyDown={(e) => {
													if (e.key === 'Escape') {
														e.preventDefault();
														setRenamingId(null);
													}
												}}
											/>
											<button className="ghost tiny" type="submit">
												Save
											</button>
										</form>
									) : (
										<button
											className="sub watchlist-name"
											type="button"
											onClick={() => {
												setWatchlistId(list.id);
												setSelectedVideoId(null);
												setRenamingId(null);
											}}
										>
											{list.name} ({list.videoCount})
										</button>
									)}
									<button
										className="icon-btn"
										type="button"
										title="Rename watchlist"
										aria-label="Rename watchlist"
										onClick={() => {
											setRenamingId(list.id);
											setRenameValue(list.name);
										}}
									>
										<IconPencil />
									</button>
									{list.videoCount === 0 ? (
										<button
											className="icon-btn"
											type="button"
											title="Delete watchlist"
											aria-label="Delete watchlist"
											onClick={() => void removeWatchlist(list.id, list.videoCount)}
										>
											<IconTrash />
										</button>
									) : (
										<span className="icon-btn-spacer" aria-hidden="true" />
									)}
								</div>
							))}
							{watchlists.length === 0 ? <p className="muted pad">Create a watchlist, then add videos from Inbox.</p> : null}
						</div>
					) : null}
					{leftTab === 'streams' ? (
						<div className="left-scroll">
							{subscriptionRows.map((row) =>
								row.kind === 'youtube' ? (
									<div key={row.data.channelId} className={channelId === row.data.channelId ? 'sub-row active' : 'sub-row'}>
										<button
											className="sub"
											type="button"
											onClick={() => {
												setChannelId(row.data.channelId);
												setSelectedVideoId(null);
											}}
										>
											<img src={row.data.thumbnailUrl} alt="" />
											<span>
												<strong className="video-title">{row.data.title}</strong>
												<small className="muted">
													<span className="badge video">YouTube</span>{' '}
													{`${row.data.inboxVideoCount} video${row.data.inboxVideoCount === 1 ? '' : 's'} - ${row.data.followInInbox ? 'Following' : 'Not following'}`}
												</small>
												<small className="muted">
													{row.data.lastSynchronizedAt
														? `Last video sync: ${new Date(row.data.lastSynchronizedAt).toLocaleString()}`
														: 'Last video sync: never'}
												</small>
												<small className="muted cat-tags">{channelCategoryNames(row.data, categories)}</small>
											</span>
										</button>
										<button className="ghost tiny" type="button" onClick={() => setEditing(row.data)}>
											Edit
										</button>
									</div>
								) : (
									<div key={row.data.podcastId} className="sub-row">
										<button className="sub" type="button" onClick={() => setSelectedVideoId(null)}>
											{row.data.imageUrl ? (
												<img src={row.data.imageUrl} alt="" />
											) : (
												<span className="sub-avatar-placeholder" aria-hidden="true" />
											)}
											<span>
												<strong className="video-title">{row.data.title}</strong>
												<small className="muted">
													<span className="badge podcast">Podcast</span>{' '}
													{`${row.data.inboxEpisodeCount} episode${row.data.inboxEpisodeCount === 1 ? '' : 's'} - ${row.data.followInInbox ? 'Following' : 'Not following'}`}
												</small>
												{row.data.publisher ? <small className="muted">{row.data.publisher}</small> : null}
												<small className="muted">
													{row.data.lastPolledAt
														? `Last feed sync: ${new Date(row.data.lastPolledAt).toLocaleString()}`
														: 'Last feed sync: never'}
												</small>
												<small className="muted cat-tags">{categoryNames(row.data.categoryIds, categories)}</small>
											</span>
										</button>
										<button className="ghost tiny" type="button" onClick={() => setEditingPodcast(row.data)}>
											Edit
										</button>
									</div>
								),
							)}
							{subscriptionRows.length === 0 && !syncing ? (
								<p className="muted pad">
									{channels.length === 0 && podcasts.length === 0
										? 'No subscriptions yet. Use Discover or Sync now.'
										: categoryId
											? 'No streams in this category.'
											: 'No subscriptions yet.'}
								</p>
							) : null}
						</div>
					) : null}
					{leftTab === 'categories' ? (
						<div className="left-scroll cat-panel">
							<form className="cat-add" onSubmit={(e) => void addCategory(e)}>
								<input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="New category" />
								<button className="ghost" type="submit">
									Add
								</button>
							</form>
							{categories.map((cat) => {
								const tagged = channels.filter((ch) => ch.categoryIds.includes(cat.id));
								const streamCount = tagged.length;
								const videoCount = tagged.reduce((sum, ch) => sum + (ch.inboxVideoCount ?? 0), 0);
								return (
									<div
										key={cat.id}
										className={categoryId === cat.id ? 'sub-row active watchlist-row' : 'sub-row watchlist-row'}
									>
										{renamingCategoryId === cat.id ? (
											<form className="watchlist-rename" onSubmit={(e) => void saveCategoryName(e)}>
												<input
													value={categoryRenameValue}
													onChange={(e) => setCategoryRenameValue(e.target.value)}
													aria-label="Category name"
													autoFocus
													onKeyDown={(e) => {
														if (e.key === 'Escape') {
															e.preventDefault();
															setRenamingCategoryId(null);
														}
													}}
												/>
												<button className="ghost tiny" type="submit">
													Save
												</button>
											</form>
										) : (
											<button
												className="sub watchlist-name category-name"
												type="button"
												onClick={() => {
													setCategoryId(cat.id);
													setSelectedVideoId(null);
													setRenamingCategoryId(null);
												}}
											>
												<span className="category-label">
													<span className="category-label-name">{cat.name}</span>
													<span className="muted category-label-meta">
														{`${videoCount} video${videoCount === 1 ? '' : 's'} - ${streamCount} channel${streamCount === 1 ? '' : 's'}`}
													</span>
												</span>
											</button>
										)}
										<button
											className="icon-btn"
											type="button"
											title="Rename category"
											aria-label="Rename category"
											onClick={() => {
												setRenamingCategoryId(cat.id);
												setCategoryRenameValue(cat.name);
											}}
										>
											<IconPencil />
										</button>
										<button
											className="icon-btn"
											type="button"
											title={
												streamCount > 0
													? 'Remove this category from all streams before deleting'
													: 'Delete category'
											}
											aria-label="Delete category"
											disabled={streamCount > 0}
											onClick={() => void removeCategory(cat.id)}
										>
											<IconTrash />
										</button>
									</div>
								);
							})}
							{categories.length === 0 ? <p className="muted pad">Add a category, then tag streams under Edit.</p> : null}
						</div>
					) : null}
				</aside>
				{streamsThreeCol ? (
					<aside className="subs streams-video-list" aria-label="Stream videos">
						<div className="left-scroll">
							{channelId
								? renderFeed(visibleItems, true, 'streams')
								: (
									<p className="muted pad">
										Choose a stream on the left to see its videos, or use Edit to change follow settings.
									</p>
								)}
						</div>
					</aside>
				) : null}
				{watchlistThreeCol ? (
					<aside className="subs streams-video-list" aria-label="Watchlist videos">
						<div className="left-scroll">
							{watchlistId
								? renderFeed(visibleItems, true, 'watchlist')
								: <p className="muted pad">Select a watchlist to see saved videos.</p>}
						</div>
					</aside>
				) : null}
				{categoryThreeCol ? (
					<aside className="subs streams-video-list" aria-label="Category videos">
						<div className="left-scroll">
							{categoryId
								? renderFeed(visibleItems, true, 'inbox')
								: (
									<p className="muted pad">
										Select a category to see tagged videos. Tag streams from the Subscriptions tab using Edit.
									</p>
								)}
						</div>
					</aside>
				) : null}
				<section className="feed">
					{phoneLayout && selectedVideo ? (
						<button
							className="ghost mobile-back"
							type="button"
							onClick={() => {
								setSelectedVideoId(null);
								if (history.state && typeof history.state === 'object' && 'feederVideo' in history.state) history.back();
							}}
						>
							Back to list
						</button>
					) : null}
					{leftTab === 'inbox' && selectedVideo ? renderPreview(selectedVideo, 'inbox') : null}
					{leftTab === 'inbox' && !selectedVideo ? <p className="muted">No videos in your inbox yet. Sync now.</p> : null}
					{leftTab === 'snoozed' && selectedVideo ? renderPreview(selectedVideo, 'snoozed') : null}
					{leftTab === 'snoozed' && !selectedVideo ? <p className="muted">No snoozed videos.</p> : null}
					{leftTab === 'deleted' && selectedVideo ? renderPreview(selectedVideo, 'deleted') : null}
					{leftTab === 'deleted' && !selectedVideo ? <p className="muted">No deleted videos.</p> : null}
					{leftTab === 'watchlist' && watchlistThreeCol ? (
						selectedVideo ? (
							renderPreview(selectedVideo, 'watchlist')
						) : (
							<p className="muted">
								{watchlistId ? 'Select a video to preview.' : 'Select a watchlist, then a video to preview.'}
							</p>
						)
					) : null}
					{leftTab === 'watchlist' && !watchlistThreeCol && watchlistId && selectedVideo
						? renderPreview(selectedVideo, 'watchlist')
						: null}
					{leftTab === 'watchlist' && !watchlistThreeCol && watchlistId && !selectedVideo
						? renderFeed(visibleItems, true, 'watchlist')
						: null}
					{leftTab === 'watchlist' && !watchlistThreeCol && !watchlistId ? (
						<p className="muted">Select a watchlist to see saved videos.</p>
					) : null}
					{streamsThreeCol ? (
						selectedVideo ? (
							renderPreview(selectedVideo, 'streams')
						) : (
							<p className="muted">
								{channelId ? 'Select a video to preview.' : 'Select a stream, then a video to preview.'}
							</p>
						)
					) : null}
					{leftTab === 'streams' && !streamsThreeCol ? (
						<>
							<h2 className="pane-title video-title">
								{channelId ? channels.find((c) => c.channelId === channelId)?.title ?? 'Stream' : 'Select a stream'}
							</h2>
							{channelId ? renderFeed(visibleItems, false) : <p className="muted">Choose a stream on the left to see its videos, or use Edit to change follow settings.</p>}
						</>
					) : null}
					{leftTab === 'categories' && categoryThreeCol ? (
						selectedVideo ? (
							renderPreview(selectedVideo, 'inbox')
						) : (
							<p className="muted">
								{categoryId ? 'Select a video to preview.' : 'Select a category, then a video to preview.'}
							</p>
						)
					) : null}
					{leftTab === 'categories' && !categoryThreeCol ? (
						<>
							<h2 className="pane-title">{categoryId ? categories.find((c) => c.id === categoryId)?.name ?? 'Category' : 'By Category'}</h2>
							{categoryId ? renderFeed(visibleItems, false) : <p className="muted">Select a category to see tagged videos. Tag streams from the Subscriptions tab using Edit.</p>}
						</>
					) : null}
				</section>
				{phoneLayout ? (
					<nav className="mobile-nav" aria-label="Feeder">
						<button className={leftTab === 'inbox' ? 'active' : undefined} type="button" onClick={() => selectFeedView('inbox')}>
							Inbox{inboxCount === null ? '' : ` (${inboxCount})`}
						</button>
						<button className={leftTab === 'watchlist' ? 'active' : undefined} type="button" onClick={() => setLeftTab('watchlist')}>
							Watchlists
						</button>
						<button type="button" onClick={() => void load().catch(() => setError('Could not refresh inbox.'))}>
							Refresh
						</button>
						<button className={mobilePanel === 'account' ? 'active' : undefined} type="button" onClick={() => setMobilePanel((p) => (p === 'account' ? 'inbox' : 'account'))}>
							Account
						</button>
					</nav>
				) : null}
			</div>
			)}
			{mobilePanel === 'account' && phoneLayout ? (
				<div className="modal-backdrop" onClick={() => setMobilePanel('inbox')}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h2>Account</h2>
						<p>{user.displayName}</p>
						<p className="muted">Inbox and watchlists use the same signed-in account as the website. Refresh loads saved data without calling YouTube.</p>
						<div className="modal-actions">
							<Link className="ghost" to="/settings" onClick={() => setMobilePanel('inbox')}>
								Settings
							</Link>
							<button className="ghost" type="button" onClick={() => void load()}>
								Refresh inbox
							</button>
							<button className="ghost" type="button" onClick={onLogout}>
								Sign out
							</button>
						</div>
					</div>
				</div>
			) : null}
			{androidQrOpen ? (
				<div className="modal-backdrop" onClick={() => setAndroidQrOpen(false)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h2 className="brand">Get VortiQuest</h2>
						<p className="muted">Scan this code on your Android phone to download the VortiQuest test APK, then allow install from your browser if Android asks.</p>
						{androidQrSvg ? <div className="download-qr" dangerouslySetInnerHTML={{ __html: androidQrSvg }} /> : <p className="muted">Preparing QR…</p>}
						{androidAppVersion ? (
							<p>
								Version {androidAppVersion.versionName} (build {androidAppVersion.versionCode})
							</p>
						) : null}
						<p>
							<a href={androidAppVersion ? `${TEST_APK_PATH}?v=${encodeURIComponent(androidAppVersion.versionName)}` : TEST_APK_PATH}>
								{typeof window !== 'undefined'
									? `${window.location.origin}${TEST_APK_PATH}${androidAppVersion ? `?v=${encodeURIComponent(androidAppVersion.versionName)}` : ''}`
									: TEST_APK_PATH}
							</a>
						</p>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setAndroidQrOpen(false)}>
								Close
							</button>
						</div>
					</div>
				</div>
			) : null}
			{watchlisting || bulkWatchlistIds ? (
				<div
					className="modal-backdrop"
					onClick={() => {
						setWatchlisting(null);
						setBulkWatchlistIds(null);
					}}
				>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<h2>Add to WatchList</h2>
						<p className="muted">
							{bulkWatchlistIds
								? `${bulkWatchlistIds.length} selected video${bulkWatchlistIds.length === 1 ? '' : 's'}`
								: watchlisting?.title}
						</p>
						{watchlists.length === 0 ? <p className="muted">Create a watchlist on the WatchList tab first.</p> : null}
						<div className="modal-list">
							{watchlists.map((list) => (
								<button
									key={list.id}
									className="ghost"
									type="button"
									onClick={() =>
										bulkWatchlistIds
											? void saveBulkToWatchlist(list.id)
											: watchlisting
												? void saveToWatchlist(watchlisting.videoId, list.id)
												: undefined
									}
								>
									{list.name} ({list.videoCount})
								</button>
							))}
						</div>
						<div className="modal-actions">
							<button
								className="ghost"
								type="button"
								onClick={() => {
									setWatchlisting(null);
									setBulkWatchlistIds(null);
								}}
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			) : null}
			{snoozing || bulkSnoozeIds ? (
				<div
					className="modal-backdrop"
					onClick={() => {
						setSnoozing(null);
						setBulkSnoozeIds(null);
					}}
				>
					<form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void confirmSnooze(e)}>
						<h2>Snooze</h2>
						<p className="muted">
							{bulkSnoozeIds
								? `${bulkSnoozeIds.length} selected video${bulkSnoozeIds.length === 1 ? '' : 's'}`
								: snoozing?.title}
						</p>
						<div className="snooze-presets">
							<button
								className="ghost tiny"
								type="button"
								onClick={() => setSnoozeUntil(toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)))}
							>
								In 3 hours
							</button>
							<button className="ghost tiny" type="button" onClick={() => setSnoozeUntil(toLocalInputValue(tomorrowMorning()))}>
								Tomorrow 8:00 AM
							</button>
							<button
								className="ghost tiny"
								type="button"
								onClick={() => {
									const d = tomorrowMorning();
									d.setDate(d.getDate() + 6);
									setSnoozeUntil(toLocalInputValue(d));
								}}
							>
								Next week
							</button>
						</div>
						<label>
							Until
							<input
								type="datetime-local"
								value={snoozeUntil}
								onChange={(e) => setSnoozeUntil(e.target.value)}
								required
							/>
						</label>
						<div className="modal-actions">
							<button
								className="ghost"
								type="button"
								onClick={() => {
									setSnoozing(null);
									setBulkSnoozeIds(null);
								}}
							>
								Cancel
							</button>
							<button className="ghost" type="submit">
								Snooze
							</button>
						</div>
					</form>
				</div>
			) : null}
			{editing ? (
				<div className="modal-backdrop" onClick={() => setEditing(null)}>
					<form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void saveEdit(e)}>
						<h2>Edit {editing.title}</h2>
						<label className="check">
							<input type="checkbox" name="followInInbox" defaultChecked={editing.followInInbox} />
							Follow in inbox (always pull new videos)
						</label>
						<label>
							How many older videos to catch up (0–500)
							<input type="number" name="maxVideosToPull" min={0} max={500} defaultValue={editing.maxVideosToPull} />
						</label>
						<fieldset className="modal-cats">
							<legend>Categories</legend>
							{categories.length === 0 ? <p className="muted">Add a category on the By Category tab first.</p> : null}
							{categories.map((cat) => (
								<label key={cat.id} className="check">
									<input type="checkbox" name="categoryIds" value={cat.id} defaultChecked={editing.categoryIds.includes(cat.id)} />
									{cat.name}
								</label>
							))}
						</fieldset>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setEditing(null)}>
								Cancel
							</button>
							<button
								className="ghost"
								type="button"
								disabled={syncing}
								onClick={(event) => {
									const form = event.currentTarget.form;
									if (form) void catchUpFromEdit(form);
								}}
							>
								{syncing ? 'Catching up…' : 'Catch up'}
							</button>
							<button className="ghost" type="submit">
								Save
							</button>
						</div>
					</form>
				</div>
			) : null}
			{editingPodcast ? (
				<div className="modal-backdrop" onClick={() => setEditingPodcast(null)}>
					<form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void savePodcastEdit(e)}>
						<h2>Edit {editingPodcast.title}</h2>
						<p className="muted">Podcast · {editingPodcast.publisher || 'Unknown publisher'}</p>
						<label className="check">
							<input type="checkbox" name="followInInbox" defaultChecked={editingPodcast.followInInbox} />
							Follow in inbox (pull new episodes)
						</label>
						<label>
							How many older episodes to catch up (0–500)
							<input type="number" name="maxEpisodesToPull" min={0} max={500} defaultValue={editingPodcast.maxEpisodesToPull} />
						</label>
						<fieldset className="modal-cats">
							<legend>Categories</legend>
							{categories.length === 0 ? <p className="muted">Add a category on the By Category tab first.</p> : null}
							{categories.map((cat) => (
								<label key={cat.id} className="check">
									<input
										type="checkbox"
										name="categoryIds"
										value={cat.id}
										defaultChecked={editingPodcast.categoryIds.includes(cat.id)}
									/>
									{cat.name}
								</label>
							))}
						</fieldset>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setEditingPodcast(null)}>
								Cancel
							</button>
							<button
								className="ghost"
								type="button"
								disabled={syncing}
								onClick={(event) => {
									const form = event.currentTarget.form;
									if (form) void catchUpPodcastFromEdit(form);
								}}
							>
								{syncing ? 'Catching up…' : 'Catch up'}
							</button>
							<button className="ghost" type="submit">
								Save
							</button>
						</div>
					</form>
				</div>
			) : null}
		</div>
	);
}
