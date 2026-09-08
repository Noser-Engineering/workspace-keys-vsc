import { stat } from 'node:fs/promises';

/** The parts of a `vscode.Uri` an identity check needs. */
export interface IdentitySource {
	scheme: string;
	fsPath: string;
}

/**
 * Creation time of the folder or `.code-workspace` file a workspace identity is
 * derived from.
 *
 * This is what tells "the same project" apart from "a different project at the
 * same path": a SecretStorage name is a hash of the path alone, so without it a
 * recreated folder would inherit whatever key the previous one had.
 *
 * Undefined whenever that cannot be established — a non-local scheme, an
 * unreachable drive, a filesystem that reports no birthtime. Callers must read
 * undefined as "no opinion" and keep the key usable: guessing "recycled" for a
 * share that is merely offline would withhold keys that are perfectly valid.
 */
export async function birthtimeOf(source: IdentitySource | undefined): Promise<number | undefined> {
	if (!source || source.scheme !== 'file' || !source.fsPath) {
		return undefined;
	}
	try {
		const stats = await stat(source.fsPath);
		const birthtime = Math.round(stats.birthtimeMs);
		// ext4 and some network filesystems report 0 rather than admitting they
		// have no birthtime; treat that as unknown instead of as an epoch date.
		return Number.isFinite(birthtime) && birthtime > 0 ? birthtime : undefined;
	} catch {
		return undefined;
	}
}
