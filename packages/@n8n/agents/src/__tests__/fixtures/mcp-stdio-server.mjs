/**
 * Minimal MCP server for stdio transport integration tests, serving MCP 2026-07-28
 * only. Spawned as a child process by mcp-stdio-transport.test.ts.
 * Run with: node mcp-stdio-server.mjs
 */
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// 1×1 transparent PNG in base64 (smallest valid PNG)
const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function createServer() {
	const server = new McpServer({ name: 'test-stdio-server', version: '1.0.0' });
	server.registerTool(
		'echo',
		{
			description: 'Echo the message back as-is',
			inputSchema: fromJsonSchema({
				type: 'object',
				properties: { message: { type: 'string', description: 'Message to echo' } },
				required: ['message'],
				additionalProperties: false,
				$schema: 'http://json-schema.org/draft-07/schema#',
			}),
		},
		async ({ message }) => ({ content: [{ type: 'text', text: String(message ?? '') }] }),
	);
	server.registerTool(
		'add',
		{
			description: 'Add two numbers together',
			inputSchema: fromJsonSchema({
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
		async ({ a, b }) => ({
			content: [{ type: 'text', text: String(Number(a ?? 0) + Number(b ?? 0)) }],
		}),
	);
	server.registerTool(
		'image',
		{
			description: 'Return a small image with a caption',
			inputSchema: fromJsonSchema({
				type: 'object',
				properties: { caption: { type: 'string', description: 'Image caption' } },
				required: ['caption'],
				additionalProperties: false,
				$schema: 'http://json-schema.org/draft-07/schema#',
			}),
		},
		async ({ caption }) => ({
			content: [
				{ type: 'text', text: String(caption ?? '') },
				{ type: 'image', data: TINY_PNG, mimeType: 'image/png' },
			],
		}),
	);
	return server;
}

serveStdio(createServer, { legacy: 'reject' });
