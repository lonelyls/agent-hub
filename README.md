# Agent Hub

A small, self-hosted service for real remote agent terminals. Wrap a shell or agent CLI on a node, sign in to the web UI, and interact with that exact terminal. ANSI colors, interactive prompts, Ctrl+C, full-screen terminal applications, and terminal resizing pass through a native pseudo-terminal (PTY), not a redirected stdout mock.

**Stack:** TypeScript, Node.js, Express, WebSockets, node-pty, React, Vite, and xterm.js.

## Project documentation

- [Architecture](ARCHITECTURE.md): component boundaries, terminal and token-renewal flows, security, persistence, and deployment tradeoffs.
- [AI coding-agent guide](AGENTS.md): repository navigation, commands, validation, and implementation invariants.
- [Standalone agent guide](agent/README.md): portable client installation, packaging, and usage.
- [Unraid deployment](deploy/UNRAID.md): Docker build, persistent appdata, and deployment to `192.168.68.155:3080`.

## Docker

The multi-stage `Dockerfile` builds only the hub service and web UI; native PTY clients remain on agent nodes. The runtime uses the non-root `node` user and includes an HTTP health check. `.dockerignore` allowlists application build inputs so local accounts, environment files, dependencies, and Git history are not sent to the builder.

For local Docker with Compose:

```text
docker compose build
docker compose run --rm hub node dist/server/users-cli.js alice
docker compose up -d
```

Open **http://localhost:3080**. The local Compose configuration binds only loopback and persists users in a Docker-managed volume. For Unraid, use the [dedicated guide](deploy/UNRAID.md) and the standalone `compose.unraid.yaml`, or its Docker CLI instructions if Compose is unavailable. The Unraid configuration uses `/mnt/user/appdata/agent-hub/data` and the trusted-LAN origin `http://192.168.68.155:3080`. Account data must be writable by container UID/GID 1000; no default users are created.

## Quick start on this Windows machine

The project is at `D:\Repos\agent-hub`. A checksum-verified Node.js 24 LTS runtime is already installed in `.tools` because Node.js was not on this machine's PATH. Activate it separately in each PowerShell terminal:

```powershell
Set-Location D:\Repos\agent-hub
. .\scripts\Use-LocalNode.ps1
```

Dependencies and the production build are already present. Create your account, entering a password of at least 12 characters at the hidden prompt, then start the server:

```powershell
npm.cmd run user:add -- alice
npm.cmd start
```

Open **http://127.0.0.1:3000** and sign in as `alice`. There are no default accounts or passwords.

In another PowerShell terminal:

```powershell
Set-Location D:\Repos\agent-hub
. .\scripts\Use-LocalNode.ps1
npm.cmd run agent -- --server http://127.0.0.1:3000 --user alice --name windows-agent -- powershell.exe -NoLogo
```

Enter the same password at the hidden prompt. A terminal appears automatically in the browser. Type in either the original terminal or the browser; both operate the same child process. Replace `powershell.exe -NoLogo` with your preferred agent executable and its arguments:

```powershell
npm.cmd run agent -- --user alice --name coding-agent -- copilot
npm.cmd run agent -- --user alice --name command-prompt -- cmd.exe
```

Use `--` before the child executable so its options are passed to it rather than parsed as hub options. To run a `.cmd` or `.bat` program, invoke `cmd.exe /c program.cmd ...`; node-pty needs an executable, not a batch file. If no child command is given, the wrapper starts the platform's default shell.

Exiting the child ends that session and propagates its exit code to the wrapper. Closing the browser only detaches the viewer. Stopping the wrapper stops its child; this is not an operating-system session daemon and it does not attach to already-running terminals.

## Fresh installation / other agent nodes

Requirements:

- Node.js **22.12+** or **24 LTS** and npm.
- Windows 10 build 18309+ / Windows 11 (ConPTY), or Linux/macOS with a native PTY.
- A modern browser. Chrome is used by the automated browser test.

The agent is now an **independent project in `agent`**, with its own package manifest, lockfile, source, and build. Agent nodes do not need the server or web UI code.

On this hub host, build the portable agent package:

