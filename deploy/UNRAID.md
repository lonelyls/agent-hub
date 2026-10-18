# Deploy Agent Hub to Unraid

Target: **192.168.68.155**, using **http://192.168.68.155:3080** for an initial trusted-LAN deployment. Port 3080 avoids Unraid's management UI on ports 80/443. Agent CLI wrappers stay on the machines whose terminals you want to control.

The deployed public address is **https://agenthub.phoenixlab.uk**. For that deployment, set `HUB_PUBLIC_URL=https://agenthub.phoenixlab.uk` (replacing the initial LAN value in the examples below), access the dashboard through HTTPS, and launch the Windows client with:

```powershell
agent-hub.cmd --server https://agenthub.phoenixlab.uk --user sheng --name devbox2 -- powershell.exe -NoLogo
```

Keep the backend HTTP port private to the trusted LAN/proxy; the client does not need `--allow-insecure-http` when using this HTTPS address.

Plain HTTP exposes credentials and terminal traffic to the network. Use this only on a trusted LAN; for untrusted access, configure an HTTPS reverse proxy as described below. Do not port-forward 3080 to the internet.

## 1. Transfer the source bundle

The prepared archive on the Windows development machine is:

```text
D:\Repos\agent-hub\agent-hub-unraid-source.tgz
```

It contains only build inputs and deployment documentation, not accounts, `.env` files, Git history, dependencies, or the Windows Node.js runtime. To regenerate it from the project root:

```powershell
tar.exe -czf agent-hub-unraid-source.tgz Dockerfile .dockerignore compose.yaml compose.unraid.yaml package.json package-lock.json tsconfig.json tsconfig.build.json vite.config.ts server shared agent\src web\index.html web\tsconfig.json web\src deploy README.md ARCHITECTURE.md AGENTS.md
```

Copy it through an existing writable Unraid share, for example `\\192.168.68.155\appdata` **if that share is already exported and writable**. Do not enable public access to appdata or loosen its security to transfer this file. Use another existing private share if needed, then move the archive from the Unraid web terminal.

Alternatively, enable SSH in Unraid's **Settings > Management Access** and use your normal authenticated SSH account. Verify the server's host fingerprint when first connecting:

```powershell
scp.exe .\agent-hub-unraid-source.tgz root@192.168.68.155:/mnt/user/appdata/
```

No SSH password, private key, or Unraid account is included in this project.

## 2. Prepare a dedicated application directory

Open Unraid's web UI at **http://192.168.68.155** and use its terminal. The following commands are **Linux shell commands on Unraid**, not PowerShell commands. Confirm Docker is enabled in Unraid Settings.

```sh
docker version
mkdir -p /mnt/user/appdata/agent-hub/source
tar -xzf /mnt/user/appdata/agent-hub-unraid-source.tgz \
  -C /mnt/user/appdata/agent-hub/source
cd /mnt/user/appdata/agent-hub/source
```

For a **new deployment**, create a dedicated data directory owned by the image's non-root Node.js user (UID/GID 1000):

```sh
mkdir -p /mnt/user/appdata/agent-hub/data
chown 1000:1000 /mnt/user/appdata/agent-hub/data
chmod 700 /mnt/user/appdata/agent-hub/data
```

Do not recursively change ownership of appdata or unrelated applications. If restoring existing user data, verify its files are readable/writable by UID 1000 and retain restrictive permissions. Unraid's generic permissions-repair tools must not make this authentication directory publicly writable.

## 3. Build and create your account

```sh
docker build -t agent-hub:local .

docker run --rm -it \
  --mount type=bind,source=/mnt/user/appdata/agent-hub/data,target=/app/data \
  -e HUB_PUBLIC_URL=http://192.168.68.155:3080 \
  agent-hub:local node dist/server/users-cli.js alice
```

Choose a password of at least 12 characters at the hidden prompt. No default credentials are created. Create the account before starting the hub. The build needs outbound access to the Node.js image registry and npm registry; Node.js is not required on the Unraid host.

## 4. Start the service with Docker

This method does not require the Compose plugin:

```sh
docker run -d \
  --name agent-hub \
  --restart unless-stopped \
  --init \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  -p 192.168.68.155:3080:3000 \
  --mount type=bind,source=/mnt/user/appdata/agent-hub/data,target=/app/data \
  -e HUB_PUBLIC_URL=http://192.168.68.155:3080 \
  agent-hub:local
```

If that container name or port already belongs to another service, do not remove it blindly. Choose a different name/unused port and update `HUB_PUBLIC_URL` and client/browser addresses to match.

Validate startup on Unraid:

```sh
docker ps --filter name=agent-hub
docker logs --tail 50 agent-hub
docker inspect --format '{{.State.Health.Status}}' agent-hub
curl --fail http://192.168.68.155:3080/api/health
```

The health status should become `healthy` after its first probe. Open **http://192.168.68.155:3080** and sign in. Use the exact configured origin; alternate hostnames will fail browser origin checks.

