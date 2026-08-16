export interface AssetLinkFingerprint {
	label: string;
	sha256: string;
}

export function normalizeSha256Fingerprint(value: string): string | null {
	const hex = value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
	if (hex.length !== 64) return null;
	return hex.match(/../g)?.join(':') ?? null;
}

export function digitalAssetLinks(packageName: string, fingerprints: AssetLinkFingerprint[]) {
	const sha256_cert_fingerprints = fingerprints
		.map((f) => normalizeSha256Fingerprint(f.sha256))
		.filter((v): v is string => Boolean(v));
	if (!sha256_cert_fingerprints.length) return [];
	return [
		{
			relation: ['delegate_permission/common.handle_all_urls'],
			target: {
				namespace: 'android_app',
				package_name: packageName,
				sha256_cert_fingerprints,
			},
		},
	];
}
