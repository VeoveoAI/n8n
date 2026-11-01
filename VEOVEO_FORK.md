# VeoveoAI Fork

This fork carries Veoveo changes on the `veoveo` branch over an upstream n8n release
(`upstream` = `https://github.com/n8n-io/n8n`).

- Current upstream base: release `n8n@2.46.0` (`17d3934e42`).
- Each change is the smallest one that closes a verified gap. Changes stay in this fork;
  they are not offered upstream.
- Update this file whenever a fork change is added, changed or retired.

## Updating To A New Release

1. Fetch the release tag from `upstream` and replay the changes below onto it in a new
   branch.
2. For each change, first check whether upstream now does the same. If it does, drop the
   change and record that here.
3. Run each change's check, then update the base above.

## Carried

### Schema check before `CREATE SCHEMA`

- `packages/@n8n/typeorm/src/driver/postgres/PostgresDriver.ts`: `afterConnect` checks
  `pg_catalog.pg_namespace` for the configured schema and runs
  `CREATE SCHEMA IF NOT EXISTS` only when the schema is missing.
- Why: PostgreSQL checks the CREATE privilege on the database before it applies
  `IF NOT EXISTS`. A Veoveo server's login owns its schema through its group role and
  has no CREATE privilege on the database, so unmodified n8n cannot connect: it stays
  at "Initializing n8n process"
  ([record](https://github.com/VeoveoAI/veoveo-docs/blob/main/records/2026-10-30-n8n-containment-spike.md)).
- Check: n8n starts against a schema that its login's group role owns, with no CREATE
  privilege on the database, and creates its tables there.

### A home for each sandbox: `N8N_SANDBOX_SERVICE_HOMES`

- `packages/@n8n/agents/src/workspace/sandbox/workspace-root.ts`: `getN8nSandboxHome`
  returns `/home/user` as before, or, when `N8N_SANDBOX_SERVICE_HOMES` names a
  directory, `{N8N_SANDBOX_SERVICE_HOMES}/{sandbox id}`. `getSandboxHome` and
  `getPromptWorkspaceRoot` take the sandbox's id for it. The n8n-sandbox adapter's
  instructions and working directory, Instance AI's prompt root (the thread's sandbox
  id, `buildThreadScopedSandboxUuid`) and the agents module's sandbox and knowledge
  paths pass the id.
- Why: n8n's sandbox service runs each sandbox in its own container, whose home is
  `/home/user`, and n8n states that path in the Assistant's prompt. In a person's
  Computer, `veoveo-n8n-computer` serves the same API on loopback and keeps each sandbox
  in a directory of the person's home, `$HOME/n8n/.sandboxes/{id}`, with commands run
  as the person. The prompt's root must be the root the commands and file calls use: the
  scoped workspace refuses an absolute path outside it.
- Check: `@n8n/agents` `workspace-root.test.ts` and `n8n-sandbox-sandbox.test.ts`; with
  the variable set, the Assistant's prompt names the sandbox's own workspace and its
  commands run there.

### MCP 2026-07-28 only in `@n8n/agents`' MCP client

- `packages/@n8n/agents/src/runtime/mcp/mcp-connection.ts`: `McpConnection` uses
  `@modelcontextprotocol/client` 2.4.0 instead of `@modelcontextprotocol/sdk` 1.31.0.
  Every connection pins MCP `2026-07-28`
  (`versionNegotiation: { mode: { pin: '2026-07-28' } }`): the client discovers the
  server with `server/discover`, and a server that does not offer that revision fails
  the connection. There is no 2025-era `initialize` handshake and no fallback. Streamable
  HTTP and stdio carry it; a server configured with `transport: 'sse'` is refused, and an
  unconfigured URL is no longer retried over SSE. `callTool` takes the 2.x client's
  result type without a result schema, and lifts the protocol's reserved `_meta` keys
  (`io.modelcontextprotocol/…`, such as the `serverInfo` a 2026-07-28 server stamps on
  every result) out of the result, as the SDK lifts them out of requests and
  notifications: they describe the exchange, not the tool's output, and stay out of the
  model's context. The tests' servers (`mcp-server-helpers.ts`,
  `fixtures/mcp-stdio-server.mjs`) use `@modelcontextprotocol/server` 2.3.0 with
  `legacy: 'reject'`, and `mcp-protocol-version.test.ts` checks the pin, the failure
  against a server without `2026-07-28`, and the SSE refusal.
- Why: the Veoveo platform speaks MCP `2026-07-28` only. SDK 1.31.0 negotiates up to
  `2025-11-25`, so Instance AI, the agents module and every other `McpClient` user
  could not reach a Hub MCP endpoint at the platform's revision.
- Scope: this is the MCP client of Instance AI (`N8N_INSTANCE_AI_MCP_SERVERS` and the
  MCP registry) and of the agents module. The MCP nodes of `@n8n/n8n-nodes-langchain`
  (`McpClientTool`, `McpClient`, `McpRegistryClientTool` and the Microsoft vendor nodes)
  keep their own SDK 1.31.0 client.
- Check: `@n8n/agents` `mcp-connection.test.ts` and the MCP integration tests
  (`mcp-protocol-version`, `mcp-streamable-http-transport`, `mcp-stdio-transport`,
  `mcp-connection`, `mcp-client-boundary`, `mcp-runtime`); in a person's Computer, the
  Assistant lists and calls the person's Hub tools.

## Configuration, Not Changes

- **Table ownership:** n8n's PostgreSQL client (`pg` 8.21.0) reads `PGOPTIONS`, so
  `PGOPTIONS='-c role=server_<server>'` makes every connection take the server's group
  role, and n8n's tables belong to it instead of the per-registration login.
