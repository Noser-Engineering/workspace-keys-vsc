/**
 * Model ids must be unique across all providers of the vendor, so the provider
 * id is prefixed. Provider ids are validated to contain no `/`, which makes the
 * first `/` an unambiguous separator even though model ids frequently contain
 * further slashes (`meta-llama/Llama-3-8B`).
 */

export function composeModelId(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

export function splitModelId(composed: string): { providerId: string; modelId: string } | undefined {
	const separator = composed.indexOf('/');
	if (separator <= 0 || separator === composed.length - 1) {
		return undefined;
	}
	return {
		providerId: composed.slice(0, separator),
		modelId: composed.slice(separator + 1),
	};
}
