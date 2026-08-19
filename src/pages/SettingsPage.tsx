import { Link } from 'react-router-dom';
import { STREAMFEEDER_DISPLAY_NAME } from '../lib/androidRelease';
import type { CurrentUser } from '../types';
import '../styles/app.css';
import '../styles/settings.css';

export function SettingsPage({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
	return (
		<div className="shell settings-shell">
			<header className="topbar">
				<div className="topbar-left">
					<h1 className="brand">{STREAMFEEDER_DISPLAY_NAME}</h1>
					<span className="tab active" aria-current="page">
						Settings
					</span>
				</div>
				<div className="topbar-actions">
					<span className="muted">{user.displayName}</span>
					<button className="ghost" type="button" onClick={onLogout}>
						Sign out
					</button>
					<Link className="ghost" to="/">
						Back to Feed
					</Link>
				</div>
			</header>
			<main className="settings-page">
				<section className="settings-intro">
					<h2>Settings</h2>
					<p className="muted">
						This page is a placeholder. Options below are mocked and not saved yet — pick what you want here and we can wire them up
						later.
					</p>
				</section>

				<section className="settings-section" aria-labelledby="settings-account">
					<h3 id="settings-account">Account</h3>
					<p className="muted">Signed in as {user.displayName}.</p>
					<label className="settings-row settings-row-disabled">
						<span>Display name</span>
						<input type="text" value={user.displayName} disabled readOnly />
					</label>
				</section>

				<section className="settings-section" aria-labelledby="settings-feed">
					<h3 id="settings-feed">Feed</h3>
					<label className="settings-row settings-row-disabled">
						<span>Default inbox view</span>
						<select disabled defaultValue="inbox">
							<option value="inbox">Inbox</option>
							<option value="snoozed">Snoozed</option>
							<option value="deleted">Deleted</option>
						</select>
					</label>
					<label className="settings-row settings-row-disabled">
						<span>Mark videos read when opened</span>
						<input type="checkbox" disabled defaultChecked />
					</label>
				</section>

				<section className="settings-section" aria-labelledby="settings-sync">
					<h3 id="settings-sync">Sync</h3>
					<label className="settings-row settings-row-disabled">
						<span>Background sync interval</span>
						<select disabled defaultValue="cron">
							<option value="cron">Use server schedule</option>
							<option value="manual">Manual only</option>
						</select>
					</label>
					<p className="muted settings-note">WebSub and cron keep subscriptions up to date; this control is not live yet.</p>
				</section>

				<section className="settings-section" aria-labelledby="settings-discover">
					<h3 id="settings-discover">Discover</h3>
					<p className="muted">
						Review channels you hid from For You, see why they were hidden, and restore them.
					</p>
					<p>
						<Link to="/settings/recommendation-history">Open recommendation history</Link>
					</p>
				</section>

				<section className="settings-section" aria-labelledby="settings-android">
					<h3 id="settings-android">Android</h3>
					<p className="muted">
						Sideload builds and release notes stay on the download page for now.{' '}
						<Link to="/download/android">Open Android download</Link>
					</p>
				</section>
			</main>
		</div>
	);
}
