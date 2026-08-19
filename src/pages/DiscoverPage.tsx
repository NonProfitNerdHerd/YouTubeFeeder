import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CategoryRecord } from '../types';
import type {
	DiscoverBrowseResponse,
	DiscoverBrowseTab,
	DiscoverFilter,
	DiscoverRecommendation,
	DiscoverSearchResponse,
	DiscoveryResult,
	RecommendationFeedbackAction,
} from '../types/discover';

interface SyncApiBody {
	error?: { message: string };
	errorSummary?: string | null;
	videosAdded?: number;
	done?: boolean;
	nextPageToken?: string;
	pulled?: number;
	want?: number;
}

interface FollowSetupState {
	channelId: string;
	title: string;
	description?: string;
	thumbnailUrl?: string;
	recommendationToken?: string;
}

interface UndoFeedbackState {
	feedbackId: string;
	message: string;
}

function syncMessage(body: SyncApiBody, fallback: string): string {
	return body.error?.message || body.errorSummary || fallback;
}

function IconSearch() {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
			<path
				fill="currentColor"
				d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16a6.471 6.471 0 0 0 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"
			/>
		</svg>
	);
}

function typeLabel(result: DiscoveryResult): string {
	if (result.type === 'podcast') return 'Podcast';
	if (result.type === 'episode') return 'Podcast episode';
	if (result.type === 'channel') return 'YouTube channel';
	if (result.type === 'video') return 'YouTube video';
	if (result.type === 'live') return 'Live';
	return result.type;
}

function badgeClass(result: DiscoveryResult): string {
	if (result.provider === 'youtube') return 'badge video';
	if (result.type === 'live') return 'badge live';
	return 'badge podcast';
}

function channelUrl(result: DiscoveryResult): string {
	return result.watchUrl ?? `https://www.youtube.com/channel/${result.externalId}`;
}

function renderTypeBadge(result: DiscoveryResult) {
	const label = typeLabel(result);
	const className = badgeClass(result);
	if (result.provider === 'youtube' && result.type === 'channel') {
		return (
			<a className={`${className} discover-badge-link`} href={channelUrl(result)} target="_blank" rel="noreferrer">
				{label}
			</a>
		);
	}
	return <span className={className}>{label}</span>;
}

interface DiscoverPageProps {
	onSubscribed: () => void;
	onError: (message: string) => void;
	onStatus: (message: string) => void;
}

const FOR_YOU_PAGE_SIZE = 25;
/** Cache key for Browse Popular on the All interest chip (global trending). */
const FOR_YOU_ALL_POPULAR_KEY = '__global__';

function mergeForYouItems(
	primary: DiscoverRecommendation[],
	additional: DiscoverRecommendation[] = [],
): DiscoverRecommendation[] {
	const seen = new Set(primary.map((row) => row.externalId));
	const out = [...primary];
	for (const row of additional) {
		if (seen.has(row.externalId)) continue;
		seen.add(row.externalId);
		out.push(row);
	}
	return out;
}

function buildForYouDisplayItems(
	interestId: string,
	serverItems: DiscoverRecommendation[],
	popularCache: Record<string, DiscoverRecommendation[]>,
): DiscoverRecommendation[] {
	if (interestId === 'all') {
		const popularMerged = Object.values(popularCache).reduce(
			(acc, rows) => mergeForYouItems(acc, rows),
			[] as DiscoverRecommendation[],
		);
		return mergeForYouItems(serverItems, popularMerged);
	}
	if (serverItems.length > 0) return serverItems;
	return popularCache[interestId] ?? [];
}

function isShowingPopularFallback(
	interestId: string,
	serverItems: DiscoverRecommendation[],
	popularCache: Record<string, DiscoverRecommendation[]>,
): boolean {
	if (interestId === 'all') return false;
	return serverItems.length === 0 && (popularCache[interestId]?.length ?? 0) > 0;
}