```text
npm run pack:agent
```

Copy the resulting **`agent-hub-agent-1.0.0.tgz`** to the agent node, then install and run it:

```powershell
npm.cmd install --global --allow-scripts=node-pty .\agent-hub-agent-1.0.0.tgz
agent-hub.cmd --server https://hub.example.com --user alice --name windows-agent -- powershell.exe -NoLogo
```

On Linux/macOS use `npm` and `agent-hub` without the `.cmd` suffix. Node.js is still required; the tarball contains compiled JavaScript and declares the two runtime dependencies (`node-pty`, `ws`), which npm installs for the target machine. It includes no server, web UI, credentials, or platform-specific `node_modules`.

Alternatively, copy only the `agent` source directory anywhere, run `npm ci` and `npm run build` inside it, then use `npm start -- --server ... --user ... -- your-agent-command`. It builds without files from the parent project. See [`agent\README.md`](agent/README.md) for standalone installation, packaging, options, and native build requirements.

Only the hub host needs `user:add` and `start`. The wrapper prompts for the account password on each launch. Each invocation registers a separate terminal. Existing `npm run agent -- ...` commands from the hub root remain supported.

For a fresh Windows machine without Node.js, the optional installer downloads the official Node.js 24 LTS Windows archive, checks its SHA-256 against the official checksums, and extracts it to this project's `.tools` directory. It does not modify system PATH:

```powershell
.\scripts\Install-LocalNode.ps1
. .\scripts\Use-LocalNode.ps1
npm.cmd ci
npm.cmd run install:agent
npm.cmd run build
```

On Linux/macOS:

```sh
npm ci
npm run install:agent
npm run build
npm run user:add -- alice
npm start
```

For a node with the portable agent package installed:

```sh
agent-hub --server http://127.0.0.1:3000 --user alice --name linux-agent -- /bin/bash
```

The hub and agent have separate `package-lock.json` files. `npm run install:agent` installs the agent's dependencies separately; root `npm ci` no longer installs native PTY dependencies. On a server-only installation, `npm run build:server` and `npm run build:web` build just the service and UI without installing the agent's native dependencies. The default `npm run build` builds all three components. Native agent installation requirements are documented in its README.

## Authentication and user management

Run these on the hub host, using the same `HUB_DATA_DIR` as the service:

```text
npm run user:add -- alice
npm run user:add -- alice --reset
```

Usernames are case-sensitive, 3-64 characters, starting with a letter or number; subsequent characters may also include `.`, `_`, and `-`. Passwords must be at least 12 characters, at most 1024 UTF-8 bytes. User records are persisted to `data\users.json` using salted **scrypt** (N=32768, r=8, p=1, 64-byte derived key), timing-safe verification, and atomic file replacement. Passwords are never stored in plaintext.

New users and password changes are read on subsequent login. **Restart the hub after a password reset to invalidate already-issued browser and agent sessions.** There is intentionally no unauthenticated signup API or default administrator.

Browser authentication uses an opaque, HttpOnly, SameSite=Strict cookie (also Secure when `HUB_PUBLIC_URL` is HTTPS). CLI login gets a separate agent-only bearer token, passed in the WebSocket Authorization header, not a URL. Both expire after 12 hours. The CLI proactively obtains a replacement one minute before expiry (at 80% of the remaining lifetime for short-lived tokens) and authenticates it on its existing WebSocket without interrupting the PTY. The hub accepts only an unexpired agent token belonging to the same user, then revokes the previous token. Temporary renewal failures are logged and retried; expiration falls back to reconnect/authentication. Update both hub and agent for this protocol support. Tokens are kept in process memory; the server stores only token hashes. Logout revokes that browser session and its sockets, not independent agent logins.

Each account sees and controls **only its own terminals**. Different browser sessions signed in to the same account share the terminals. The first viewer gets control; other viewers are read-only and may explicitly **Take control**. Only the controlling browser can send input or resize the PTY. The original local terminal can still type independently.

