/**
 * The client speaks MCP 2026-07-28 only: a server whose `server/discover` does not
 * offer it fails the connection, and the SSE transport, which cannot carry it, is
 * refused before anything is sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServerWithoutModernRevision, type TestServer } from './mcp-server-helpers';
import { MCP_PROTOCOL_VERSION, McpConnection } from '../../runtime/mcp/mcp-connection';

describe('McpConnection — the pinned protocol revision', () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await startServerWithoutModernRevision();
	});

	afterAll(async () => {
		await server.close();
	});

	it('pins MCP 2026-07-28', () => {
		expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28');
	});

	it('fails to connect to a server that does not offer MCP 2026-07-28', async () => {
		const conn = new McpConnection({ name: 'old', url: server.url, connectionTimeoutMs: 5_000 });
		await expect(conn.connect()).rejects.toThrow();
	});

	it('refuses the SSE transport', async () => {
		const conn = new McpConnection({ name: 'sse', url: server.url, transport: 'sse' });
		await expect(conn.connect()).rejects.toThrow('the SSE transport cannot carry MCP 2026-07-28');
	});
});
