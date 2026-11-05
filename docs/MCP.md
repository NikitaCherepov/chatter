# MCP in Chatter

The backend is an MCP **client** for remote Streamable HTTP servers over HTTPS.
No stdio, subprocesses, package installation, sampling, roots or elicitation.

## Configuration

- `ENCRYPTION_KEY`: existing backend encryption key; required for tokens and OAuth.
  Preserve it across deployments and keep it separate from the database.
- `MCP_CALLBACK_URL`: public HTTPS address of `/mcp/oauth/callback`, for example
  `https://your-host/backend/mcp/oauth/callback` behind that proxy prefix.
  The callback uses expiring, single-use state bound to the account and connection.
  It must reach the backend without requiring a Chatter bearer header.
- Bearer-token connections do not need the OAuth callback setting.
- OAuth discovery, automatic client registration, PKCE, refresh and issuer-bound
  credentials use the SDK. Providers requiring a separately registered OAuth app
  may need provider-specific setup; arbitrary OAuth client-secret configuration
  is not exposed by this first UI.

## First use

1. Admin MCP tab: add an allowed HTTPS endpoint or select one from the catalog.
   Recommended is a display marker, separate from permission.
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

Admin and desktop share the backend catalog API, ten-minute cache and cursor
pagination over the official Registry. Each page requests latest versions and
filters inactive entries, unsupported transports and duplicate name/URL pairs.
Cards include version, publisher, endpoint and HTTPS links to the repository,
website and Registry record when supplied. Search uses the Registry's minimum
of three characters; pagination retains the submitted search.
Only remote Streamable HTTP entries are shown. Package installation commands
are never executed. Catalog metadata does not claim tools/resources support:
actual capabilities are read only after connecting to the server.

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
