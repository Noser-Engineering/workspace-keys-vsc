/**
 * Turns a base URL into the two fields a new provider entry needs: the title
 * shown in the UI and the identifier the SecretStorage name is built from.
 *
 * Both are only suggestions — the title is editable and purely cosmetic, and
 * the identifier is derived from whatever title the user settles on. Keeping the
 * derivation here, free of `vscode`, is what makes it testable.
 */

/** Provider ids become part of a SecretStorage key, so the character set is restricted. */
const ID_ALLOWED = /[^A-Za-z0-9._-]+/g;

const MAX_TITLE_LENGTH = 60;

/**
 * Second-level suffixes that would otherwise be mistaken for the main domain.
 * Deliberately a short list rather than a public-suffix dependency: the result
 * is a suggestion the user can overwrite, so an occasional miss costs nothing.
 */
const TWO_PART_SUFFIXES = new Set([
	'co.uk',
	'org.uk',
	'ac.uk',
	'gov.uk',
	'co.jp',
	'or.jp',
	'com.au',
	'net.au',
	'org.au',
	'co.nz',
	'com.br',
	'com.cn',
	'co.in',
	'co.kr',
	'co.za',
	'com.tr',
	'com.mx',
]);

/**
 * Suggests a display title from the host of `baseUrl`: the main domain with its
 * first letter capitalised, so `https://models.example.com/v1` becomes
 * `Example`. Loopback and literal IP hosts keep their port, because that is the
 * only thing telling two local mock providers apart.
 */
export function suggestProviderTitle(baseUrl: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return 'Provider';
	}

	const hostname = url.hostname.toLowerCase();
	const port = url.port;

	if (isLiteralHost(hostname)) {
		const host = hostname.replace(/^\[|\]$/g, '');
		return capitalise(port ? `${host}:${port}` : host);
	}

	const labels = hostname.split('.').filter((label) => label.length > 0);
	if (labels.length === 0) {
		return 'Provider';
	}
	if (labels.length === 1) {
		return capitalise(port ? `${labels[0]}:${port}` : labels[0]);
	}

	const lastTwo = labels.slice(-2).join('.');
	const main = TWO_PART_SUFFIXES.has(lastTwo) && labels.length >= 3 ? labels[labels.length - 3] : labels[labels.length - 2];
	return capitalise(main) || 'Provider';
}

/** Strips what must not reach a label or a tooltip, and caps the length. */
export function sanitizeProviderTitle(raw: string): string {
	// Control characters are exactly what has to go here.
	const withoutControls = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ');
	return withoutControls.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

/**
 * Derives an identifier from a title, reduced to the characters a SecretStorage
 * name may contain. A collision with an existing id is suffixed rather than
 * merged: two entries sharing an id would share a stored key.
 */
export function deriveProviderId(title: string, taken: readonly string[] = []): string {
	const base = sanitizeProviderTitle(title)
		.replace(ID_ALLOWED, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[-._]+|[-._]+$/g, '');
	const candidate = base.length > 0 ? base : 'provider';

	if (!taken.includes(candidate)) {
		return candidate;
	}
	for (let suffix = 2; ; suffix += 1) {
		const next = `${candidate}-${suffix}`;
		if (!taken.includes(next)) {
			return next;
		}
	}
}

function isLiteralHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function capitalise(value: string): string {
	return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}
