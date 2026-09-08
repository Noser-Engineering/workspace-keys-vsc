import * as vscode from 'vscode';
import type { ActiveScopeDescription } from './provider/chatProvider';

const PRODUCT = 'Workspace Keys';

/**
 * Makes the resolved scope visible.
 *
 * The label is the **provider's own title** rather than the extension name: with
 * the endpoint chosen by the user, "which endpoint is this window talking to"
 * is the question the status bar can answer in one word. In a multi-root
 * workspace the active folder decides which key and which models apply, and
 * that resolution is otherwise invisible — which turns a misconfigured folder
 * into a confusing "my models disappeared" report.
 *
 * Counts, the folder name and the reason live in the tooltip, which is where
 * someone looks once they have a question.
 */
export class ScopeStatusBar {
	private readonly item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem('workspaceKeys.scope', vscode.StatusBarAlignment.Right, 90);
		this.item.name = PRODUCT;
		this.item.command = 'workspaceKeys.manage';
	}

	update(description: ActiveScopeDescription): void {
		// Untrusted: nothing was read and nothing was sent, so there is nothing to
		// report and no action to offer.
		if (!description.trusted) {
			this.item.hide();
			return;
		}

		// No endpoint yet — the one state where the extension asks for something
		// before it can do anything at all.
		if (description.providerCount === 0) {
			this.item.text = '$(add) Add provider';
			this.item.tooltip =
				`${PRODUCT}: no provider endpoint is configured yet.\n\n` +
				'Click to add one. The endpoint is stored in your user settings and applies to every workspace; the API key is stored per workspace.';
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.item.show();
			return;
		}

		const title = description.activeProviderTitle ?? PRODUCT;
		const folderSuffix = description.folderName ? ` for folder "${description.folderName}"` : '';
		const others = description.providerCount > 1 ? `\n\n${description.providerCount} provider(s) configured in total.` : '';

		if (description.modelCount > 0) {
			this.item.text = `$(sparkle) ${title}`;
			this.item.tooltip = `${PRODUCT}: ${description.modelCount} model(s) from ${description.providerCount} provider(s)${folderSuffix}.${others}`;
			this.item.backgroundColor = undefined;
			this.item.show();
			return;
		}

		// Distinct from "no key": a key exists but was stored for an earlier folder
		// at this path, and needs a decision before it is used. Ranked above the
		// other states because it is the only one actively holding something back.
		if (description.withheld > 0) {
			this.item.text = `$(lock) ${title} · key withheld`;
			this.item.tooltip =
				`${PRODUCT}: ${description.withheld} stored key(s) were saved for an earlier folder at this path${folderSuffix}.\n\n` +
				`Open the model picker to confirm or replace them, or click to manage stored keys.${others}`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.item.show();
			return;
		}

		// Highlighted rather than quiet: once an endpoint is configured, a missing
		// key is the one thing standing between the workspace and working models,
		// so it should be impossible to overlook.
		if (description.needsKey === description.providerCount) {
			this.item.text = `$(key) ${title} · key needed`;
			this.item.tooltip =
				`${PRODUCT}: ${description.providerCount} provider(s) configured${folderSuffix}, but no API key for this workspace.\n\n` +
				`Click to set one — it is stored in SecretStorage for this workspace only.${others}`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.item.show();
			return;
		}

		if (description.needsApproval > 0) {
			this.item.text = `$(unverified) ${title} · approve endpoint`;
			this.item.tooltip =
				`${PRODUCT}: ${description.needsApproval} endpoint(s) awaiting approval${folderSuffix}.\n\n` +
				`A provider declared in workspace settings needs confirmation. Click and choose "Approve an endpoint".${others}`;
		} else {
			this.item.text = `$(warning) ${title} · no models`;
			this.item.tooltip =
				`${PRODUCT}: ${description.providerCount} provider(s) configured${folderSuffix}, but no models are offered.\n\n` +
				`Every discovered model was hidden by the model rules, or discovery failed. Click to open the log.${others}`;
		}
		this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		this.item.show();
	}

	dispose(): void {
		this.item.dispose();
	}
}
