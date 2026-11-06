# MCP in Chatter

The backend is an MCP **client** for remote Streamable HTTP servers over HTTPS.
The desktop additionally runs local stdio MCP servers. The backend never installs
packages or starts their processes. Sampling, roots and elicitation are not exposed.

## Configuration

- `ENCRYPTION_KEY`: existing backend encryption key; required for tokens and OAuth.
  Preserve it across deployments and keep it separate from the database.
- OAuth callbacks are derived from the desktop's existing server connection address
  (API base plus /mcp/oauth/callback), preserving any reverse-proxy prefix.
  No MCP-specific environment variable is required.
- Admin MCP settings can override the complete public HTTPS callback URL for a
  custom deployment. This nonsecret setting is stored in the existing MCP policy
  in the database and takes effect immediately. An empty value restores automatic
  selection. Each attempt retains its original callback until completion.
- The callback must reach the backend without a Chatter bearer header.
  Bearer-token connections do not need any callback configuration.
- OAuth discovery, automatic client registration, PKCE, refresh and issuer-bound
  credentials use the SDK. Providers requiring a separately registered OAuth app
  may need provider-specific setup; arbitrary OAuth client-secret configuration
  is not exposed by this first UI.

## First use

1. Admin MCP tab: add an allowed HTTPS endpoint or select one from the catalog.
   Only approved entries are exposed in the desktop catalog.
2. In the MCP tab, independently choose who can add custom URLs and who can
   see the catalog: everyone / selected users / nobody. User selection reuses
   the existing searchable admin Select. Existing per-user deny exceptions
   remain visible as exclusions when the base permission allows everyone.
   User cards show connections; all access editing lives in the MCP tab.
   Global MCP disable always wins. Hiding the catalog removes the picker,
   public catalog and search from desktop and blocks its catalog API.
   Existing connections still work; custom URLs retain their separate permission.
3. Desktop Settings → MCP: create a personal connection, add a bearer token or
   authorize with OAuth, then refresh capabilities.
4. Select tools and choose eager injection or on-demand discovery.

## Execution

- The existing function-tool pipeline, task allowlists and subagent tool grants
  are reused. Room runs use the initiating account's connections.
- A personal connection reuses its MCP session between calls so server-side state
  survives. Idle sessions close after ten minutes; errors or explicit cancellation
  close the affected session. The backend keeps at most 128 sessions.
- Calls recheck current policy, connection state and tool selection.
  The existing disable-internet restriction also blocks MCP.
- Eager tools have stable, connection-specific names.
- `browse_mcp` lists connected server summaries by default. Set `connection_id`
  to inspect tools, resources and resource templates; metadata loads on first
  inspection, or explicitly with `refresh: true`. `query` searches cached
  metadata, `kind` filters it, and `next_cursor` continues pages of up to 20 items.
  Unknown connections are reported in `needs_refresh`. Tool results contain
  schemas and resource metadata, never resource bodies. Discovery does not
  change model function-tool definitions or inject new tools on the next turn.
- `search_mcp_tools` remains a compatibility alias for existing task allowlists;
  new runs use `browse_mcp`.
- `call_mcp_tool` invokes a selected tool using its returned input schema.
- At most 32 MCP definitions are injected; additional tools remain searchable.
- Refresh capabilities loads advertised tools, resources and templates without
  reading documents. Resource-only servers work without tools/list. Limits:
  20 connections per account, 200 tools / 500 resources / 200 resource templates
  per connection, three active operations per account and one per connection.
- `read_mcp_resource` reads an advertised URI or expanded resource template on
  explicit request. The URI goes only to the selected MCP server; Chatter never
  fetches it as a local file or URL. Text is paged with `offset` / `next_offset`
  (24,000 characters by default, at most 48,000). It reuses session cancellation,
  progress and access checks. Resources are never automatically injected.
- Wait time is configurable, 10–3600 seconds without progress, default 300.
  Progress resets it; there is no additional total-duration cap.
  Chat Stop and Stop operation abort local waiting. They cannot guarantee that
  the remote service undoes an operation. Transport reconnection retries are off.
- Arguments are validated against JSON Schema. Text results use the existing
  untrusted-content wrapper; images can use the existing direct-vision sink.
  Other nontext content returns metadata. MCP prompts are not exposed.

## Confirmations

- Tool calls (eager aliases and call_mcp_tool) and resource reads require user
  approval by default. browse_mcp and metadata refresh do not read resource
  contents or invoke tools and need no card.
- Desktop uses the existing confirmation queue attached to the chat input.
  The card shows the connection, exact tool/resource and arguments. Users can
  approve once, reject, reject with a comment, or remember a permission.
  Telegram provides the equivalent buttons; long arguments are attached as JSON.
- A remembered tool permission covers that exact tool name on that connection,
  with any arguments. A resource permission covers the exact URI, including
  subsequent pages; it does not grant an entire URI template.
