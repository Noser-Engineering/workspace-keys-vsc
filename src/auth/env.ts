const ENV_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function containsEnvRef(raw: string): boolean {
	ENV_PATTERN.lastIndex = 0;
	return ENV_PATTERN.test(raw);
}

/** Names of every `${env:NAME}` reference, each reported once, without resolving any. */
export function envRefNames(raw: string): string[] {
	// `matchAll` starts at the shared pattern's `lastIndex`, which a preceding
	// `test()` leaves mid-string.
	ENV_PATTERN.lastIndex = 0;
	const names: string[] = [];
	for (const match of raw.matchAll(ENV_PATTERN)) {
		if (!names.includes(match[1])) {
			names.push(match[1]);
		}
	}
	return names;
}

/**
 * Substitutes every `${env:NAME}` reference from `env`.
 *
 * Unset variables are reported in `missing` and left un-substituted rather than
 * replaced with an empty string, so a half-resolved value is never mistaken for
 * a usable key.
 */
export function interpolateEnv(raw: string, env: Record<string, string | undefined>): { value: string; missing: string[] } {
	const missing: string[] = [];
	const value = raw.replace(ENV_PATTERN, (match, name: string) => {
		const resolved = env[name];
		if (resolved === undefined || resolved === '') {
			if (!missing.includes(name)) {
				missing.push(name);
			}
			return match;
		}
		return resolved;
	});
	return { value, missing };
}
