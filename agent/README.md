# Agent Hub Agent

An independent Node.js CLI that shares a real pseudo-terminal with an Agent Hub server. This folder is a complete project: it has its own source, TypeScript configuration, package manifest, lockfile, and tests. It can be copied and built without the hub repository. Its only runtime dependencies are **node-pty** and **ws**; no server, React, browser, or user database is needed on the agent node.

## Install the portable package

Obtain `agent-hub-agent-1.0.0.tgz` from your hub administrator. On a node with Node.js **22.12+** (24 LTS recommended) and npm:

```powershell
npm.cmd install --global --allow-scripts=node-pty .\agent-hub-agent-1.0.0.tgz
agent-hub.cmd --server https://hub.example.com --user alice --name windows-agent -- powershell.exe -NoLogo
```

On Linux/macOS:

```sh
npm install --global --allow-scripts=node-pty ./agent-hub-agent-1.0.0.tgz
agent-hub --server https://hub.example.com --user alice --name linux-agent -- /bin/bash
```

The explicit script permission lets newer npm versions install the native PTY dependency. The package is private and distributed as a local tarball, not published to the public npm registry. npm still downloads its declared runtime dependencies during installation.

Enter your hub password at the hidden prompt. Use the same account in the hub web UI. Each invocation creates one terminal session. Replace the shell with your agent executable and arguments; place `--` before the child command. Windows batch files require `cmd.exe /c program.cmd ...`.

For a hub on the same machine:

```powershell
agent-hub.cmd --server http://127.0.0.1:3000 --user alice -- copilot
```

Use HTTPS for remote hubs. Plain HTTP to a non-loopback host is refused unless you explicitly add `--allow-insecure-http` for a trusted LAN.

The tarball contains compiled JavaScript, not a bundled Node.js executable or platform-specific `node_modules`. Install it on each target OS/architecture instead of copying an installed `node_modules` directory between machines. A fully offline installation requires a pre-populated npm cache for the runtime dependencies.

## Build from this standalone folder

Copy **only this `agent` directory**, excluding `node_modules`, `dist`, and existing `.tgz` files, to any directory on the target machine:

```text
npm ci
npm run build
npm start -- --server https://hub.example.com --user alice -- your-agent-command
```

The source project does not extend or import files outside its own directory. `npm ci` uses its independent `package-lock.json`.

To produce the distributable:

```text
npm ci
npm pack
```

`prepack` rebuilds automatically. The resulting `agent-hub-agent-1.0.0.tgz` includes only the compiled `dist` files, package metadata, and this README. The hub host also provides `npm run pack:agent`, which writes the same package to the hub project's root.

For newer npm versions, `allowScripts` approves the pinned node-pty build steps during source installation. Windows 10 build 18309+ / Windows 11 use ConPTY with packaged native prebuilds. A native rebuild needs Python and Visual Studio C++ Build Tools on Windows, Python/make/a C++ compiler on Linux, or Xcode Command Line Tools on macOS.

## Options and credentials

```text
agent-hub --help
```

| Flag | Environment / default |
| --- | --- |
| `--server <origin>` | `AGENT_HUB_SERVER` / `http://127.0.0.1:3000` |
| `--user <username>` | `AGENT_HUB_USER` / required |
| `--name <name>` | Hostname and command name |
| `--cwd <directory>` | Current directory |
| `--no-local-input` | Disable the original terminal's keyboard input |
| `--allow-insecure-http` | Allow unencrypted remote HTTP, trusted LAN only |

Passwords are never accepted as command-line flags or stored in a config file. For automation, supply `AGENT_HUB_PASSWORD` using a secret manager; the client removes it from its own environment and the wrapped child's environment. Credentials are held in memory for automatic reauthentication. No default accounts are supplied; accounts are created by your hub administrator.

The client proactively obtains a new bearer token **one minute before expiry** (or at 80% of the remaining lifetime for tokens shorter than five minutes). It authenticates the replacement on the **existing WebSocket**, and the hub revokes the old token after accepting it. The PTY, terminal ID, browser controller, and output stream stay connected. Temporary renewal failures are logged and retried with bounded backoff while the old token is still valid; if it expires, the ordinary reconnect/authentication flow takes over. This requires a hub version supporting the `reauthenticate` protocol message; update the hub together with the client.

Terminal output, colors, prompts, local keystrokes, browser keystrokes, and resize events pass through the PTY. The child runs with your OS privileges, **not in a sandbox**. Closing the browser does not stop it; ending the wrapper does. Natural child exit codes, including nonzero codes, propagate to the wrapper.

The client reconnects after network interruptions, buffers output with bounded backpressure, and resumes acknowledged sequence numbers without duplicating output. If the hub restarts and loses its registry, the running client registers a new terminal; already-acknowledged history cannot be recovered. Input is not replayed after reconnect.

## Tests

```text
npm run typecheck
npm test
```

These tests run independently of the hub and cover message validation, terminal size limits, and CLI help. The hub project's `npm run test:package` additionally copies this source project to an isolated directory, installs/builds it there, packs and globally installs its tarball into a temporary prefix, checks its installed command, and runs the installed client against a real authenticated hub and native PTY. The hub's browser end-to-end tests cover the same client with the React terminal UI.