- Connection settings can revoke individual permissions or allow all operations
  on that connection. Tool availability and confirmation permissions are separate.
  Existing connections start with no saved grants.
- Remote grants are stored in mcp_connections.approval_policy_json. Local grants
  are persisted in the encrypted desktop configuration and synchronized with the
  existing RAM-only metadata snapshot; the backend does not store local grants in DB.
- Pending cards expire after five minutes and disappear on cancellation.
  Approval is consumed once; account ownership, current permissions and the
  connection/schema/configuration are checked again before execution.
  Background tasks that cannot ask for approval return a rejection unless an
  existing saved grant permits the operation.

## Security boundary

Only public HTTPS endpoints are accepted. Private, loopback, link-local, reserved
and multicast addresses, including mapped IPv6, are rejected. All DNS answers
are validated and pinned into the actual socket lookup. Redirects are rejected.
OAuth discovery, registration and token requests use the same guarded transport.

Tokens are write-only in APIs and encrypted with AES-256-GCM in separate tables.
Admin cards show metadata, never decrypted secrets. Credential writes compare
the previous encrypted value, preventing a stale authorization from restoring
a secret the user replaced. Changing an approved server URL blocks existing
connections instead of redirecting saved credentials.

This does not make external operations/descriptions inherently trustworthy.
The official Registry is discovery metadata, not Chatter's security approval.

## Catalog

The admin tab searches the public Registry (latest active remote Streamable
HTTP entries, ten-minute cache, cursor pagination) or adds a server manually.
Approval controls whether that server appears in the desktop catalog.
For users without custom-server permission, the desktop catalog and its API
expose only approved entries from Chatter's database; search filters that list.
Users allowed to add custom servers can also search the public Registry and
connect its entries as custom URLs. The catalog-visibility setting gates both
sources. Permissions are rechecked after Registry requests, and revocation hides
remote results and clears any selected custom endpoint.
Admins can mark catalog entries as recommended. These appear in a separate section
above other entries. Approved entries may be remote HTTP servers or local stdio
launch commands/packages. Local installations use the existing desktop installer
and require local/custom MCP permission; the backend never executes these commands.
Changing an entry to stdio blocks its old HTTP connections.

Public Registry cards include version, publisher, endpoint and HTTPS links to
the repository, website and Registry record when supplied. Registry search
requires three characters; desktop search has no minimum length.
Catalog metadata does not claim tools/resources support: actual capabilities
are read only after connecting. Package installation commands are never executed.

Desktop MCP reads use the shared settings query hook and cache policy.
Successful admin changes send an MCP-only notification over the existing desktop
WebSocket. Personal changes notify only that account; shared changes notify all
connected desktops. The notification invalidates only the MCP settings query,
including inactive cached queries. Reconnection revalidates MCP settings too.
There is no polling timer or separate settings-refresh button.

## Local MCP servers

- Desktop MCP settings install npm/stdio entries from Registry, npmjs package
  links, package identifiers, or npx commands. Direct executable commands and
  JSON with command/args/env can register an existing stdio server. Python/uvx
  packages use the managed runtime described below. Bare GitHub repository
  URLs are not automatic installation manifests.
- npm uses a Chatter-managed current LTS Node runtime (24+). The official archive
  is checked against Node's SHA256 manifest and unpacked with the OS tar utility.
  Each MCP has its own package directory; npm's engine compatibility is enforced.
- Node/runtime and package downloads/installations run only on the PC. There is
  no global npm installation. Catalog-required variables/arguments are requested
  before installing. Custom commands run without an implicit shell.
- Local configuration, credentials and cached capabilities stay in per-server,
  per-account folders under Electron userData/mcp. The full configuration uses
  Electron safeStorage; secret storage must be available. Credentials and launch
  commands are not included in the WebSocket metadata snapshot.
- Expanding local connection settings reads its current environment JSON from
  the encrypted configuration on that PC through the existing trusted IPC.
  User variables are shown separately from Chatter-managed runtime variables;
  closing the settings releases their query cache. They are not sent to the backend.
- Saving changed environment JSON replaces the user variable map, restarts the
  enabled process and rediscovers capabilities before syncing public metadata.
  Saving identical values keeps the current process and tools. Removing a key,
  or saving an empty object, removes that user variable without deleting managed
  runtime paths. Invalid JSON/values leave the existing process unchanged.
  Restart failures remain visible on the connection and can be corrected by
  editing the saved JSON.
- Opening the authenticated desktop WebSocket sends its local metadata snapshot.
  Admin permission changes request a fresh snapshot over the same connection.
  The backend keeps it in RAM, bound to the current authenticated WS connection,
  without device records or new database tables. Closing that connection drops
  the snapshot. A replacement socket cannot use the previous snapshot.
- browse_mcp/call_mcp_tool/read_mcp_resource reuse existing routing, validation,
  progress, cancellation and vision processing. The backend uses execute_ipc
  with mcp_control to ask the current desktop to discover/call/read; it cannot
  install packages or change local commands through that IPC operation.
