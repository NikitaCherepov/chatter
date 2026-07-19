# Chatter Manager

Small authenticated control API for a self-hosted Chatter installation. The
public UI is the separate Next.js `admin-panel`; this service proxies that UI so
the browser only needs one address.

Manager settings are stored in a private host directory. Docker operations are
restricted to a fixed service list: `backend`, `telegram-bot`, `webapp-notes`,
and `voice`. The main backend never receives access to the Docker socket.

On first start the installer provides the generated password through the
one-use `/config/admin.bootstrap` file. Manager stores only its scrypt hash in
`/config/auth.json` and immediately deletes the bootstrap file. The password is
never placed in the container environment.

The Docker socket gives this service host-level privileges. Keep the manager
small, authenticated and behind TLS. Never add arbitrary shell-command routes.
