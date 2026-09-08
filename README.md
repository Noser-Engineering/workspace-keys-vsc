# Workspace Keys (BYOK)

Bring your own OpenAI-compatible chat models to VS Code, with the **API key,
base URL and model list scoped per workspace**.

VS Code offers no ready-made way to do this: credentials either live in
SecretStorage, which is machine-wide, or in `machine`-scoped settings, which a
workspace cannot override. This extension resolves both from a workspace-aware
source instead, so one window can talk to one endpoint with one key while
another window uses a different endpoint entirely.

This is an independent extension. It is not affiliated with, endorsed by or
supported by GitHub or Microsoft.

## Requirements

- VS Code 1.106 or newer.
- An OpenAI-compatible endpoint over HTTPS, and an API key for it.
- To use the models **inside GitHub Copilot Chat**, the Copilot BYOK policy must
  be enabled for your account or organisation — see
  [Known constraint](#known-constraint). The extension's own *Send a test
  request* works without Copilot.

## Quickstart

1. Install the extension and open a project folder.
2. Run **Workspace Keys: Set or Update API Key for Current Workspace** from the
   Command Palette, or click the status bar item.
3. On a fresh installation you are asked for the **endpoint** first: enter the
   base URL of an OpenAI-compatible API, for example
   `https://api.example.com/v1`. A title is suggested from the host and can be
   overwritten; it is what the status bar and the model picker show.
   The endpoint is written to your **user settings**, so every workspace
   inherits it.
4. Enter the **API key**. It goes into SecretStorage for this workspace only and
   is never written to a settings file.
5. The status bar shows the endpoint title once models are available. Open the
   model picker in Copilot Chat, or use *Send a test request* behind the status
   bar item to verify the extension on its own.

Repeat step 2 in every project that needs its own key. Adding a second endpoint
later: **Workspace Keys: Add Provider Endpoint**.

## How a key is resolved

First hit wins, per provider:

| # | Source | Notes |
|---|---|---|
| 1 | Workspace-scoped SecretStorage | **Preferred.** Set via *Workspace Keys: Set or Update API Key for Current Workspace*. Never written to settings. |
| 2 | `"apiKey": "${env:NAME}"` | Portable across machines; the settings file holds only the reference. Honoured only for providers declared in **user settings** — a reference in a workspace's `.vscode/settings.json` is ignored with a log warning, since a cloned repository must not be able to read your environment. |
| 3 | Literal `"apiKey": "sk-…"` | Works. When it sits in workspace settings, a warning offers to move the value into SecretStorage. |

The SecretStorage entry is named `workspace-keys:<providerId>:<hash>`, where the
hash is the first 16 hex characters of the SHA-256 of the workspace URI — the
`.code-workspace` file if there is one and the root folder otherwise. Because
SecretStorage is bound to the local VS Code profile rather than to the
workspace, tier 1 does not travel to another machine — that is what tier 2 is
for.

### What happens to a key when its workspace is gone

Deleting a project folder does not delete its key: the entry lives in the VS Code
profile, not in the workspace. Two consequences follow from the name being a hash
of the path, and both are handled explicitly.

**A recycled path cannot inherit a key.** Creating a new project at a path an old
one used to occupy produces the same hash, so the new project would otherwise be
handed the old key without a word. Each stored key therefore also records the
creation time of the folder (or `.code-workspace` file) it was stored for. When
that no longer matches, the key is withheld — not deleted — and you are asked
once whether it applies here: *Use It Anyway*, *Delete Key* or *Set New Key*. The
status bar shows `key withheld` until you decide.

The check only ever fires when both creation times are known. A remote scheme, an
unplugged drive or a filesystem without birthtime reads as "no opinion" and
leaves the key working, because an offline share and a deleted folder are
indistinguishable from the outside — and deleting a key on that guess is not
reversible.

**Orphaned keys stay reachable.** `SecretStorage` cannot enumerate itself, so a
key whose workspace is gone would otherwise be impossible to name, let alone
remove. An index in `globalState` records one entry per stored key — provider,
the last two path segments, and the dates — which is what **Workspace Keys:
Manage Stored API Keys** lists. Deletion there is explicit and confirmed; nothing
is ever cleaned up automatically. Note that deleting a key locally does not
revoke it at the provider — for that, rotate it there.

The index is not registered for Settings Sync: it describes secrets of this
machine, and syncing it would let one machine offer to delete keys another one
holds. It stores only the last two path segments rather than full paths, since
`globalState` is not encrypted.

## Endpoints

The intended split is **endpoint once, key per project**. An endpoint is a fact
about your machine; the key is a fact about the project.

Nothing ships preconfigured: the extension contributes no endpoint of its own,
so the first one always comes from you.

```jsonc
// user settings.json
"workspaceKeys.providers": [
  { "id": "Example", "label": "Example", "baseUrl": "https://api.example.com/v1" }
]
```

Two things to know about that list:

- `id` forms the SecretStorage key and prefixes the model id, so renaming it
  detaches any stored key. `label` is the title shown in the UI and is purely
  cosmetic — change it whenever you like.
- VS Code replaces array settings rather than merging them. A workspace can
  therefore override the whole list from its `.vscode/settings.json`, which also
  means your user-level entries are gone for that folder. Add that file to
  `.gitignore` if you ever put a literal key in it.

Two optional fields beyond `apiKey`: `models` is an explicit model allowlist
that skips `/models` discovery entirely, and `headers` adds HTTP headers to
every request to that provider. Headers that decide authentication, routing or
framing (`Authorization`, `Cookie`, `Host`, `Content-Type`, `Accept`, …) are
ignored — a configuration must not be able to replace the resolved key or send
the request somewhere else. Discovered model lists are cached for five minutes;
*Refresh model list* behind the status bar item forces it.

## Commands

Four in the Command Palette, because they are the only ones with a decision
behind them:

| Command | Purpose |
|---|---|
| **Workspace Keys: Set or Update API Key for Current Workspace** | Store this project's key in SecretStorage, and set up the first endpoint if there is none |
| **Workspace Keys: Add Provider Endpoint** | Add an endpoint to your user settings |
| **Workspace Keys: Edit Providers in User Settings** | Open the raw list for larger edits |
| **Workspace Keys: Manage Stored API Keys** | List and delete stored keys, including those of workspaces that no longer exist |

Everything else — test request, log, refresh, model rules, clearing a single key,
approved endpoints — lives behind the status bar item and the model picker's
*Manage* button, since it is diagnostic rather than routine.

## Settings

| Setting | Scope | Purpose |
|---|---|---|
| `workspaceKeys.providers` | `resource` | Endpoint definitions. Normally set once in user settings; overridable per workspace. |
| `workspaceKeys.requestDefaults` | `resource` | `temperature`, `top_p`, `max_tokens`, … passed through per request. |
| `workspaceKeys.multiRootResolution` | `window` | `activeEditor` (default) or `firstFolder`. |
| `workspaceKeys.modelRules` | `application` | Capability rules by glob. **User settings only.** |
| `workspaceKeys.hideUnknownModels` | `application` | Hide models no rule matches. Default `true`. |
| `workspaceKeys.allowInsecureLoopback` | `application` | Development only: allow cleartext `http://` on loopback. Default `false`. **User settings only.** |

### Why capabilities are separate from providers

A provider says *where to send a request and with what key*. A model rule says
*what a model can do* — a property of the model, not of the endpoint. The same
`gpt-4.1-mini` behind the same gateway has the same capabilities in every
project, so folding the two together would mean repeating them.

The scope is the stronger reason. `modelRules` is `application`-scoped, the one
scope a workspace **cannot** override. If capabilities lived inside the provider
entry, a cloned repository could declare `toolCalling: true` for a model in its
`.vscode/settings.json` and push itself into agent mode, where tools write files
and run terminals. Workspace Trust already gates that; this is the second layer.

Once providers live in user settings, both end up in the same file anyway.

An OpenAI-compatible `/models` endpoint reports ids but no capabilities, so
capabilities come from glob rules. Built-in defaults cover the common families;
user rules are applied afterwards and win:

```jsonc
"workspaceKeys.modelRules": [
  { "match": "our-*", "toolCalling": true, "imageInput": false, "maxInputTokens": 32000 }
]
```

Within one rule list, broader patterns must come before narrower ones — all
matching rules are merged in order. `toolCalling` also accepts a number, which
sets the maximum number of tools per request.

### Request parameters

`modelOptions` supplied by the calling extension is **filtered to known OpenAI
parameters** before it goes on the wire. Copilot Chat injects private fields
(`_otelTraceContext`, `_enableThinking`, `_telemetryTurnNo`,
`_capturingTokenCorrelationId`), and Azure rejects the entire request with
*"Unrecognized request arguments supplied"* when they reach it.

`workspaceKeys.requestDefaults` is **not** filtered. It is authored by you for
your own endpoint and is therefore the escape hatch for anything the allowlist
does not cover:

```jsonc
"workspaceKeys.requestDefaults": {
  "temperature": 0.2,
  "reasoning_effort": "medium"
}
```

## Security

- **Untrusted workspaces** contribute no models: no workspace settings are read
  and no requests are made. Without that, a cloned repository could point
  `baseUrl` at an endpoint of its choosing and receive your prompts.
- **HTTPS only.** A cleartext endpoint would put the bearer token and the whole
  prompt on the wire in the open. `http://` is accepted for loopback hosts only,
  and only with the user-scoped `workspaceKeys.allowInsecureLoopback` setting —
  a workspace cannot enable it.
- **Endpoint approval** is automatic for endpoints you declared yourself, in your
  own user settings or through the setup dialog, which shows the URL before
  anything is sent — you typed it, that is the consent. Confirmation is required
  for every endpoint a workspace's `.vscode/settings.json` declares, loopback
  included: `127.0.0.1` is where a malicious local process would listen. Setting
  a key for such an endpoint asks first, with the full URL shown, and stores
  nothing if you decline.
- **`${env:…}` references are resolved only for providers in user settings.** A
  workspace-declared provider cannot name an environment variable and have it
  sent as a bearer token — otherwise any cloned repository could exfiltrate
  `GITHUB_TOKEN` or worse to an endpoint of its choosing.
- **Configured headers cannot override authentication or routing.** They are
  applied before the credential and the protocol headers, and reserved names are
  dropped.
- **Keys are never logged.** Header values are redacted unless the header is
  known to be uninteresting, any key value is scrubbed from error bodies, and
  provider error bodies are truncated before they are logged or surfaced.

### Data and privacy

This extension has no backend of its own, collects **no telemetry** and sends no
usage data, crash reports or analytics to anyone.

Requests go to the base URL of the provider you configured, and only to it:
`GET {baseUrl}/models` for discovery (skipped when the entry lists `models`
explicitly), and `POST {baseUrl}/chat/completions` carrying your API key and
whatever the calling extension built — the prompt, prior turns, any attachments
or file context it included, tool definitions and results, the model id, and the
request parameters. What the endpoint operator does with that is governed by
their terms, not by this extension. No request is made in an untrusted
workspace, and none to an unapproved endpoint.

Stored on your machine:

| Data | Where | Notes |
|---|---|---|
| API keys | SecretStorage (OS keychain) | One entry per provider and workspace. Never written to a settings file, not synced. |
| Index of stored keys | `globalState` | Provider id, workspace hash, the **last two path segments** of the path, timestamps. Not encrypted, not synced. |
| Approved endpoint origins | `globalState` | Origins you confirmed for workspace-declared endpoints. Not encrypted. |
| Endpoint configuration | Your settings | User settings, or `.vscode/settings.json` if a workspace overrides the list. |

Endpoint titles and URLs in user settings are covered by VS Code Settings Sync
if you have it enabled, like any other setting. API keys are not — SecretStorage
is local to the machine and profile. A literal key in `apiKey` is stored in plain
text in the settings file; the extension warns about that in workspace settings
and offers to move it into SecretStorage.

The **Workspace Keys** output channel records configuration problems, discovery
results and request failures. Prompts and responses are not logged, keys are
scrubbed and header values redacted — but the log does contain endpoint URLs and
provider and model ids, so read it before sharing it.

To remove everything: **Workspace Keys: Manage Stored API Keys** → select all →
delete (this does not revoke the keys at the provider — rotate them there),
remove `workspaceKeys.*` from your settings, then uninstall; VS Code discards the
extension's `globalState` with it.

### Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository: *Security* → *Report a vulnerability*. Include the extension,
VS Code and OS versions, what an attacker gains and what they need to start
with, and the smallest reproduction you have. **Never include real API keys,
real endpoint URLs or real prompt content** — redact them, the reproduction is
what matters.

In scope is anything that lets code or configuration outside your control reach
your credentials or your prompts: a key being logged, written to a settings file
or sent to the wrong endpoint; a workspace or cloned repository obtaining a key,
reading environment variables or getting a request sent without endpoint
approval; any network request in an untrusted workspace; a configured header
overriding authentication or routing; cleartext transport without the explicit
user-scoped development setting; a model being offered a capability it was not
granted, tool calling above all.

Out of scope: the security and data handling of the endpoint *you* configure,
the GitHub Copilot BYOK policy and Copilot Chat itself, storing a literal key in
a settings file after the extension warned about it, and anything requiring an
attacker who already controls your VS Code profile or OS keychain.

Only the latest published version receives security fixes.

## Development

```bash
npm install
npm test            # compiles first, no VS Code download required
npm run check       # what CI runs: format:check, lint, hygiene, test
npm run lint:fix    # ESLint autofix
npm run format      # Prettier write
npm run hygiene     # naming and endpoint invariants of the published artifact
```

Prettier owns formatting; ESLint is type-aware and carries only rules that types
make possible — `no-floating-promises` above all, since notifications here are
deliberately fired without `await` and marked with `void`. Markdown is not
formatted: Prettier pads every table cell, which turns a one-word edit into a
full-table diff.

### CI and releases

`.github/workflows/ci.yml` runs on every push and pull request: format, lint,
release hygiene, tests, and a VSIX build kept as an artifact for 14 days, so a
branch can be tried out without cutting a release.

`.github/workflows/release.yml` publishes a GitHub release when a `v*` tag is
pushed, with the VSIX attached and install instructions in the notes:

```bash
npm version patch        # bumps package.json and creates the tag
git push --follow-tags
```

The workflow refuses to release if the tag and `package.json` version disagree —
a pushed tag cannot be corrected without deleting the release it produced.

GitHub is the only host for this project; there is no second CI configuration to
keep in step.

## Testing it by hand

The automated tests cover the wire format, the rules engine, URL and header
validation, redaction and key resolution. What they cannot cover is VS Code
itself — registration, the picker, and the per-window isolation the whole design
rests on. That needs real windows.

### 1. Start a mock provider

```bash
npm run compile
node scripts/mock-provider.js 8787 gpt-4o-mini
```

It accepts any bearer token and answers `/models` plus a streamed
`/chat/completions` with a fragmented tool call.

### 2. Allow cleartext loopback

A mock speaks `http://`, which is rejected by default. In your **user** settings:

```jsonc
{ "workspaceKeys.allowInsecureLoopback": true }
```

### 3. Launch the host and point a folder at the mock

<kbd>F5</kbd> on **Run Extension**. The new window opens without a folder, so no
provider resolves yet — open any scratch folder in it and give it this
`.vscode/settings.json`:

```jsonc
{
  "workspaceKeys.providers": [
    { "id": "mock-a", "label": "Mock A", "baseUrl": "http://127.0.0.1:8787/v1" }
  ]
}
```

Because the provider comes from workspace settings, it needs approval: the key
dialog asks first and shows the full URL, and the model picker asks during
discovery. In normal operation — an endpoint you added yourself — neither prompt
appears; seeing it here confirms the consent gate is working.

### 4. Give it a key

<kbd>Ctrl+Shift+P</kbd> → **Workspace Keys: Set or Update API Key for Current
Workspace**. Type anything; the mock accepts it.

### 5. Check the status bar

The status bar should now show `✨ Mock A`, and its tooltip should name one model
from one provider. That single indicator already proves configuration reading,
key resolution, endpoint consent and model discovery all work. If it stays hidden
or shows `no models`, hover it — the tooltip names the likely cause — then click
it and choose *Show log*.

### 6. Send a real request

Click the status bar item and choose *Send a test request*.

This goes through `vscode.lm` end to end — registration, model selection,
streaming — and reports the answer and the round-trip time. It deliberately does
not depend on Copilot Chat being installed or on the BYOK policy being enabled,
so it is the fastest way to tell whether the extension itself works.

### 7. Check it in Copilot Chat

Open Copilot Chat and expand the model picker. The model appears as
`gpt-4o-mini` with `Mock A` next to it. Agent mode only offers models whose
rules set `toolCalling`.

If the model is missing here but step 6 succeeded, the extension is fine and the
cause is the BYOK policy — see [Known constraint](#known-constraint).

### 8. The workspace-scoping property

This is the point of the extension, so it is worth checking explicitly. Start a
second mock and prepare a second folder:

```bash
node scripts/mock-provider.js 8788 claude-sonnet-4    # second terminal
```

This provider goes into your **user** `settings.json` (temporarily), not into
the folder — `${env:…}` references are only honoured there:

```jsonc
"workspaceKeys.providers": [
  {
    "id": "mock-b",
    "label": "Mock B",
    "baseUrl": "http://127.0.0.1:8788/v1",
    "apiKey": "${env:MOCK_B_KEY}"
  }
]
```

Launch a second host window on a folder *without* a `.vscode/settings.json`
override, with `MOCK_B_KEY` set in the environment — this one resolves its key
from tier 2 rather than SecretStorage, and needs no endpoint approval because
you declared it yourself. With both windows open, each must offer only its own
model, and setting or clearing a key in one must not affect the other. Remove
the entry from your user settings afterwards.

### 9. The security behaviour

| Action | Expected |
|---|---|
| Clear the key | Model disappears within ~250 ms, no window reload |
| Fresh profile, run the key command | Endpoint is asked for first, then the key; the endpoint lands in user settings |
| Enter `http://api.example.com/v1` in the setup dialog | Rejected in place, with the reason |
| Enter `https://user:pass@api.example.com/v1` | Rejected: credentials do not belong in the URL |
| Set a key for a workspace-declared endpoint and decline the trust prompt | No key is stored, no request is made |
| Change `baseUrl` in `.vscode/settings.json` | Approval prompt for the new origin, loopback included |
| Reopen the folder and answer "No, I don't trust" | No models, no network traffic |
| Put a literal `"apiKey": "sk-x"` in workspace settings | Plain-text warning offering to move it into SecretStorage |
| Put `"apiKey": "${env:PATH}"` in workspace settings | No request; log warning naming the variable; status bar `key needed` |
| Add `"headers": { "Authorization": "Bearer x" }` | Header ignored, one warning in the log, request still uses the resolved key |
| Delete the scratch folder, recreate it under the same path, reopen it | `key withheld` in the status bar; the picker asks once whether the old key still applies |
| Run **Workspace Keys: Manage Stored API Keys** | Both scratch workspaces listed by their last two path segments, deletable with a confirmation |

## Known constraint

Models contributed through the `LanguageModelChatProvider` API depend on the
GitHub Copilot BYOK policy. On Business and Enterprise plans an administrator
must enable **Bring Your Own Language Model Key in VS Code**; until then the
models will not appear in the Copilot Chat picker regardless of configuration.
*Send a test request* is unaffected.

## Support

Bugs and questions: use the issue tracker of this repository. Suspected
vulnerabilities: see [Reporting a vulnerability](#reporting-a-vulnerability) —
private reporting, not a public issue.

## License

MIT — see the [LICENSE](LICENSE) file.

## Attribution

Built directly on the stable `vscode.lm.registerLanguageModelChatProvider` API.
`huggingface/huggingface-vscode-chat`, `JohnnyZ93/oai-compatible-copilot` and
`keklick1337/custom-copilot` (all MIT) were consulted as references; no code was
copied from them.
