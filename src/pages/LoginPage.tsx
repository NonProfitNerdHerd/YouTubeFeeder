import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isAndroidClient } from '../lib/androidClient';
import { STREAMFEEDER_DISPLAY_NAME } from '../lib/androidRelease';
import '../styles/login.css';

const ERRORS: Record<string, string> = {
	access_denied: 'Google sign-in was cancelled.',
	invalid_state: 'Login expired. Try again.',
	missing_code: 'Google did not return an authorization code.',
	oauth_failed: 'Google sign-in failed. Check OAuth settings and try again.',
};

export function LoginPage() {
	const [params] = useSearchParams();
	const message = useMemo(() => {
		const code = params.get('error');
		if (!code) return null;
		return ERRORS[code] ?? 'Sign-in failed.';
	}, [params]);

	const android = isAndroidClient();
	return (
		<main className="login">
			<section className="login-card">
				<p>
					{android
						? 'Sign in with Google. Inbox and watchlists stay in sync with the website under the same account.'
						: 'Sign in or create your account with Google. Your YouTube subscriptions stay on this personal dashboard.'}
				</p>
				{message ? <p className="login-error">{message}</p> : null}
				<h1 className="brand">{STREAMFEEDER_DISPLAY_NAME}</h1>
				<div className="login-actions">
					<a className="primary" href="/api/auth/google?intent=login">
						Sign in with Google
					</a>
					<a href="/api/auth/google?intent=signup">Create account with Google</a>
				</div>
			</section>
		</main>
	);
}
