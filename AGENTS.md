# Agent guide

## Core Technical Mandates

- This is a VS Code extension (`workspace-keys`, display name "Workspace Keys (BYOK)") written in TypeScript 5.9 targeting ES2022/CommonJS; it requires VS Code `^1.106.0` and Node.js 22 in CI.
- TypeScript compilation is strict (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, and `noFallthroughCasesInSwitch`). Keep reusable logic `vscode`-free where existing tests do so; shared types in `src/types.ts` intentionally do not import `vscode`.
- Untrusted workspaces must contribute no models and make no network requests. Never bypass the existing origin/endpoint-consent or key-resolution checks.
- Security invariants that must not regress: `${env:…}` references in `apiKey` are resolved only for providers from user settings (`workspace-env-blocked` otherwise), and workspace-declared endpoints — loopback included — require approval (`src/security/approvalPolicy.ts`).
- Provider IDs are part of SecretStorage names and model IDs; changing an ID detaches stored keys. `workspaceKeys.modelRules`, `workspaceKeys.hideUnknownModels` and `workspaceKeys.allowInsecureLoopback` are application-scoped user settings and must not be made workspace-overridable.
- No endpoint ships with the extension: `workspaceKeys.providers` defaults to an empty list, endpoints are written to user settings only, and provider base URLs must be `https://` (loopback `http://` only via `workspaceKeys.allowInsecureLoopback`).

## Project Structure

- `src/extension.ts`: runtime activation, provider registration, refresh listeners, status bar, and commands.
- `src/provider/`: OpenAI-compatible model discovery, request construction, HTTP, streaming, and VS Code language-model provider implementation.
- `src/auth/`, `src/config/`, and `src/security/`: workspace-scoped key resolution, settings/model rules, endpoint consent, and plaintext-key handling.
- `src/types.ts`: shared `vscode`-free types; `src/test/`: compiled CommonJS tests using Node's built-in test runner and real-socket mock-provider coverage.
- `scripts/`: manual mock-provider and icon-generation scripts; `media/`: icon sources and generated PNG; `out/`: generated TypeScript output and source maps (ignored).
- `.vscode/`: launch/tasks configuration. `.github/workflows/`: CI and tagged-release workflows — GitHub is the only host. `README.md` contains the full user and manual-test flow.
- `workspaceKeys.providers` is an array: a workspace value replaces the whole user list rather than merging. Workspace `.vscode/settings.json` is git-ignored (never commit it) because it can contain keys and mock endpoints.

## Mandatory Workflows

- Install with `npm ci` when reproducing CI/lockfile state, or `npm install` for local setup.
- `npm run format` writes Prettier formatting; `npm run format:check` verifies it. Markdown is intentionally excluded from formatting.
- `npm run compile` performs strict TypeScript compilation and creates `out/`.
- `npm test` compiles first, then runs `node --test "out/test/*.test.js"`; focused test: `npm run compile` followed by `node --test out/test/<test-name>.test.js`.
- `npm run lint` runs type-aware ESLint; `npm run lint:fix` applies autofixes. Deliberately unawaited promises must be marked with `void`.
- `npm run hygiene` checks the naming and endpoint invariants of the published artifact (one settings prefix, vendor in step with the extension name, no shipped endpoint, only documentation or loopback hosts in shipped files).
- `npm run check` runs `format:check`, `lint`, `hygiene`, and `test` in that order. `npm run package` compiles, regenerates the icon, and builds the VSIX; use it when packaging/release behavior is touched.

## After Every Code Change

- Run `npm run format`, then `npm run lint`, `npm run compile`, and `npm test`; fix failures before considering the change complete. For a final gate, run `npm run format:check`, `npm run lint`, and `npm test` in that order.
- For host-level behavior, use the VS Code **Run Extension** launch configuration (`F5`); its prelaunch task compiles first. Copilot picker visibility also depends on the GitHub BYOK policy, so use the extension's **Send a test request** path to verify registration and streaming independently.
- Manual endpoint testing must use `npm run compile` followed by `node scripts/mock-provider.js <port> <modelId>`, then point a scratch workspace at the mock URL and enable `workspaceKeys.allowInsecureLoopback` in user settings. Never aim scratch settings at a production endpoint or commit `.vscode/settings.json`.
- `npm run icon` regenerates the shipped PNG from the SVG source; run it when icon sources change.

## Change Discipline

- Keep changes as small and focused as possible. Do not add speculative refactors, abstractions, or unrelated cleanup.
- Preserve existing naming, structure, module boundaries, and repository conventions.
- Add new runtime or development dependencies only after asking the user for approval. Prefer existing dependencies and platform APIs.
- Read the owning source file and relevant tests before editing. Add or update tests for behavior changes and bug fixes.
- Keep source code, identifiers, user-facing strings, and comments in English. Write comments only for short, non-obvious logic.
- Do not mix server-only and client-safe exports or cross the existing VS Code/runtime boundaries.
- Before finishing, review the diff for correctness, regressions, security, consistency, and test coverage.