export function DiscoverPage({ onSubscribed, onError, onStatus }: DiscoverPageProps) {
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<DiscoverFilter>('all');
	const [loading, setLoading] = useState(false);
	const [response, setResponse] = useState<DiscoverSearchResponse | null>(null);
	const [browseTab, setBrowseTab] = useState<DiscoverBrowseTab>('forYou');
	const [browseLoading, setBrowseLoading] = useState(false);
	const [browseCache, setBrowseCache] = useState<Partial<Record<DiscoverBrowseTab, DiscoverBrowseResponse>>>({});
	const [subscribing, setSubscribing] = useState<string | null>(null);
	const [following, setFollowing] = useState<string | null>(null);
	const [unfollowing, setUnfollowing] = useState<string | null>(null);
	const [unfollowConfirm, setUnfollowConfirm] = useState<{ channelId: string; title: string } | null>(null);
	const [followSetup, setFollowSetup] = useState<FollowSetupState | null>(null);
	const [categories, setCategories] = useState<CategoryRecord[]>([]);
	const [followSaving, setFollowSaving] = useState(false);
	const [forYouInterest, setForYouInterest] = useState<string>('all');
	const [forYouItems, setForYouItems] = useState<DiscoverRecommendation[]>([]);
	const [forYouInterests, setForYouInterests] = useState<DiscoverBrowseResponse['forYouInterests']>([]);
	const [forYouTotal, setForYouTotal] = useState(0);
	const [forYouHasMore, setForYouHasMore] = useState(false);
	const [forYouMessage, setForYouMessage] = useState<string | undefined>();
	const [forYouRefreshOffset, setForYouRefreshOffset] = useState(0);
	const [forYouLoadingMore, setForYouLoadingMore] = useState(false);
	const [searchMode, setSearchMode] = useState(false);
	const [popularBrowse, setPopularBrowse] = useState<DiscoverBrowseResponse | null>(null);
	const [popularInterestContext, setPopularInterestContext] = useState<string | undefined>();
	const [forYouPopularCache, setForYouPopularCache] = useState<Record<string, DiscoverRecommendation[]>>({});
	const [forYouPopularLoading, setForYouPopularLoading] = useState<string | null>(null);
	const [notInterestedTarget, setNotInterestedTarget] = useState<DiscoverRecommendation | null>(null);
	const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
	const [undoFeedback, setUndoFeedback] = useState<UndoFeedbackState | null>(null);
	const undoTimerRef = useRef<number | null>(null);

	async function loadCategories() {
		try {
			const res = await fetch('/api/categories', { credentials: 'same-origin' });
			if (!res.ok) return;
			const body = (await res.json()) as { categories?: CategoryRecord[] };
			setCategories(body.categories ?? []);
		} catch {
			// Categories are optional in the follow modal.
		}
	}

	async function loadForYou(interestId: string, append = false) {
		const offset = append ? forYouItems.length : 0;
		const needsRemoteFetch = append && offset >= forYouTotal && forYouHasMore;
		const params = new URLSearchParams({
			tab: 'forYou',
			limit: String(FOR_YOU_PAGE_SIZE),
			offset: String(offset),
		});
		if (interestId !== 'all') params.set('interest', interestId);
		if (needsRemoteFetch) {
			params.set('loadMore', '1');
			if (interestId === 'all') params.set('forYouRefreshOffset', String(forYouRefreshOffset));
		}

		if (append) setForYouLoadingMore(true);
		else {
			setBrowseLoading(true);
			setForYouItems([]);
		}

		try {
			const res = await fetch(`/api/discover/browse?${params.toString()}`, { credentials: 'same-origin' });
			if (!res.ok) return;
			const body = (await res.json()) as DiscoverBrowseResponse;
			setForYouInterests(body.forYouInterests ?? []);
			setForYouTotal(body.forYouTotal ?? body.forYou.length);
			setForYouHasMore(body.forYouHasMore ?? false);
			setForYouMessage(body.forYouMessage);
			setForYouItems((prev) => (append ? mergeForYouItems(prev, body.forYou ?? []) : body.forYou ?? []));
			if (needsRemoteFetch && interestId === 'all') {
				setForYouRefreshOffset((value) => value + 2);
			}
			if (!append) {
				setForYouRefreshOffset(0);
			}
		} catch {
			// Browse is optional; search still works.
		} finally {
			if (append) setForYouLoadingMore(false);
			else setBrowseLoading(false);
		}
	}

	async function loadPopular(interestId?: string) {
		setBrowseLoading(true);
		try {
			const params = new URLSearchParams({ tab: 'popular' });
			if (interestId && interestId !== 'all') params.set('interest', interestId);
			const res = await fetch(`/api/discover/browse?${params.toString()}`, { credentials: 'same-origin' });
			if (!res.ok) return;
			const body = (await res.json()) as DiscoverBrowseResponse;
			setPopularBrowse(body);
			setBrowseCache((prev) => ({ ...prev, popular: body }));
		} catch {
			// Browse is optional; search still works.
		} finally {
			setBrowseLoading(false);
		}
	}

	async function loadBrowseTab(tab: DiscoverBrowseTab) {
		if (tab === 'forYou') return;
		if (tab === 'popular') {
			if (popularBrowse && popularInterestContext === undefined) return;
			await loadPopular(popularInterestContext);
			return;
		}
		if (browseCache[tab]) return;
		setBrowseLoading(true);
		try {
			const res = await fetch(`/api/discover/browse?tab=${tab}`, { credentials: 'same-origin' });
			if (!res.ok) return;
			const body = (await res.json()) as DiscoverBrowseResponse;
			setBrowseCache((prev) => ({ ...prev, [tab]: body }));
		} catch {
			// Browse is optional; search still works.
		} finally {
			setBrowseLoading(false);
		}
	}

	useEffect(() => {
		return () => {
			if (undoTimerRef.current != null) window.clearTimeout(undoTimerRef.current);
		};
	}, []);

	function showUndoBar(feedbackId: string, message: string) {
		setUndoFeedback({ feedbackId, message });
		if (undoTimerRef.current != null) window.clearTimeout(undoTimerRef.current);
		undoTimerRef.current = window.setTimeout(() => {
			setUndoFeedback(null);
			undoTimerRef.current = null;
		}, 10_000);
	}

	function removeForYouItem(externalId: string) {
		setForYouItems((rows) => rows.filter((row) => row.externalId !== externalId));
		setForYouTotal((value) => Math.max(0, value - 1));
		setForYouPopularCache((prev) => {
			const next: Record<string, DiscoverRecommendation[]> = {};
			for (const [key, rows] of Object.entries(prev)) {
				next[key] = rows.filter((row) => row.externalId !== externalId);
			}
			return next;
		});
	}

	async function submitNotInterested(action: RecommendationFeedbackAction) {
		if (!notInterestedTarget?.recommendationToken) return;
		setFeedbackSubmitting(true);
		onError('');
		try {
			const res = await fetch('/api/discover/feedback', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({
					recommendationToken: notInterestedTarget.recommendationToken,
					action,
				}),
			});
			const body = (await res.json()) as { error?: { message: string }; feedbackId?: string };
			if (!res.ok) throw new Error(body.error?.message ?? 'Could not record feedback.');
			const title = notInterestedTarget.title;
			removeForYouItem(notInterestedTarget.externalId);
			setNotInterestedTarget(null);
			if (body.feedbackId) {
				showUndoBar(
					body.feedbackId,
					action === 'not_relevant' ? `${title} marked not relevant.` : `${title} hidden.`,
				);
			}
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : 'Could not record feedback.');
		} finally {
			setFeedbackSubmitting(false);
		}
	}

	async function undoFeedbackAction() {
		if (!undoFeedback) return;
		onError('');
		try {
			const res = await fetch(`/api/discover/feedback/${encodeURIComponent(undoFeedback.feedbackId)}/restore`, {
				method: 'POST',
				credentials: 'same-origin',
			});
			const body = (await res.json()) as { error?: { message: string } };
			if (!res.ok) throw new Error(body.error?.message ?? 'Undo failed.');
			setUndoFeedback(null);
			if (undoTimerRef.current != null) {
				window.clearTimeout(undoTimerRef.current);
				undoTimerRef.current = null;
			}
			onStatus('Recommendation restored.');
			if (browseTab === 'forYou') void loadForYou(forYouInterest);
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : 'Undo failed.');
		}
	}


	useEffect(() => {
		void loadCategories();
	}, []);

	useEffect(() => {
		if (browseTab === 'forYou') {
			void loadForYou(forYouInterest);
		} else if (browseTab === 'popular') {
			void loadPopular(popularInterestContext);
		} else {
			void loadBrowseTab(browseTab);
		}
	}, [browseTab, forYouInterest, popularInterestContext]);

	async function loadMoreForYou() {
		if (forYouLoadingMore || !forYouHasMore) return;
		await loadForYou(forYouInterest, true);
	}

	function markUnsubscribed(channelId: string) {
		const mark = (rows: DiscoveryResult[]) =>
			rows.map((row) =>
				row.externalId === channelId || row.parentExternalId === channelId ? { ...row, subscribed: false } : row,
			);
		const removeChannel = (rows: DiscoveryResult[]) => rows.filter((row) => row.externalId !== channelId);
		setResponse((prev) => (prev ? { ...prev, results: mark(prev.results) } : prev));
		setForYouItems((rows) => mark(rows));
		setForYouPopularCache((prev) => {
			const next: Record<string, DiscoverRecommendation[]> = {};
			for (const [key, rows] of Object.entries(prev)) {
				next[key] = mark(rows);
			}
			return next;
		});
		setBrowseCache((prev) => {
			const next = { ...prev };
			for (const tab of Object.keys(next) as DiscoverBrowseTab[]) {
				const entry = next[tab];
				if (!entry) continue;
				next[tab] = {
					...entry,
					forYou: mark(entry.forYou ?? []),
					popularChannels: mark(entry.popularChannels ?? []),
					popularInterestChannels: mark(entry.popularInterestChannels ?? []),
					recentlyFollowed:
						tab === 'recent' ? removeChannel(entry.recentlyFollowed ?? []) : mark(entry.recentlyFollowed ?? []),
				};
			}
			return next;
		});
		setPopularBrowse((prev) =>
			prev
				? {
						...prev,
						popularChannels: mark(prev.popularChannels ?? []),
						popularInterestChannels: mark(prev.popularInterestChannels ?? []),
					}
				: prev,
		);
	}

	async function unfollowYoutube(channelId: string, title: string) {
		setUnfollowing(channelId);
		onError('');
		try {
			const res = await fetch('/api/discover/unfollow/youtube', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ channelId }),
			});
			const body = (await res.json()) as { error?: { message: string }; wasFollowing?: boolean };
			if (!res.ok) throw new Error(body.error?.message ?? 'Unfollow failed.');
			onStatus(body.wasFollowing ? `Unfollowed ${title} in VortiQuest.` : `${title} was not in your follows.`);
			markUnsubscribed(channelId);
			onSubscribed();
			setUnfollowConfirm(null);
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : 'Unfollow failed.');
		} finally {
			setUnfollowing(null);
		}
	}

	function youtubeChannelTitle(result: DiscoveryResult): string {
		return result.type === 'channel' ? result.title : result.parentTitle ?? result.publisher ?? result.title;
	}

	function requestUnfollow(channelId: string, title: string) {
		setUnfollowConfirm({ channelId, title });
	}

	async function confirmUnfollow() {
		if (!unfollowConfirm) return;
		await unfollowYoutube(unfollowConfirm.channelId, unfollowConfirm.title);
	}

	function requestFollow(result: DiscoverRecommendation, channelId: string) {
		onError('');
		setFollowSetup({
			channelId,
			title: youtubeChannelTitle(result),
			description: result.description,
			thumbnailUrl: result.type === 'channel' ? result.imageUrl : undefined,
			recommendationToken: result.recommendationToken,
		});
	}

	function renderForYouChannelActions(result: DiscoverRecommendation) {
		return (
			<div className="discover-action-stack">
				{renderYoutubeFollowAction(result, result.externalId)}
				<button
					className="ghost tiny discover-not-interested-btn"
					type="button"
					disabled={feedbackSubmitting}
					onClick={() => setNotInterestedTarget(result)}
				>
					Not interested
				</button>
			</div>
		);
	}

	function renderYoutubeFollowAction(result: DiscoveryResult, channelId: string) {
		if (result.subscribed) {
			return (
				<button
					className="discover-unfollow-btn"
					type="button"
					disabled={unfollowing === channelId}
					onClick={() => requestUnfollow(channelId, youtubeChannelTitle(result))}
				>
					{unfollowing === channelId ? 'Unfollowing…' : 'Unfollow in VortiQuest'}
				</button>
			);
		}
		return (
			<button
				className="discover-follow-btn"
				type="button"
				disabled={following === channelId || followSaving}
				onClick={() => requestFollow(result, channelId)}
			>
				{following === channelId ? 'Following…' : 'Follow in VortiQuest'}
			</button>
		);
	}

	function renderYoutubeChannelLink(result: DiscoveryResult, className: string, children: ReactNode) {
		return (
			<a className={className} href={channelUrl(result)} target="_blank" rel="noreferrer">
				{children}
			</a>
		);
	}

	function markSubscribed(channelId: string) {
		const mark = (rows: DiscoveryResult[]) =>
			rows.map((row) =>
				row.externalId === channelId || row.parentExternalId === channelId ? { ...row, subscribed: true } : row,
			);
		const filterForYou = (rows: DiscoverRecommendation[]) =>
			rows.filter((row) => row.externalId !== channelId && row.parentExternalId !== channelId);
		setResponse((prev) => (prev ? { ...prev, results: mark(prev.results) } : prev));
		setForYouItems((rows) => filterForYou(rows));
		setForYouPopularCache((prev) => {
			const next: Record<string, DiscoverRecommendation[]> = {};
			for (const [key, rows] of Object.entries(prev)) {
				next[key] = filterForYou(rows);
			}
			return next;
		});
		setPopularBrowse((prev) =>
			prev
				? {
						...prev,
						popularChannels: filterForYou(prev.popularChannels ?? []),
						popularInterestChannels: filterForYou(prev.popularInterestChannels ?? []),
					}
				: prev,
		);
		setBrowseCache((prev) => {
			const next = { ...prev };
			for (const tab of Object.keys(next) as DiscoverBrowseTab[]) {
				const entry = next[tab];
				if (!entry) continue;
				next[tab] = {
					...entry,
					recentlyFollowed: mark(entry.recentlyFollowed ?? []),
					popularChannels: mark(entry.popularChannels ?? []),
					popularInterestChannels: mark(entry.popularInterestChannels ?? []),
				};
			}
			return next;
		});
	}

	async function runSearch(event?: FormEvent) {
		event?.preventDefault();
		const q = query.trim();
		if (!q) {
			setResponse(null);
			setSearchMode(false);
			return;
		}
		setSearchMode(true);
		setLoading(true);
		onError('');
		try {
			const params = new URLSearchParams({ q, filter });
			const res = await fetch(`/api/discover/search?${params.toString()}`, { credentials: 'same-origin' });
			const body = (await res.json()) as DiscoverSearchResponse & { error?: { message: string } };
			if (!res.ok) throw new Error(body.error?.message ?? 'Search failed.');
			setResponse(body);
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : 'Search failed.');
		} finally {
			setLoading(false);
		}
	}

	async function subscribePodcast(result: DiscoveryResult) {
		const feedId = Number(result.externalId);
		if (!Number.isFinite(feedId) || result.type !== 'podcast') return;
		setSubscribing(result.externalId);
		onError('');
		try {
			const res = await fetch('/api/discover/subscribe/podcast', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({
					externalFeedId: feedId,
					feedUrl: result.feedUrl,
					title: result.title,
					publisher: result.publisher,
					description: result.description,
					imageUrl: result.imageUrl,
				}),
			});
			const body = (await res.json()) as { error?: { message: string }; episodesAdded?: number };
			if (!res.ok) throw new Error(body.error?.message ?? 'Subscribe failed.');
			onStatus(`Subscribed to ${result.title}. Added ${body.episodesAdded ?? 0} episodes.`);
			setResponse((prev) =>
				prev
					? {
							...prev,
							results: prev.results.map((row) =>
								row.externalId === result.externalId || row.parentExternalId === result.externalId
									? { ...row, subscribed: true }
									: row,
							),
						}
					: prev,
			);
			onSubscribed();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : 'Subscribe failed.');
		} finally {
			setSubscribing(null);
		}
	}

	async function runCatchupChannel(channelId: string, title: string, pull: number) {
		let pageToken = '';
		let pulled = 0;
		let added = 0;
		const want = Math.min(500, pull);
		for (;;) {
			onStatus(`Catching up ${title}… ${pulled} / ${want}`);
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
			if (body.done) break;
			if ((body.videosAdded ?? 0) < 1) break;
			pageToken = body.nextPageToken ?? '';
			if (pulled >= nextWant) break;
		}
		if (added > 0) {
			onStatus(`Added ${added} videos from ${title}.`);
		}
	}

	async function saveFollowSetup(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!followSetup) return;
		const form = new FormData(event.currentTarget);
		const maxVideosToPull = Number(form.get('maxVideosToPull') || 0);
		const categoryIds = form.getAll('categoryIds').map(String);
		const followInInbox = form.get('followInInbox') === 'on';

		setFollowSaving(true);
		setFollowing(followSetup.channelId);
		onError('');
		try {
			const followRes = await fetch('/api/discover/follow/youtube', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({
					channelId: followSetup.channelId,
					title: followSetup.title,
					description: followSetup.description,
					thumbnailUrl: followSetup.thumbnailUrl,
					...(followSetup.recommendationToken ? { recommendationToken: followSetup.recommendationToken } : {}),
				}),
			});
			const followBody = (await followRes.json()) as { error?: { message: string }; alreadyFollowing?: boolean };
			if (!followRes.ok) throw new Error(followBody.error?.message ?? 'Follow failed.');

			const patchRes = await fetch(`/api/channels/${encodeURIComponent(followSetup.channelId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({
					followInInbox,
					maxVideosToPull,
					categoryIds,
				}),
			});
			if (!patchRes.ok) throw new Error('Could not save channel settings.');

			if (maxVideosToPull > 0) {
				await runCatchupChannel(followSetup.channelId, followSetup.title, maxVideosToPull);
			} else if (followBody.alreadyFollowing) {
				onStatus(`Updated settings for ${followSetup.title}.`);
			} else {
				onStatus(`Now following ${followSetup.title} in VortiQuest.`);
			}

			markSubscribed(followSetup.channelId);
			onSubscribed();
			setFollowSetup(null);
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : 'Follow failed.');
		} finally {
			setFollowSaving(false);
			setFollowing(null);
		}
	}

	function renderActions(result: DiscoveryResult | DiscoverRecommendation, forYou = false) {
		if (result.type === 'podcast') {
			return result.subscribed ? (
				<span className="muted">Subscribed ✓</span>
			) : (
				<button
					className="ghost tiny"
					type="button"
					disabled={subscribing === result.externalId}
					onClick={() => void subscribePodcast(result)}
				>
					{subscribing === result.externalId ? 'Subscribing…' : 'Subscribe'}
				</button>
			);
		}
		if (result.type === 'episode' && result.parentExternalId) {
			return (
				<button
					className="ghost tiny"
					type="button"
					disabled={subscribing === result.parentExternalId || result.subscribed}
					onClick={() =>
						void subscribePodcast({
							...result,
							type: 'podcast',
							externalId: result.parentExternalId!,
							title: result.parentTitle ?? result.publisher ?? result.title,
						})
					}
				>
					{result.subscribed ? 'Subscribed ✓' : subscribing === result.parentExternalId ? 'Subscribing…' : 'Subscribe to podcast'}
				</button>
			);
		}
		if (result.provider === 'youtube' && result.type === 'channel') {
			if (forYou && 'recommendationToken' in result && result.recommendationToken) {
				return renderForYouChannelActions(result as DiscoverRecommendation);
			}
			return renderYoutubeFollowAction(result, result.externalId);
		}
		if (result.provider === 'youtube' && result.type === 'video' && result.parentExternalId) {
			return (
				<div className="discover-action-stack">
					{result.watchUrl ? (
						<a className="ghost tiny" href={result.watchUrl} target="_blank" rel="noreferrer">
							Watch
						</a>
					) : null}
					{renderYoutubeFollowAction(result, result.parentExternalId)}
				</div>
			);
		}
		return null;
	}

	function renderResult(result: DiscoveryResult | DiscoverRecommendation, forYou = false) {
		const isChannel = result.type === 'channel';
		const isYoutubeChannel = isChannel && result.provider === 'youtube';
		const reason = 'recommendationReason' in result ? result.recommendationReason : undefined;
		return (
			<li
				key={`${result.provider}-${result.type}-${result.externalId}`}
				className={isChannel ? 'discover-result discover-result-channel' : 'discover-result'}
			>
				<div className="discover-thumb-wrap">
					{isYoutubeChannel ? (
						renderYoutubeChannelLink(
							result,
							'discover-channel-link discover-channel-thumb-link',
							result.imageUrl ? (
								<img src={result.imageUrl} alt="" className="discover-thumb" />
							) : (
								<span className="discover-thumb placeholder" aria-hidden="true" />
							),
						)
					) : result.imageUrl ? (
						<img src={result.imageUrl} alt="" className="discover-thumb" />
					) : (
						<span className="discover-thumb placeholder" aria-hidden="true" />
					)}
				</div>
				<div className="discover-result-body">
					{renderTypeBadge(result)}
					{isYoutubeChannel ? (
						renderYoutubeChannelLink(result, 'discover-channel-link discover-channel-title-link', <strong className="video-title">{result.title}</strong>)
					) : (
						<strong className="video-title">{result.title}</strong>
					)}
					{result.publisher && result.type !== 'channel' ? <small className="muted">{result.publisher}</small> : null}
					{result.description ? (
						isYoutubeChannel ? (
							renderYoutubeChannelLink(result, 'discover-channel-link discover-channel-desc-link', <p className="muted discover-desc">{result.description}</p>)
						) : (
							<p className="muted discover-desc">{result.description}</p>
						)
					) : null}
					{reason ? <p className="discover-reason">{reason}</p> : null}
					{result.parentTitle ? <small className="muted">From {result.parentTitle}</small> : null}
				</div>
				<div className="discover-result-actions">{renderActions(result, forYou)}</div>
			</li>
		);
	}

	const filtered =
		response?.results.filter((row) => {
			if (filter === 'all') return true;
			if (filter === 'podcasts') return row.provider === 'podcast';
			if (filter === 'youtube') return row.provider === 'youtube';
			return row.type === 'live';
		}) ?? [];

	const activeBrowse = browseTab === 'popular' ? popularBrowse ?? browseCache.popular : browseCache[browseTab];
	const popularInterestChannels = activeBrowse?.popularInterestChannels ?? [];
	const popularChannels = activeBrowse?.popularChannels ?? [];
	const popularInterestLabel = activeBrowse?.popularInterestLabel;
	const forYouDisplayItems =
		browseTab === 'forYou'
			? buildForYouDisplayItems(forYouInterest, forYouItems, forYouPopularCache)
			: [];
	const showingPopularFallback = isShowingPopularFallback(forYouInterest, forYouItems, forYouPopularCache);
	const popularFallbackLabel =
		forYouInterests?.find((row) => row.id === forYouInterest)?.label ?? 'this interest';
	const browseResults =
		browseTab === 'forYou'
			? forYouDisplayItems
			: browseTab === 'recent'
				? activeBrowse?.recentlyFollowed ?? []
				: [];
	const showForYouSeeMore = browseTab === 'forYou' && forYouItems.length > 0 && forYouHasMore;
	const forYouPopularCacheKey = forYouInterest === 'all' ? FOR_YOU_ALL_POPULAR_KEY : forYouInterest;
	const forYouEmpty =
		browseTab === 'forYou' &&
		!browseLoading &&
		!forYouPopularLoading &&
		forYouDisplayItems.length === 0;
	const popularEmpty =
		browseTab === 'popular' && !browseLoading && popularInterestChannels.length === 0 && popularChannels.length === 0;
	const searchActive = searchMode;

	function selectBrowseTab(value: DiscoverBrowseTab) {
		setSearchMode(false);
		setResponse(null);
		if (value === 'popular') {
			setPopularInterestContext(undefined);
			setPopularBrowse(null);
		}
		setBrowseTab(value);
	}

	async function browsePopularFromInterest() {
		setSearchMode(false);
		setResponse(null);
		onError('');
		const cacheKey = forYouPopularCacheKey;
		if (forYouPopularCache[cacheKey]?.length) return;

		setForYouPopularLoading(cacheKey);
		try {
			const params = new URLSearchParams({ tab: 'popular' });
			if (forYouInterest !== 'all') params.set('interest', forYouInterest);
			const res = await fetch(`/api/discover/browse?${params.toString()}`, { credentials: 'same-origin' });
			if (!res.ok) {
				onError('Could not load popular channels.');
				return;
			}
			const body = (await res.json()) as DiscoverBrowseResponse;
			const channels =
				forYouInterest === 'all'
					? (body.popularChannels ?? [])
					: (body.popularInterestChannels ?? []);
			setForYouPopularCache((prev) => ({ ...prev, [cacheKey]: channels }));
		} catch {
			onError('Could not load popular channels.');
		} finally {
			setForYouPopularLoading(null);
		}
	}

	return (
		<div className="discover-shell">
			<div className="discover-scroll">
				<div className="discover-page">
			<section className="discover-sections">
				<div className="discover-section-header">
					<h2>Browse</h2>
					<Link className="discover-history-link" to="/settings/recommendation-history">
						Recommendation history
					</Link>
				</div>
				<div className="discover-toolbar">
					<div className="discover-browse-tabs" role="tablist" aria-label="Browse tabs">
						{(
							[
								['forYou', 'For You'],
								['popular', 'Popular'],
								['recent', 'Recently Followed'],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								type="button"
								className={browseTab === value && !searchActive ? 'tab active' : 'tab'}
								role="tab"
								aria-selected={browseTab === value && !searchActive}
								onClick={() => selectBrowseTab(value)}
							>
								{label}
							</button>
						))}
					</div>

					<form className="discover-search" onSubmit={(e) => void runSearch(e)}>
						<label className="discover-search-field">
							<IconSearch />
							<input
								type="search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search podcasts, YouTube channels, creators, or topics"
								aria-label="Discover search"
							/>
						</label>
						<button className="ghost discover-search-submit" type="submit" disabled={loading}>
							{loading ? 'Searching…' : 'Search'}
						</button>
					</form>

					<div className="discover-filters" role="tablist" aria-label="Result filters">
						{(['all', 'podcasts', 'youtube'] as DiscoverFilter[]).map((value) => (
							<button
								key={value}
								type="button"
								className={filter === value ? 'tab active' : 'tab'}
								role="tab"
								aria-selected={filter === value}
								onClick={() => setFilter(value)}
							>
								{value === 'all' ? 'All' : value === 'podcasts' ? 'Podcasts' : 'YouTube'}
							</button>
						))}
					</div>
				</div>

				{undoFeedback ? (
					<div className="discover-undo-bar" role="status">
						<span>{undoFeedback.message}</span>
						<button className="ghost tiny" type="button" onClick={() => void undoFeedbackAction()}>
							Undo
						</button>
					</div>
				) : null}

				{searchActive ? (
					<div className="discover-search-results">
						{response?.cached ? <p className="muted discover-hint">Showing cached Discover results.</p> : null}

						{response?.warnings.length ? (
							<div className="status-line warning">
								{response.warnings.map((w) => (
									<p key={`${w.provider}-${w.message}`}>{w.message}</p>
								))}
							</div>
						) : null}

						{loading ? <p className="muted discover-hint">Searching…</p> : null}

						{response && filtered.length === 0 && !loading ? (
							<p className="muted discover-hint">No results found for &ldquo;{response.query}&rdquo;.</p>
						) : null}

						{filtered.length ? (
							<ul className="discover-results">{filtered.map((result) => renderResult(result))}</ul>
						) : null}
					</div>
				) : null}

				{!searchActive && browseTab === 'forYou' && forYouInterests && forYouInterests.length ? (
					<div className="discover-interest-chips" role="tablist" aria-label="For You interests">
						<button
							type="button"
							className={forYouInterest === 'all' ? 'tab active' : 'tab'}
							role="tab"
							aria-selected={forYouInterest === 'all'}
							onClick={() => setForYouInterest('all')}
						>
							All
						</button>
						{forYouInterests.map((interest) => (
							<button
								key={interest.id}
								type="button"
								className={forYouInterest === interest.id ? 'tab active' : 'tab'}
								role="tab"
								aria-selected={forYouInterest === interest.id}
								onClick={() => setForYouInterest(interest.id)}
							>
								{interest.label}
							</button>
						))}
					</div>
				) : null}

				{!searchActive && browseLoading && browseTab === 'forYou' ? (
					<p className="muted discover-hint">Loading browse…</p>
				) : null}

				{!searchActive && browseTab === 'forYou' && forYouPopularLoading ? (
					<p className="muted discover-hint">Loading popular channels…</p>
				) : null}

				{!searchActive && browseLoading && browseTab !== 'forYou' && !activeBrowse ? (
					<p className="muted discover-hint">Loading browse…</p>
				) : null}

				{!searchActive && browseTab === 'forYou' && forYouEmpty ? (
					<div className="discover-section-block">
						<p className="muted">{forYouMessage ?? 'Follow and categorize channels to improve For You.'}</p>
						<button
							className="ghost tiny"
							type="button"
							disabled={forYouPopularLoading === forYouPopularCacheKey}
							onClick={() => void browsePopularFromInterest()}
						>
							{forYouPopularLoading === forYouPopularCacheKey ? 'Loading popular…' : 'Browse Popular'}
						</button>
					</div>
				) : null}

				{!searchActive && browseTab === 'forYou' && showingPopularFallback ? (
					<p className="muted discover-hint">Popular {popularFallbackLabel} channels</p>
				) : null}

				{!searchActive && browseTab === 'popular' && popularInterestChannels.length ? (
					<div className="discover-section-block">
						<h3 className="discover-section-title">
							Popular {popularInterestLabel ?? 'interest'} channels
						</h3>
						<ul className="discover-results">{popularInterestChannels.map((result) => renderResult(result))}</ul>
					</div>
				) : null}

				{!searchActive && browseTab === 'popular' && popularChannels.length ? (
					<div className="discover-section-block">
						{popularInterestChannels.length ? (
							<h3 className="discover-section-title">Other popular channels</h3>
						) : null}
						<ul className="discover-results">{popularChannels.map((result) => renderResult(result))}</ul>
					</div>
				) : null}

				{!searchActive && browseResults.length ? (
					<div className="discover-section-block">
						<ul className="discover-results">
							{browseResults.map((result) => renderResult(result, browseTab === 'forYou'))}
						</ul>
						{showForYouSeeMore ? (
							<div className="discover-see-more-wrap">
								<button
									className="ghost discover-see-more"
									type="button"
									disabled={forYouLoadingMore}
									onClick={() => void loadMoreForYou()}
								>
									{forYouLoadingMore
										? 'Loading more…'
										: 'See more'}
								</button>
							</div>
						) : null}
					</div>
				) : null}

				{!searchActive && !browseLoading && activeBrowse && browseResults.length === 0 && browseTab === 'recent' ? (
					<p className="muted">Add channels in VortiQuest to see them here.</p>
				) : null}

				{!searchActive && popularEmpty ? (
					<p className="muted">Popular channels refresh every few hours.</p>
				) : null}
				</section>
				</div>
			</div>
			{followSetup ? (
				<div className="modal-backdrop" onClick={() => !followSaving && setFollowSetup(null)}>
					<form
						className="modal discover-follow-modal"
						onClick={(e) => e.stopPropagation()}
						onSubmit={(e) => void saveFollowSetup(e)}
						role="dialog"
						aria-modal="true"
						aria-labelledby="discover-follow-title"
					>
						<h2 id="discover-follow-title">Follow {followSetup.title}</h2>
						<label className="check">
							<input type="checkbox" name="followInInbox" defaultChecked />
							Follow in inbox (always pull new videos)
						</label>
						<label>
							How many older videos to catch up (0–500)
							<input type="number" name="maxVideosToPull" min={0} max={500} defaultValue={0} />
						</label>
						<fieldset className="modal-cats">
							<legend>Categories</legend>
							{categories.length === 0 ? (
								<p className="muted">Add a category on the By Category tab first.</p>
							) : (
								categories.map((cat) => (
									<label key={cat.id} className="check">
										<input type="checkbox" name="categoryIds" value={cat.id} />
										{cat.name}
									</label>
								))
							)}
						</fieldset>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setFollowSetup(null)} disabled={followSaving}>
								Cancel
							</button>
							<button className="discover-follow-btn discover-follow-modal-save" type="submit" disabled={followSaving}>
								{followSaving ? 'Saving…' : 'Save'}
							</button>
						</div>
					</form>
				</div>
			) : null}
			{notInterestedTarget ? (
				<div className="modal-backdrop" onClick={() => !feedbackSubmitting && setNotInterestedTarget(null)}>
					<div
						className="modal discover-feedback-modal"
						onClick={(e) => e.stopPropagation()}
						role="dialog"
						aria-modal="true"
						aria-labelledby="discover-feedback-title"
					>
						<h2 id="discover-feedback-title">Why don&apos;t you want this recommendation?</h2>
						<div className="discover-feedback-options">
							<button
								className="discover-feedback-option"
								type="button"
								disabled={feedbackSubmitting}
								onClick={() => void submitNotInterested('channel_not_interested')}
							>
								<strong>Not interested in this channel</strong>
								<span className="muted">
									Hide this channel. This will not change the topics VortiQuest thinks you&apos;re interested in.
								</span>
							</button>
							<button
								className="discover-feedback-option"
								type="button"
								disabled={feedbackSubmitting}
								onClick={() => void submitNotInterested('not_relevant')}
							>
								<strong>Not relevant to this topic</strong>
								<span className="muted">
									Hide this channel and use this feedback to improve recommendations for this topic.
								</span>
							</button>
						</div>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setNotInterestedTarget(null)} disabled={feedbackSubmitting}>
								Cancel
							</button>
						</div>
					</div>
				</div>
			) : null}
			{unfollowConfirm ? (
				<div className="modal-backdrop" onClick={() => setUnfollowConfirm(null)}>
					<div className="modal discover-unfollow-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="discover-unfollow-title">
						<h2 id="discover-unfollow-title">Unfollow channel?</h2>
						<p>
							Are you sure you want to unfollow <strong>{unfollowConfirm.title}</strong>?
						</p>
						<div className="modal-actions">
							<button className="ghost" type="button" onClick={() => setUnfollowConfirm(null)} disabled={unfollowing === unfollowConfirm.channelId}>
								Cancel
							</button>
							<button
								className="ghost discover-unfollow"
								type="button"
								disabled={unfollowing === unfollowConfirm.channelId}
								onClick={() => void confirmUnfollow()}
							>
								{unfollowing === unfollowConfirm.channelId ? 'Unfollowing…' : 'Confirm'}
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
