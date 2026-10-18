# Guidance for AI coding agents

## Read first

This repository implements an authenticated remote-terminal hub and an independently distributable PTY client. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the design, [README.md](README.md) for service operation, and [agent/README.md](agent/README.md) before changing the standalone client.

The term "agent" has two meanings here: you are an AI coding agent; the `agent` project is the runtime terminal client installed on user nodes.

## Project map and dependency boundaries

- `server`: TypeScript/Express HTTP service, authentication, user-management CLI, and WebSocket relay.
- `web`: React/Vite dashboard and xterm.js terminal.
- `agent`: separate npm project with its own manifest, lockfile, TypeScript config, source, and tests.
- `agent\src\protocol.ts`: canonical protocol types, runtime response guards, and limits.
- `shared\protocol.ts`: hub/browser re-export of that protocol. Do not create a second protocol definition.
- `tests`: hub integration, browser/native-PTY end-to-end, and isolated-package tests.

Keep `agent` independently buildable when copied outside this repository. It must not import parent-directory source, extend root configuration, depend on root `node_modules`, or require server/web assets. Runtime dependencies are currently only `node-pty` and `ws`. The hub may import reusable agent source; that dependency direction must not be reversed.

The root and agent have separate lockfiles and are not an npm workspace. Update the appropriate manifest and lockfile together. Never hand-edit generated `dist`, dependency folders, or tarballs.

## Setup and commands

Use Node.js 22.12+; Node.js 24 LTS is recommended. On Windows, prefer `npm.cmd` if PowerShell blocks `npm.ps1`. An optional project-local runtime can be activated in each terminal with:

```powershell
. .\scripts\Use-LocalNode.ps1
```

For a fresh full-development checkout, run from the repository root:

```text
npm ci
npm run install:agent
npm run build
```

Install/restore dependencies when missing or after dependency changes, not before every check.

| Command from root | Purpose |
| --- | --- |
| `npm run dev` | API watch process and Vite at `http://127.0.0.1:5173`. |
| `npm run build` | Build standalone agent, hub, and web UI. |
| `npm run build:server` | Compile hub and imported shared source. |
| `npm run build:web` | Build production browser assets. |
| `npm run build:agent` | Build the independent client. |
| `npm run typecheck` | Check hub/tests, web, and standalone agent types. |
| `npm test` | Standalone agent tests plus auth/relay integration tests. |
| `npm run test:e2e` | Real browser and PTY tests; requires a current build and Chrome. |
| `npm run test:package` | Isolated agent install/build/pack and native-PTY package test. |
| `npm run pack:agent` | Rebuild and create the portable agent tarball in the root. |

Within `agent`, use `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, and `npm pack` without the parent project.

No lint command or documentation-test framework is currently configured. Do not invent commands or add tooling just to validate documentation.

## Implementation conventions

Use strict TypeScript and existing ESM conventions. NodeNext source imports use `.js` specifiers for compiled modules. Validate untrusted JSON at runtime; static message types do not validate network input. Reuse existing guards and limits rather than duplicating checks or bypassing types with `any`.

Route application errors through existing HTTP JSON responses, protocol error messages, CLI logs, or UI notices. Do not silently swallow a failure or return success-shaped defaults. Keep comments focused on non-obvious lifecycle or platform behavior.

Follow existing React state/transport separation: `useHub` owns browser connection/reconnect behavior, while `TerminalPane` owns terminal rendering, input, and sizing. Keep ANSI data as terminal data; do not render it as HTML.

## Invariants to preserve

### Authentication and ownership

- No default users, plaintext password persistence, password flags, token URLs, or secret logging.
- Preserve salted scrypt verification, opaque random tokens, hashed server-side token lookup, role separation, expiration, and revocation.
- Browser access requires its cookie and allowed Origin; agent access requires an agent bearer token.
- List, watch, resume, input, and resize operations must remain restricted to the terminal owner.
- Renewal requires a still-valid connection and a valid replacement agent token for the same username. Replace the peer's active token/identity, revoke the prior token, and confirm `authenticated` on the same socket.
- Message validation and heartbeat checks must use the peer's current token after renewal, not the original handshake token.
- Proactive renewal must preserve the PTY, terminal ID, output sequence, and browser controller. Keep retry, confirmation timeout, reconnect fallback, and timer cleanup behavior.
- Strip `AGENT_HUB_PASSWORD` from the wrapped child's environment and avoid passing it to helper processes.

### Terminal transport and lifecycle

- Use a real PTY, not `child_process` stdout capture, for user shells and agent CLIs.
- Spawn one child per wrapper invocation; reconnect must not spawn a replacement child.
- Preserve local input/output, browser input/output, colors, control characters, and native resizing on Windows and portable Node platforms.
- Enforce one controlling browser per terminal; local keyboard input remains independent.
- Keep output sequencing, acknowledgments, deduplication, bounded queues/history, and PTY backpressure.
- Never replay terminal input after reconnect. Delivery is not exactly-once command execution.
- Browser detach must not kill the child. Wrapper termination must clean up its child. Propagate natural zero/nonzero exit codes and drain accepted output before successful completion.
- Preserve Windows ConPTY cleanup and avoid native helper/worker leaks.

Changing an invariant is a behavioral design change: document the intent and update the associated tests and user guidance rather than accidentally changing it.

## Validation by change type

| Change | Relevant validation |
| --- | --- |
| Documentation only | Check claims, commands, paths, and links against source; no application rebuild needed. |
| Authentication or relay | Type-check and relevant `tests\auth.test.ts` / `tests\hub.test.ts` cases; add rejection/ownership cases. |
| Protocol change | Update types, runtime guards, sender, receiver, and matching tests together; check hub/client compatibility. |
| PTY, reconnect, renewal, or terminal UI | Build before `test:e2e`; verify real input produces child output, not only registration or mocked traffic. |
| Agent build, dependency, or packaging | Run standalone checks and `test:package`; verify no parent-source or development-dependency leakage. |
| Shipped agent change | Regenerate the portable tarball after validation if delivering an updated package. |

Target a subset when appropriate. For example:

```text
node --import tsx --test --test-name-pattern="agent token replacement" tests\hub.test.ts
```

The E2E suite uses installed Chrome by default. `HUB_TEST_BROWSER_EXECUTABLE` selects a binary; `HUB_TEST_BROWSER_CHANNEL` selects a Playwright channel. Browser downloads are not part of a normal dependency installation. Native PTY builds may need platform-specific build tools; see the standalone README.

## Operational safety and documentation

Treat `data`, `.env`, passwords, bearer/resume tokens, and terminal output as sensitive. Do not inspect production credentials or use production accounts for tests. Existing tests create temporary users, ports, directories, browser sessions, and processes; clean up resources you start without stopping unrelated services.

Do not loosen loopback defaults, explicit public-origin checks, or the client's remote-HTTP opt-in as a convenience. The PTY is not a sandbox; never assume terminal commands are safe merely because they came through the hub.

Update the root README for setup/deployment changes, the agent README for client changes, and the architecture document when changing component boundaries, persistence, authentication flows, or delivery semantics. Keep these instructions synchronized with actual package scripts and tests.