The container runs as UID 1000, without privileged mode, host networking, Docker-socket access, or host-terminal access. Only the application data directory is mounted.

## Compose alternative

If `docker compose version` succeeds, use Compose instead of the `docker run` service above. Do not start both methods on the same port.

```sh
cd /mnt/user/appdata/agent-hub/source
docker compose -p agent-hub -f compose.unraid.yaml config
docker compose -p agent-hub -f compose.unraid.yaml build
docker compose -p agent-hub -f compose.unraid.yaml run --rm hub \
  node dist/server/users-cli.js alice
docker compose -p agent-hub -f compose.unraid.yaml up -d
docker compose -p agent-hub -f compose.unraid.yaml ps
```

Create the data directory as in step 2 before running these commands. `compose.unraid.yaml` is a complete standalone configuration using an appdata bind mount. The separate local `compose.yaml` uses a Docker-managed volume and exposes only localhost.

Always select `compose.unraid.yaml` for Unraid account management and service operations so they use the same data directory and configuration. Do not merge the local and Unraid configurations.

## Unraid Docker UI alternative

After building the image, you may create an Unraid container template using these settings **instead of** starting it with Docker CLI or Compose:

| Field | Value |
| --- | --- |
| Name | `agent-hub` |
| Repository/image | `agent-hub:local` |
| Network | Bridge |
| Container port / host port | TCP `3000` / `3080` |
| Container path / host path | `/app/data` / `/mnt/user/appdata/agent-hub/data` (read/write) |
| Variable | `HUB_PUBLIC_URL=http://192.168.68.155:3080` |
| WebUI | `http://[IP]:[PORT:3000]` |
| Privileged | Off |

The image already sets `HUB_HOST=0.0.0.0`, `HUB_PORT=3000`, and `HUB_DATA_DIR=/app/data`. Do not override the non-root user. Disable automated registry-based image updates for this locally built image; rebuild it from source for updates. Check the LAN exposure of any port mappings made through the UI.

## 5. Connect a Windows agent node

On the development machine, with the existing client build:

```powershell
Set-Location D:\Repos\agent-hub
. .\scripts\Use-LocalNode.ps1
npm.cmd run agent -- --server http://192.168.68.155:3080 --allow-insecure-http --user alice --name windows-agent -- powershell.exe -NoLogo
```

For another node, install the portable agent package as explained in [the agent guide](../agent/README.md), then run:

```powershell
agent-hub.cmd --server http://192.168.68.155:3080 --allow-insecure-http --user alice -- your-agent-command
```

The explicit insecure-HTTP option acknowledges unencrypted trusted-LAN traffic. For HTTPS it is not needed. Enter the same hub password and verify that a terminal appears in the browser, renders child output, and accepts input.

## Updates, account resets, and backup

Rebuild the image from updated source. For Docker CLI deployments, stop/remove **only the Agent Hub container you created**, then run the service command from step 4 again:

```sh
docker stop agent-hub
docker rm agent-hub
```

For Compose, use the same project and Unraid file:

```sh
docker compose -p agent-hub -f compose.unraid.yaml up -d --build
```

To reset a password on the running CLI-created container:

```sh
docker exec -it agent-hub node dist/server/users-cli.js alice --reset
docker restart agent-hub
```

Restarting revokes existing login sessions. For Compose containers, use `docker compose ... exec hub` and `docker compose ... restart hub` with the same project/files instead. Back up `/mnt/user/appdata/agent-hub/data` securely; it contains salted password hashes. Container replacement preserves it. Terminal history and authentication sessions are memory-only and are lost on a hub restart; running client wrappers reauthenticate.

## HTTPS reverse proxy

When a reverse proxy is configured, set `HUB_PUBLIC_URL` to its exact HTTPS origin, for example `https://hub.example.com`, and recreate the container. For Compose this can be supplied through its process environment or a local `.env` file. Proxy HTTP and both WebSocket routes to port 3080 with authentication/Origin headers preserved and an idle timeout greater than 45 seconds.

An HTTPS public origin sets Secure cookies: access the web UI through that HTTPS address, not the HTTP LAN URL. Restrict backend port access to the proxy as appropriate. No DNS name or TLS certificate is configured automatically. See [the root deployment guidance](../README.md#remote-access-and-https).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| SSH connection refused | Enable SSH in Unraid Management Access, or use its authenticated web terminal; the web UI being reachable does not imply SSH is enabled. |
| `docker compose` missing | Use the Docker CLI steps; Compose is optional. |
| Port already allocated | Choose an unused host port and update the public origin/browser/client URLs. |
| Permission denied on `users.json` | Verify ownership/permissions on this app's dedicated data directory; the container uses UID 1000. |
| Untrusted origin / rejected browser socket | Open the exact `HUB_PUBLIC_URL`, including scheme and port. |
| Client refuses HTTP | Use HTTPS, or the explicit trusted-LAN `--allow-insecure-http` option. |
| Image build fails downloading packages | Check Unraid DNS and registry connectivity; do not disable TLS verification. |