Browser displays follow the agent's applied PTY size, including resizes from the original local terminal. The controlling browser requests a viewport fit when its container changes, it takes control, or the agent reconnects; requests stay within 20-500 columns and 5-200 rows. Read-only viewers follow that shared size and scroll if it exceeds their viewport. While the browser is disconnected from the hub, retained terminal statuses are shown as unknown rather than live.

Login failures are throttled by direct peer IP (10 failures per 15 minutes), and concurrent password derivations are bounded to protect server memory. Browser WebSockets and browser login/logout requests enforce same-origin checks. The server does not use `X-Forwarded-For` or `X-Forwarded-Host` to relax these checks.

For unattended client use, set `AGENT_HUB_PASSWORD` in the environment using your secret manager, not a command-line password flag. The wrapper strips it from the child environment. The user-management command also accepts this variable for automation. Clear it afterward:

```powershell
# Set AGENT_HUB_PASSWORD securely in the environment before invoking.
npm.cmd run agent -- --user alice --no-local-input -- your-agent-command
Remove-Item Env:AGENT_HUB_PASSWORD
```

Treat hub credentials as interactive command access to every node registered under that account. The PTY is **not a sandbox**: the child runs with the wrapper's OS privileges. Do not run agent nodes as administrator/root unless that is explicitly intended. Terminal history may contain sensitive output; it is visible to other sessions of the same account.

## Remote access and HTTPS

By default, the hub listens **only on 127.0.0.1:3000**. For remote nodes, place a TLS reverse proxy in front of it and set the exact external origin before starting it:

```powershell
$env:HUB_PUBLIC_URL = 'https://hub.example.com'
npm.cmd start
```

Keep the backend bound to loopback when the proxy runs on the same host. The proxy must forward HTTP and WebSocket upgrades for `/ws/agent` and `/ws/browser`, preserve the `Origin`, `Cookie`, and `Authorization` headers, and use an idle timeout greater than 45 seconds. For example, an nginx TLS virtual host can forward its location with:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 90s;
}
```

Configure your own TLS certificate on that virtual host. Open `https://hub.example.com` in the browser, and run on the agent:

```text
npm run agent -- --server https://hub.example.com --user alice -- your-agent-command
```

The CLI refuses plain HTTP to non-loopback hosts unless `--allow-insecure-http` is explicitly supplied. For trusted-LAN experiments only:

```powershell
# Hub host; replace the address with this host's reachable LAN address.
$env:HUB_HOST = '0.0.0.0'
$env:HUB_PUBLIC_URL = 'http://192.168.1.20:3000'
npm.cmd start
```

```text
npm run agent -- --server http://192.168.1.20:3000 --allow-insecure-http --user alice -- your-agent-command
```

Plain HTTP sends passwords, commands, and terminal output unencrypted. Do not expose this mode to an untrusted network. Binding a non-loopback interface requires `HUB_PUBLIC_URL` so browser origins are explicit; open only the required firewall port yourself. Cross-origin browser clients are not supported.

## Configuration

All settings come from the process environment. `.env.example` is a reference, **not auto-loaded**. You may explicitly load your own `.env` with `node --env-file=.env dist/server/index.js`; make sure user-management commands use the same data-directory setting.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUB_HOST` | `127.0.0.1` | HTTP listen interface |
| `HUB_PORT` | `3000` | HTTP listen port |
| `HUB_PUBLIC_URL` | Local loopback origins | Exact browser origin, with no trailing slash; required for a non-loopback bind |
| `HUB_DATA_DIR` | `data` under the working directory | User database location; restrict it to the service's OS account |
| `AGENT_HUB_SERVER` | `http://127.0.0.1:3000` | Default CLI server |
| `AGENT_HUB_USER` | None | Default CLI username |
| `AGENT_HUB_PASSWORD` | Hidden prompt | Automation only; removed from the wrapped child environment |

CLI flags override client environment defaults. Additional flags: `--name`, `--cwd`, `--no-local-input`, `--allow-insecure-http`, and `--help`. Commands with executable paths containing spaces should be quoted normally for your shell.

Unix file creation uses restrictive modes for the user database. Windows permissions are inherited: use NTFS ACLs to limit the `data` directory to the service account. Back up `users.json`; it is the only persistent service data.

## Lifecycle and limits

