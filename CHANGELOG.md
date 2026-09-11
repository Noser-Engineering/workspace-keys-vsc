# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [Unreleased]

## [0.1.2] - 2026-09-11

### Added

- On its first activation after installation, the extension sets the global
  `chat.byokUtilityModelDefault` setting to `mainAgent`. An existing global
  value is preserved.

## [0.1.1] - 2026-09-11

### Added

- OpenAI-compatible chat models contributed to VS Code, with the API key, base
  URL and model list scoped per workspace.
- Setup dialog for a provider endpoint, reached from the key command, the status
  bar and **Workspace Keys: Add Provider Endpoint**. It validates the URL,
  suggests an editable title derived from the host, derives the provider id from
  that title, and shows URL, title and id for confirmation before writing to
  your user settings.
- Three-tier key resolution: workspace-scoped SecretStorage, `${env:NAME}` in a
  user-declared provider entry, then a literal value. A stored key is withheld
  when the workspace path was recycled, and stored keys of deleted workspaces
  stay listable and removable.
- Capability rules by glob (`workspaceKeys.modelRules`) with built-in defaults
  for the common model families, and `workspaceKeys.hideUnknownModels` for
  everything unmatched.
- Streaming responses including fragmented tool calls, request-parameter
  defaults per workspace, a five-minute model-discovery cache, and a *Send a
  test request* self-test that works without Copilot Chat.

### Security

- No models and no network requests in untrusted workspaces.
- HTTPS is required for provider base URLs. Cleartext `http://` is accepted for
  loopback hosts only, and only with the user-scoped
  `workspaceKeys.allowInsecureLoopback` setting, which a workspace cannot
  enable.
- Endpoints declared by a workspace require approval; setting a key for one asks
  first, with the full URL shown, and stores nothing if declined.
- `${env:…}` references are resolved only for providers from user settings, so a
  cloned repository cannot have an environment variable sent as a bearer token.
- Reserved headers in a provider's `headers` are ignored, so a configuration
  cannot override authentication, routing or framing.
- API keys are scrubbed from logged and surfaced text, header values are
  redacted unless the header name is known to be uninteresting, and provider
  error bodies are truncated.
- No telemetry.
