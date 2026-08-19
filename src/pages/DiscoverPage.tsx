import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { CategoryRecord } from '../types';
import type {
	DiscoverBrowseResponse,
	DiscoverBrowseTab,
	DiscoverFilter,
	DiscoverRecommendation,
	DiscoverSearchResponse,
	DiscoveryResult,
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

	async function loadBrowseTab(tab: DiscoverBrowseTab) {
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
		void loadBrowseTab('forYou');
		void loadCategories();
	}, []);

	useEffect(() => {
		void loadBrowseTab(browseTab);
	}, [browseTab]);

	function markUnsubscribed(channelId: string) {
		const mark = (rows: DiscoveryResult[]) =>
			rows.map((row) =>
				row.externalId === channelId || row.parentExternalId === channelId ? { ...row, subscribed: false } : row,
			);
		const removeChannel = (rows: DiscoveryResult[]) => rows.filter((row) => row.externalId !== channelId);
		setResponse((prev) => (prev ? { ...prev, results: mark(prev.results) } : prev));
		setBrowseCache((prev) => {
			const next = { ...prev };
			for (const tab of Object.keys(next) as DiscoverBrowseTab[]) {
				const entry = next[tab];
				if (!entry) continue;
				next[tab] = {
					...entry,
					forYou: mark(entry.forYou ?? []),
					popularVideos: mark(entry.popularVideos ?? []),
					recentlyFollowed:
						tab === 'recent' ? removeChannel(entry.recentlyFollowed ?? []) : mark(entry.recentlyFollowed ?? []),
				};
			}
			return next;
		});
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

	function requestFollow(result: DiscoveryResult, channelId: string) {
		onError('');
		setFollowSetup({
			channelId,
			title: youtubeChannelTitle(result),
			description: result.description,
			thumbnailUrl: result.type === 'channel' ? result.imageUrl : undefined,
		});
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
		setBrowseCache((prev) => {
			const next = { ...prev };
			for (const tab of Object.keys(next) as DiscoverBrowseTab[]) {
				const entry = next[tab];
				if (!entry) continue;
				next[tab] = {
					...entry,
					forYou: tab === 'forYou' ? filterForYou(entry.forYou ?? []) : entry.forYou,
					recentlyFollowed: mark(entry.recentlyFollowed ?? []),
					popularVideos: mark(entry.popularVideos ?? []),
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
			return;
		}
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

	function renderActions(result: DiscoveryResult) {
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

	function renderResult(result: DiscoveryResult | DiscoverRecommendation) {
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
				<div className="discover-result-actions">{renderActions(result)}</div>
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

	const activeBrowse = browseCache[browseTab];
	const forYouInterests = activeBrowse?.forYouInterests ?? [];
	const allForYou = activeBrowse?.forYou ?? [];
	const browseResults =
		browseTab === 'forYou'
			? forYouInterest === 'all'
				? allForYou
				: allForYou.filter((row) => row.interestId === forYouInterest)
			: browseTab === 'popular'
				? activeBrowse?.popularVideos ?? []
				: activeBrowse?.recentlyFollowed ?? [];

	return (
		<div className="discover-shell">
			<div className="discover-scroll">
				<div className="discover-page">
			{response?.cached ? <p className="muted discover-hint">Showing cached Discover results.</p> : null}

			{response?.warnings.length ? (
				<div className="status-line warning">
					{response.warnings.map((w) => (
						<p key={`${w.provider}-${w.message}`}>{w.message}</p>
					))}
				</div>
			) : null}

			{response && filtered.length === 0 && !loading ? (
				<p className="muted discover-hint">No results found for &ldquo;{response.query}&rdquo;.</p>
			) : null}

			{filtered.length ? <ul className="discover-results">{filtered.map((result) => renderResult(result))}</ul> : null}

			<section className="discover-sections">
				<h2>Browse</h2>
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
								className={browseTab === value ? 'tab active' : 'tab'}
								role="tab"
								aria-selected={browseTab === value}
								onClick={() => setBrowseTab(value)}
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

				{browseTab === 'forYou' && forYouInterests.length ? (
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

				{browseLoading && !activeBrowse ? <p className="muted discover-hint">Loading browse…</p> : null}

				{browseTab === 'forYou' && activeBrowse?.forYouEmpty ? (
					<div className="discover-section-block">
						<p className="muted">{activeBrowse.forYouMessage ?? 'Follow and categorize channels to improve For You.'}</p>
						<button className="ghost tiny" type="button" onClick={() => setBrowseTab('popular')}>
							Browse Popular
						</button>
					</div>
				) : null}

				{browseResults.length ? (
					<div className="discover-section-block">
						<ul className="discover-results">{browseResults.map((result) => renderResult(result))}</ul>
					</div>
				) : null}

				{!browseLoading && activeBrowse && browseResults.length === 0 && browseTab !== 'forYou' ? (
					<p className="muted">
						{browseTab === 'recent'
							? 'Add channels in VortiQuest to see them here.'
							: 'Popular videos refresh every few hours.'}
					</p>
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
