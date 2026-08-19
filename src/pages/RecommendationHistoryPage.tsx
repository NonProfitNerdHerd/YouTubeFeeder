import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RecommendationFeedbackAction, RecommendationHistoryEntry } from '../types/discover';
import { STREAMFEEDER_DISPLAY_NAME } from '../lib/androidRelease';
import '../styles/app.css';
import '../styles/settings.css';

type HistoryFilter = 'all' | 'channel' | 'not_relevant';
type HistoryStatus = 'active' | 'restored' | 'all';

const ACTION_LABELS: Record<RecommendationFeedbackAction, string> = {
	followed: 'Followed from For You',
	channel_not_interested: 'Not interested in this channel',
	not_relevant: 'Not relevant to this topic',
};

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
	} catch {
		return iso;
	}
}

export function RecommendationHistoryPage() {
	const [entries, setEntries] = useState<RecommendationHistoryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [filter, setFilter] = useState<HistoryFilter>('all');
	const [status, setStatus] = useState<HistoryStatus>('active');
	const [query, setQuery] = useState('');
	const [restoringId, setRestoringId] = useState<string | null>(null);

	async function loadHistory(nextFilter = filter, nextStatus = status, nextQuery = query) {
		setLoading(true);
		setError('');
		try {
			const params = new URLSearchParams({ filter: nextFilter, status: nextStatus });
			if (nextQuery.trim()) params.set('q', nextQuery.trim());
			const res = await fetch(`/api/discover/recommendation-history?${params.toString()}`, {
				credentials: 'same-origin',
			});
			const body = (await res.json()) as { entries?: RecommendationHistoryEntry[]; error?: { message: string } };
			if (!res.ok) throw new Error(body.error?.message ?? 'Could not load recommendation history.');
			setEntries(body.entries ?? []);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Could not load recommendation history.');
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void loadHistory();
	}, [filter, status]);

	async function restoreEntry(id: string) {
		setRestoringId(id);
		setError('');
		try {
			const res = await fetch(`/api/discover/feedback/${encodeURIComponent(id)}/restore`, {
				method: 'POST',
				credentials: 'same-origin',
			});
			const body = (await res.json()) as { error?: { message: string } };
			if (!res.ok) throw new Error(body.error?.message ?? 'Restore failed.');
			await loadHistory();
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Restore failed.');
		} finally {
			setRestoringId(null);
		}
	}

	return (
		<div className="shell settings-shell">
			<header className="topbar">
				<div className="topbar-left">
					<h1 className="brand">{STREAMFEEDER_DISPLAY_NAME}</h1>
					<span className="tab active" aria-current="page">
						Recommendation History
					</span>
				</div>
				<div className="topbar-actions">
					<Link className="ghost" to="/settings">
						Settings
					</Link>
					<Link className="ghost" to="/">
						Back to Feed
					</Link>
				</div>
			</header>
			<main className="settings-page recommendation-history-page">
				<section className="settings-intro">
					<h2>Recommendation History</h2>
					<p className="muted">Review channels you hid from For You and restore them if you change your mind.</p>
				</section>

				<section className="settings-section" aria-labelledby="history-filters">
					<h3 id="history-filters">Filters</h3>
					<div className="recommendation-history-filters">
						<div className="discover-browse-tabs" role="tablist" aria-label="Feedback type">
							{(
								[
									['all', 'All'],
									['channel', 'Channel choices'],
									['not_relevant', 'Not relevant'],
								] as const
							).map(([value, label]) => (
								<button
									key={value}
									type="button"
									className={filter === value ? 'tab active' : 'tab'}
									onClick={() => setFilter(value)}
								>
									{label}
								</button>
							))}
						</div>
						<div className="discover-browse-tabs" role="tablist" aria-label="History status">
							{(
								[
									['active', 'Active'],
									['restored', 'Restored'],
									['all', 'All'],
								] as const
							).map(([value, label]) => (
								<button
									key={value}
									type="button"
									className={status === value ? 'tab active' : 'tab'}
									onClick={() => setStatus(value)}
								>
									{label}
								</button>
							))}
						</div>
						<form
							className="recommendation-history-search"
							onSubmit={(e) => {
								e.preventDefault();
								void loadHistory(filter, status, query);
							}}
						>
							<input
								type="search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search by channel name"
								aria-label="Search recommendation history"
							/>
							<button className="ghost" type="submit">
								Search
							</button>
						</form>
					</div>
				</section>

				{error ? <p className="status-line error">{error}</p> : null}
				{loading ? <p className="muted">Loading history…</p> : null}

				<section className="settings-section" aria-labelledby="history-list">
					<h3 id="history-list">Hidden channels</h3>
					{!loading && entries.length === 0 ? (
						<p className="muted">No recommendation history matches these filters.</p>
					) : null}
					<ul className="recommendation-history-list">
						{entries.map((entry) => (
							<li key={entry.id} className="recommendation-history-item">
								{entry.channelThumbnail ? (
									<img src={entry.channelThumbnail} alt="" className="recommendation-history-thumb" />
								) : (
									<span className="recommendation-history-thumb placeholder" aria-hidden="true" />
								)}
								<div className="recommendation-history-body">
									<strong>{entry.channelTitle}</strong>
									{entry.interestLabel ? (
										<p className="muted">
											Topic: {entry.interestLabel}
										</p>
									) : null}
									<p className="muted">You chose: {entry.actionLabel ?? ACTION_LABELS[entry.action]}</p>
									<p className="muted">{formatDate(entry.createdAt)}</p>
									{entry.restoredAt ? (
										<p className="muted">Restored {formatDate(entry.restoredAt)}</p>
									) : null}
								</div>
								{entry.active ? (
									<button
										className="ghost tiny"
										type="button"
										disabled={restoringId === entry.id}
										onClick={() => void restoreEntry(entry.id)}
									>
										{restoringId === entry.id ? 'Restoring…' : 'Restore'}
									</button>
								) : null}
							</li>
						))}
					</ul>
				</section>
			</main>
		</div>
	);
}
