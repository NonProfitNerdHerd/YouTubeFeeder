export function isAndroidClient(): boolean {
	if (typeof window === 'undefined') return false;
	const params = new URLSearchParams(window.location.search);
	if (params.get('source') === 'android') return true;
	const standalone = window.matchMedia('(display-mode: standalone)').matches;
	return standalone && /Android/i.test(navigator.userAgent);
}

export function isNarrowFeeder(): boolean {
	if (typeof window === 'undefined') return false;
	return window.matchMedia('(max-width: 860px)').matches;
}
