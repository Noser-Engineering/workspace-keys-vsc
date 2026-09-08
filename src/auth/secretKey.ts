import { createHash } from 'node:crypto';

export const SECRET_PREFIX = 'workspace-keys';

/**
 * Derives the workspace-identifying component of a secret name.
 *
 * The input is the `.code-workspace` file URI when there is one, otherwise the
 * single root folder URI — so a multi-root workspace shares one key across its
 * roots, while a plain folder gets its own.
 */
export function workspaceHash(workspaceKey: string): string {
	return createHash('sha256').update(workspaceKey).digest('hex').slice(0, 16);
}

/** SecretStorage key: `workspace-keys:<providerId>:<workspaceHash>`. */
export function secretName(providerId: string, hash: string): string {
	return `${SECRET_PREFIX}:${providerId}:${hash}`;
}

/** Used to filter `SecretStorage.onDidChange`, which also fires for other keys. */
export function isOwnSecret(name: string): boolean {
	return name.startsWith(`${SECRET_PREFIX}:`);
}