- Local MCP requires custom-server permission, global MCP enable, and absence
  of the existing disable-internet restriction. The tools are available to the
  same account from desktop, Telegram or other backend chat clients while its
  desktop is connected. Telegram live behavior has not been manually tested.
- Disable stops the process but keeps configuration. Remove stops it, removes
  only its UUID directory and resynchronizes availability. External files are
  not removed. Shared Node runtime remains for other installations.

## Verification

- `pnpm exec tsx backend-api/tests/mcp.test.mts`: temporary SQLite and the real
  SDK HTTP transport against a local server; discovery/calls/schemas, account
  isolation, policies, encrypted secrets, cancellation, progress, sampling denial,
  resource metadata/templates/reads/pagination, resource-only servers, stable
  tool definitions, latest-version catalog filtering and catalog visibility.
  OAuth tests use a local fake authorization service with the real SDK PKCE flow.
- `pnpm exec tsx desktop-app/tests/mcp-ui.test.mts`: actual React desktop/admin/
  user-card components in hidden Electron, with mocked APIs; toggles, query
  invalidation, catalog links and complete catalog/search hiding. Optional `MCP_UI_SCREENSHOT_DIR` saves screenshots.
- A separate real Registry request checks public HTTPS/DNS/TLS.
- These tests do not log into a real third-party account or verify deployment.

- pnpm exec tsx backend-api/tests/mcp-local.test.mts uses an actual stdio child
  process and the existing backend IPC gateway with a simulated WebSocket.
  It checks discovery, resources, persistent sessions, account isolation,
  RAM-only metadata, progress, cancellation, permission revocation and removal.
  MCP_REAL_INSTALL=1 also downloads Node, installs the official server-memory
  npm package, calls read_graph and removes the test installation.

## Managed Python MCP packages

The existing local installer accepts uvx commands and command/args JSON, for example
uvx windows-mcp serve. It also accepts PyPI package entries from the Registry and
pypi:package or https://pypi.org/project/package/ sources.

Chatter downloads an official uv release and verifies its SHA-256 before extracting.
It reads the selected PyPI package's Python requirement, then uv prepares a managed
Python and installs the pinned package version in an isolated tool environment.
Neither a system uv nor a system Python installation is required. Commands run as
direct executables, without a shell. uvx --python and --from are supported; other
uvx installation options are rejected explicitly rather than silently ignored.
Application arguments after the tool name are preserved.

Python environments use short per-connection directories under the existing MCP
data root (py/<scope-and-id-hash>) to avoid Windows DLL/path-length failures.
Configuration stays in the existing encrypted account directory. Removing an MCP
stops its process and deletes its tool environment/cache along with its settings.
The shared uv/Python runtime remains available for other installed MCPs.
Restarting a server uses its installed executable and does not reinstall or upgrade
packages. Existing raw uvx configurations are prepared when capabilities are refreshed.

## Sign-in during connection creation

The existing remote connection form offers Add and sign in with OAuth as well as
plain creation with an optional token. A failed sign-in retains the created
connection for retry. Refreshing an unauthenticated connection returns
mcp_authorization_required instead of requiring callback configuration.

## Pre-registered OAuth applications

The administrator can enable a pre-registered OAuth application in the existing
remote MCP server editor. Set its Client ID and optional Client Secret, select
automatic/client_secret_post/client_secret_basic/none authentication, and optionally
supply space-separated scopes as a fallback to the MCP server's metadata.

The registration is bound to that approved server's exact HTTPS URL. Its credentials
use the same AES-256-GCM encryption as per-user MCP credentials, in mcp_servers.oauth_client. The admin response exposes the Client ID and whether a secret exists,
never the secret itself. Desktop lists and catalog results omit application
credentials. Leaving the secret field empty preserves a saved secret; the separate
remove action deletes it. Changing the endpoint clears the old registration.

Users connect the approved server and use the existing OAuth sign-in button.
Each user keeps independent encrypted access/refresh tokens. Shared application
secrets remain in the server registration, not in users' credentials or browser URLs.
Changing/removing the registration invalidates pending OAuth states and existing
OAuth logins, and cancels calls using them. Manually supplied PATs are independent.
The SDK continues to handle discovery, PKCE, callback and refresh, including
dynamic registration when no pre-registered application is configured.

For GitHub, first register a GitHub App or OAuth App and enter its credentials in
the approved GitHub MCP entry. Register the public callback as the desktop's
backend URL plus /mcp/oauth/callback, or the global callback override if configured.
This is application registration; each user authorizes their own GitHub account.
See https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md.

Tests cover an authorization server without dynamic registration, post/basic/public
clients, PKCE, token refresh, two independent users, encrypted and redacted
credentials, secret preservation/removal, rotation, cancellation and endpoint/issuer
binding. The real GitHub login still requires a registered application and a live
interactive login; it is not proven by the protocol fixtures.
