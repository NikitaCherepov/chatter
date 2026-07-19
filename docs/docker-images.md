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

Create a GitHub personal access token with only `read:packages`, then log in on
the test server before running the installer:

```bash
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io \
  --username YOUR_GITHUB_USERNAME --password-stdin
sudo bash install.sh
```

Do not put the token in `compose.env`, service environment files, or the Git
repository. Once the six GHCR packages are public, installation no longer needs
registry authentication.

Local development can still use the Dockerfiles directly:

```bash
docker compose build backend
```

The production installer always uses `pull` and `--no-build`.
