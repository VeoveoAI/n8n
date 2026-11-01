/**
 * In-process MCP test server helpers.
 * Creates real MCP servers bound to random localhost ports for use in integration
 * tests. Each serves MCP 2026-07-28 only and refuses the 2025-era handshake, as every
 * server the client connects to must. No mocking of SDK internals.
 */

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import http from 'http';

/** 1×1 transparent PNG in base64 (smallest valid PNG). Used for image tool tests. */
export const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface TestServer {
	url: string;
	close: () => Promise<void>;
}

/** Create an in-process MCP Server with three test tools: echo, add, and image. */
export function createTestMcpServer(): McpServer {
	const server = new McpServer({ name: 'test-mcp-server', version: '1.0.0' });
	server.registerTool(
		'echo',
		{
			description: 'Echo the message back as-is',
			inputSchema: fromJsonSchema<{ message: string }>({
				type: 'object',
				properties: { message: { type: 'string', description: 'Message to echo' } },
				required: ['message'],
				additionalProperties: false,
				$schema: 'http://json-schema.org/draft-07/schema#',
			}),
		},
		async ({ message }) => ({ content: [{ type: 'text', text: message }] }),
	);
	server.registerTool(
		'add',
		{
			description: 'Add two numbers together',
			inputSchema: fromJsonSchema<{ a: number; b: number }>({
				type: 'object',
				properties: {
					a: { type: 'number', description: 'First number' },
					b: { type: 'number', description: 'Second number' },
				},
				required: ['a', 'b'],
				additionalProperties: false,
				$schema: 'http://json-schema.org/draft-07/schema#',
			}),
		},
		async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
	);
	server.registerTool(
		'image',
		{
			description: 'Return a small image with a caption',
			inputSchema: fromJsonSchema<{ caption: string }>({
				type: 'object',
				properties: { caption: { type: 'string', description: 'Image caption' } },
				required: ['caption'],
				additionalProperties: false,
				$schema: 'http://json-schema.org/draft-07/schema#',
			}),
		},
		async ({ caption }) => ({
			content: [
				{ type: 'text', text: caption },
				{ type: 'image', data: TINY_PNG, mimeType: 'image/png' },
			],
		}),
	);

	return server;
}

async function listen(httpServer: http.Server, path: string): Promise<TestServer> {
	await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const { port } = httpServer.address() as { port: number };

	return {
		url: `http://127.0.0.1:${port}${path}`,
		close: async () => {
			httpServer.closeAllConnections();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

/**
 * Start a Streamable HTTP MCP server on a random port, serving MCP 2026-07-28 only.
 * Returns the endpoint URL and a close function.
 */
export async function startStreamableHttpServer(): Promise<TestServer> {
	// The handler builds a fresh server per request and refuses 2025-era requests.
	const handler = toNodeHandler(
		createMcpHandler(() => createTestMcpServer(), { legacy: 'reject' }),
	);
	const httpServer = http.createServer(async (req, res) => {
		try {
			await handler(req, res);
		} catch {
			if (!res.headersSent) res.writeHead(500).end('Internal server error');
		}
	});
	return await listen(httpServer, '/mcp');
}

/**
 * Start an HTTP server that answers every JSON-RPC request with "method not found", as a
 * 2025-era server answers `server/discover`: it offers no MCP 2026-07-28.
 */
export async function startServerWithoutModernRevision(): Promise<TestServer> {
	const httpServer = http.createServer((req, res) => {
		let body = '';
		req.on('data', (chunk: Buffer) => (body += chunk.toString()));
		req.on('end', () => {
			let id: unknown = null;
			try {
				id = (JSON.parse(body) as { id?: unknown }).id ?? null;
			} catch {
				// Not JSON: answer with a null id.
			}
			res.writeHead(200, { 'content-type': 'application/json' }).end(
				JSON.stringify({
					jsonrpc: '2.0',
					id,
					error: { code: -32601, message: 'Method not found' },
				}),
			);
		});
	});
	return await listen(httpServer, '/mcp');
}
