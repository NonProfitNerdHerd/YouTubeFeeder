import { useState, type FormEvent } from 'react';
import type { DiscoverFilter, DiscoverSearchResponse, DiscoveryResult } from '../types/discover';

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
	const [subscribing, setSubscribing] = useState<string | null>(null);

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

	const filtered =
		response?.results.filter((row) => {
			if (filter === 'all') return true;
			if (filter === 'podcasts') return row.provider === 'podcast';
			if (filter === 'youtube') return row.provider === 'youtube';
			return row.type === 'live';
		}) ?? [];

	return (
		<div className="discover-page">
			<form className="discover-search" onSubmit={(e) => void runSearch(e)}>
				<IconSearch />
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search podcasts, YouTube channels, creators, or topics"
					aria-label="Discover search"
				/>
				<button className="ghost" type="submit" disabled={loading}>
					{loading ? 'Searching…' : 'Search'}
				</button>
			</form>

			<div className="discover-filters" role="tablist" aria-label="Result filters">
				{(['all', 'podcasts', 'youtube', 'live'] as DiscoverFilter[]).map((value) => (
					<button
						key={value}
						type="button"
						className={filter === value ? 'tab active' : 'tab'}
						role="tab"
						aria-selected={filter === value}
						onClick={() => setFilter(value)}
					>
						{value === 'all' ? 'All' : value === 'podcasts' ? 'Podcasts' : value === 'youtube' ? 'YouTube' : 'Live'}
					</button>
				))}
			</div>

			{!response && !loading ? (
				<p className="muted discover-hint">Search for podcasts, YouTube channels, videos, and live sources.</p>
			) : null}

			{response?.warnings.length ? (
				<div className="status-line warning">
					{response.warnings.map((w) => (
						<p key={w.provider}>{w.message}</p>
					))}
				</div>
			) : null}

			{response && filtered.length === 0 && !loading ? (
				<p className="muted discover-hint">No results found for &ldquo;{response.query}&rdquo;.</p>
			) : null}

			<ul className="discover-results">
				{filtered.map((result) => (
					<li key={`${result.provider}-${result.type}-${result.externalId}`} className="discover-result">
						{result.imageUrl ? <img src={result.imageUrl} alt="" className="discover-thumb" /> : <span className="discover-thumb placeholder" />}
						<div className="discover-result-body">
							<span className="badge podcast">{typeLabel(result)}</span>
							<strong className="video-title">{result.title}</strong>
							{result.publisher ? <small className="muted">{result.publisher}</small> : null}
							{result.description ? <p className="muted discover-desc">{result.description}</p> : null}
							{result.parentTitle ? (
								<small className="muted">From {result.parentTitle}</small>
							) : null}
						</div>
						<div className="discover-result-actions">
							{result.type === 'podcast' ? (
								result.subscribed ? (
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
								)
							) : result.type === 'episode' && result.parentExternalId ? (
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
							) : null}
						</div>
					</li>
				))}
			</ul>

			<section className="discover-sections muted">
				<h2>Browse</h2>
				<p>Podcasts, YouTube, Live, Categories, Popular, and Recently Added sections will appear here as providers are connected.</p>
			</section>
		</div>
	);
}
