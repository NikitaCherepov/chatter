# Chatter Docker images

The `Build Docker images` GitHub Actions workflow builds six Linux AMD64
images and publishes them to GitHub Container Registry:

- `ghcr.io/nikitacherepov/chatter-backend`
- `ghcr.io/nikitacherepov/chatter-telegram-bot`
- `ghcr.io/nikitacherepov/chatter-webapp-notes`
- `ghcr.io/nikitacherepov/chatter-voice`
- `ghcr.io/nikitacherepov/chatter-admin-panel`
- `ghcr.io/nikitacherepov/chatter-manager`

The workflow runs manually and for Git tags matching `v*`. Manual builds and
version tags publish `latest`, a commit-SHA tag, and applicable semantic-version
tags.

## Testing while packages are private

Create a GitHub personal access token with only `read:packages`. After Docker is
installed, log in on the test server and run the installer again:

```bash
sudo docker login ghcr.io --username NikitaCherepov
sudo bash install.sh
```

Paste the token into Docker's `Password` prompt; terminal input is hidden.

The installer mounts the root Docker configuration read-only into
`chatter-manager`, so optional services enabled later from the admin panel can
pull the same private images. The registry token is not copied into Chatter's
environment files.

Do not put the token in `compose.env`, service environment files, or the Git
repository. Once the six GHCR packages are public, installation no longer needs
registry authentication.

Local development can still use the Dockerfiles directly:

```bash
docker compose build backend
```

The production installer always uses `pull` and `--no-build`.

## Gateway and firewall options

By default, the installer runs Caddy on TCP ports 80 and 443. It adds the
gateway rules to an active UFW installation. Use `--skip-firewall` to leave
UFW alone, or `--enable-ufw` to explicitly enable it.

If a gateway port is busy, the installer shows the process or container and
offers choices in the terminal before continuing. Without a terminal, it
exits with the flags you can pass on the next run.

- `sudo bash install.sh --https-port=8443` serves Chatter over HTTPS on 8443.
  Keep TCP port 80 reachable from the internet for ACME HTTP-01 validation.
- `sudo bash install.sh --no-gateway` leaves the manager on the server's
  loopback interface and prints the SSH tunnel command. If you provide your
  own HTTPS reverse proxy, set `CHATTER_PUBLIC_URL` to its HTTPS origin when
  running the installer so the Telegram Notes link uses that address.
- `sudo bash install.sh --gateway --https-port=443` restores the default
  gateway. The installer saves the gateway mode and HTTPS port between runs.

For the piped installation, pass these flags after `sudo bash -s --`.