- Output is broadcast live and the latest **1 MiB** per terminal is replayed when attaching or refreshing. Server history and terminal registrations are in memory, not written to disk. Exited/disconnected entries expire after 30 minutes.
- Agent connections reconnect with bounded exponential backoff, heartbeat monitoring, resume tokens, output sequence numbers, and acknowledgments. Unacknowledged output is replayed without duplication. The CLI buffers output during a disconnection and pauses PTY reads at 512 KiB until the queue drains below 256 KiB. An emergency 4 MiB cap stops the child with an explicit error rather than silently dropping output.
- Browser input is disabled while offline; input is **never queued or replayed after reconnect**, to avoid repeating commands. A network failure can interrupt in-flight keystrokes; verify the prompt before retrying.
- The child survives a hub restart **as long as its CLI wrapper remains running**. The wrapper logs in and registers a new terminal when the server has lost its registry. Acknowledged history is lost on restart, and browsers must sign in again. The service is a single-process hub, not a distributed/resilient terminal store.
- Limits: 32 retained terminals per account, 256 total, 64 sockets per account, 512 total; 64 KiB output chunks, 16 KiB input messages, validated terminal dimensions (20-500 columns, 5-200 rows), slow-viewer disconnection, and bounded browser input rates.
- The most recent local or controlling-browser resize sets the child PTY dimensions. View-only browsers use the actual PTY dimensions and may scroll horizontally.
- Use the platform's ordinary process supervisor if you need the hub or wrappers to start on boot. Automatic service installation and persistent OS-terminal reattachment are not included.

## Development and validation

```text
npm run dev
```

This runs the TypeScript API on port 3000 and Vite on **http://127.0.0.1:5173**, proxying `/api` and `/ws`. Create an account first. For local Vite development, leave `HUB_PUBLIC_URL` unset. Run wrappers against port 3000, not 5173. Production uses `npm run build` then `npm start`, with the API and built web UI on one origin.

```text
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:package
```

`npm test` runs the standalone agent tests plus password hashing/reset, token expiry/revocation and role separation, origin validation, user isolation, registration, history bounds, resume/deduplication, controller transfer, input, resizing, exit state, malformed messages, and login throttling.

`test:e2e` requires a production build and installed Google Chrome. It starts an ephemeral authenticated hub, opens the actual React UI in headless Chrome, and launches the **built CLI with a real native PTY**. It verifies TTY detection, secret-environment stripping, rendered ANSI colors, browser input causing a computed child response, native resizing, shared history, viewer control transfer, logout, server restart/reconnection, final output, and clean CLI exit. A second real-PTY test covers the hidden interactive password prompt, local keyboard input, working directory, and propagation of a nonzero child exit code. A third test runs the built user-management and server entry points to verify account creation/reset, production startup, authenticated HTTP access, and delivery of the built UI. A short-lived-token test verifies proactive renewal across multiple expiry windows, retry after a temporary login failure, old-token revocation, and uninterrupted PTY input/output on the same WebSocket. Tests use temporary users and directories, not production accounts.

`test:package` independently installs/builds a copy of the agent project outside the hub tree, packs it, globally installs the resulting tarball into a temporary prefix with production dependencies only, checks the actual installed `agent-hub` command, and verifies authentication, PTY output, remote input, resize, and nonzero exit against a real hub. This catches accidental dependencies on the hub source or development environment.

To use a separately installed browser binary:

```powershell
$env:HUB_TEST_BROWSER_EXECUTABLE = 'C:\path\to\chrome.exe'
npm.cmd run test:e2e
```

Or install Playwright's Chromium (`npx playwright install chromium`) and set `HUB_TEST_BROWSER_CHANNEL=chromium`. Playwright does not download a browser during the normal dependency installation.

## Layout

```text
server/       Auth, user-management CLI, HTTP service, and WebSocket relay
agent/        Independent, distributable PTY client project
shared/       Hub re-export of the agent's canonical terminal protocol
web/          React session dashboard and xterm.js terminal
tests/        Authentication, relay, browser/PTY, and package-install tests
scripts/      Optional project-local Windows Node.js installation/activation
```
