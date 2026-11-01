/**
 * The client offers MCP 2026-07-28 first, through `server/discover`, and falls back to
 * the 2025 `initialize` handshake only when the server does not support it. An
 * authorization refusal or a network failure fails the connection without falling back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	startModernStreamableHttpServer,
	startSseServer,
	startStreamableHttpServer,
	startUnauthorizedServer,
	type TestServer,
} from './mcp-server-helpers';
import { McpConnection } from '../../runtime/mcp/mcp-connection';

interface RecordedRequest {
	method?: string;
	protocolVersion: string | null;
}

/** A fetch that records each JSON-RPC request's method and protocol version header. */
function recordingFetch(send: typeof fetch = fetch) {
	const requests: RecordedRequest[] = [];
	const recording = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body =
			typeof init?.body === 'string' ? (JSON.parse(init.body) as { method?: string }) : undefined;
		requests.push({
			method: body?.method,
			protocolVersion: new Headers(init?.headers).get('mcp-protocol-version'),
		});
		return await send(input, init);
	};
	return { requests, fetch: recording as typeof fetch };
}

describe('McpConnection — protocol version negotiation', () => {
	let modern: TestServer;
	let legacy: TestServer;
	let sse: TestServer;
	let unauthorized: TestServer;

	beforeAll(async () => {
		[modern, legacy, sse, unauthorized] = await Promise.all([
			startModernStreamableHttpServer(),
			startStreamableHttpServer(),
			startSseServer(),
			startUnauthorizedServer(),
		]);
	});

	afterAll(async () => {
		await Promise.all([modern, legacy, sse, unauthorized].map(async (s) => await s.close()));
	});

	it('negotiates MCP 2026-07-28 with a server that supports only it', async () => {
		const recorded = recordingFetch();
		const conn = new McpConnection({ name: 'modern', url: modern.url, fetch: recorded.fetch });
		await conn.connect();

		const tools = await conn.listTools();
		const result = await conn.callTool('echo', { message: 'hello' });
		await conn.disconnect();

		expect(tools.map((tool) => tool.name)).toEqual(['modern_echo']);
		// The server stamps its serverInfo in the result's _meta; the client lifts it out.
		expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
		const methods = recorded.requests.map((request) => request.method);
		expect(methods[0]).toBe('server/discover');
		expect(methods).not.toContain('initialize');
		expect(
			recorded.requests
				.filter((request) => request.method !== 'server/discover')
				.every((request) => request.protocolVersion === '2026-07-28'),
		).toBe(true);
	});

	it('falls back to the 2025 handshake with a server that does not support 2026-07-28', async () => {
		const recorded = recordingFetch();
		const conn = new McpConnection({ name: 'legacy', url: legacy.url, fetch: recorded.fetch });
		await conn.connect();

		const tools = await conn.listTools();
		const result = await conn.callTool('add', { a: 2, b: 3 });
		await conn.disconnect();

		expect(tools.map((tool) => tool.name)).toEqual(['legacy_echo', 'legacy_add', 'legacy_image']);
		expect(result).toEqual({ content: [{ type: 'text', text: '5' }] });
		const methods = recorded.requests.map((request) => request.method);
		expect(methods.slice(0, 2)).toEqual(['server/discover', 'initialize']);
	});

	it('retries an unconfigured URL over SSE when the server serves only SSE', async () => {
		const conn = new McpConnection({ name: 'sse', url: sse.url });
		await conn.connect();

		const tools = await conn.listTools();
		await conn.disconnect();

		expect(tools.map((tool) => tool.name)).toEqual(['sse_echo', 'sse_add', 'sse_image']);
	});

	it('does not fall back when the server refuses authorization', async () => {
		const recorded = recordingFetch();
		const conn = new McpConnection({
			name: 'unauthorized',
			url: unauthorized.url,
			fetch: recorded.fetch,
		});

		await expect(conn.connect()).rejects.toThrow();
		expect(recorded.requests.map((request) => request.method)).toEqual(['server/discover']);
	});

	it('does not fall back when the network fails', async () => {
		const recorded = recordingFetch(async () => {
			throw new TypeError('fetch failed');
		});
		const conn = new McpConnection({
			name: 'unreachable',
			url: 'http://127.0.0.1:1/mcp',
			fetch: recorded.fetch,
		});

		await expect(conn.connect()).rejects.toThrow();
		expect(recorded.requests.map((request) => request.method)).toEqual(['server/discover']);
	});
});
