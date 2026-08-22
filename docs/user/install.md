# Install T3 Code

T3 Code is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the T3 Code server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

## Providers

T3 Code drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                    | Default binary | Log in with           |
| ---------- | ------------------------------------------------------ | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)   | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code)  | `claude`       | `claude auth login`   |
| Cline      | [Cline CLI](https://docs.cline.bot/usage/cli-overview) | `cline`        | `cline auth`          |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                   | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                     | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                        | `opencode`     | `opencode auth login` |

Codex, Claude, and Cursor are on by default. Grok Build, OpenCode, and Cline are off by default;
turn them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Cline reuses credentials saved by `cline auth`. T3 Code does not launch Cline's interactive ACP
sign-in flow, so authenticate it on the server machine before enabling it.

Image attachments are currently unavailable with Cline. T3 Code rejects Cline turns that contain
images because the current Cline CLI drops image input over ACP instead of sending it to the model.

T3 Code's agent browser and preview tools are also unavailable in Cline sessions. Current Cline ACP
does not consume per-session MCP servers, so T3 Code withholds the otherwise unused MCP credential.

Cline is not used for T3 Code's background title, branch, commit, or pull-request text generation.
Current Cline ACP loads workspace and account extensions, including executable lifecycle hooks, and
does not expose a way for T3 Code to disable them for non-interactive metadata generation.

Cline sessions currently require **Full access**. Supervised and auto-accept modes cannot cover
extensions that run outside ACP tool-permission requests, so T3 Code rejects those modes before it
starts Cline. Plan mode is not advertised for the same reason.

Run the login command on the machine running the T3 Code server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
T3 Code. You can install T3 Code, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping T3 Code in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
