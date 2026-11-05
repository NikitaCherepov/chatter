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
2. Set the global custom-URL permission. User cards can override it with
   inherit / allow / deny. Global MCP disable always wins.
3. Desktop Settings → MCP: create a personal connection, add a bearer token or
   authorize with OAuth, then refresh tools.
4. Select tools and choose eager injection or on-demand discovery.

## Execution

- The existing function-tool pipeline, task allowlists and subagent tool grants
  are reused. Room runs use the initiating account's connections.
- A personal connection reuses its MCP session between calls so server-side state\n survives. Idle sessions close after ten minutes; errors or explicit cancellation\n close the affected session. The backend keeps at most 128 sessions.\n- Calls recheck current policy, connection state and tool selection.
  The existing disable-internet restriction also blocks MCP.
- Eager tools have stable, connection-specific names.
- `search_mcp_tools` returns authorized names, descriptions and input schemas only
  in its tool result. Search never changes the model function-tool definitions.
  The model then calls the permanent `call_mcp_tool` function using that schema.
- `call_mcp_tool` invokes a selected tool using its returned input schema.
- At most 32 MCP definitions are injected; additional tools remain searchable.
- Tool lists refresh explicitly. Limits: 20 connections per account, 200 tools
  per connection, three active operations per account and one per connection.
- Wait time is configurable, 10–3600 seconds without progress, default 300.
  Progress resets it; there is no additional total-duration cap.
  Chat Stop and Stop operation abort local waiting. They cannot guarantee that
  the remote service undoes an operation. Transport reconnection retries are off.
- Arguments are validated against JSON Schema. Text results use the existing
  untrusted-content wrapper; images can use the existing direct-vision sink.
  Other nontext content returns metadata. Resource/prompt browsing is not exposed.

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
pagination over the official Registry. Only remote Streamable HTTP entries are
shown. Package installation commands are never executed.

## Verification

- `pnpm exec tsx backend-api/tests/mcp.test.mts`: temporary SQLite and the real
  SDK HTTP transport against a local server; discovery/calls/schemas, account
  isolation, policies, encrypted secrets, cancellation, progress, sampling denial.
  OAuth tests use a local fake authorization service with the real SDK PKCE flow.
- `pnpm exec tsx desktop-app/tests/mcp-ui.test.mts`: actual React desktop/admin/
  user-card components in hidden Electron, with mocked APIs; toggles, query
  invalidation and catalog. Optional `MCP_UI_SCREENSHOT_DIR` saves screenshots.
- A separate real Registry request checks public HTTPS/DNS/TLS.
- These tests do not log into a real third-party account or verify deployment.
