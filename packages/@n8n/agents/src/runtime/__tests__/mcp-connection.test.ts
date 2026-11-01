import { McpClient } from '../../sdk/mcp-client';
import { McpConnection } from '../mcp/mcp-connection';
import { executeTool } from '../tools/tool-adapter';

const clientCtor = vi.fn();
const sseCtor = vi.fn();
const streamableHttpCtor = vi.fn();
const stdioCtor = vi.fn();

const clientConnect = vi.fn().mockResolvedValue(undefined);
const clientListTools = vi.fn().mockResolvedValue({
	tools: [
		{ name: 'echo', description: '', inputSchema: { type: 'object' } },
		{ name: 'add', description: '', inputSchema: { type: 'object' } },
		{ name: 'subtract', description: '', inputSchema: { type: 'object' } },
	],
});
const clientCallTool = vi.fn().mockResolvedValue({ content: [] });
const clientClose = vi.fn().mockResolvedValue(undefined);

class FakeClient {
	connect = clientConnect;
	listTools = clientListTools;
	callTool = clientCallTool;
	close = clientClose;
}

vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
	...(await importOriginal()),
	Client: vi.fn(function (info: unknown, options: unknown) {
		clientCtor(info, options);
		return new FakeClient();
	}),
	SSEClientTransport: vi.fn(function (url: URL, options: unknown) {
		sseCtor(url, options);
		return { type: 'sse', url, options };
	}),
	StreamableHTTPClientTransport: vi.fn(function (url: URL, options: unknown) {
		streamableHttpCtor(url, options);
		return { type: 'streamableHttp', url, options };
	}),
}));

vi.mock('@modelcontextprotocol/client/stdio', () => ({
	StdioClientTransport: vi.fn(function (options: unknown) {
		stdioCtor(options);
		return { type: 'stdio', options };
	}),
}));

/** The error the Streamable HTTP transport raises when the server answers `status`. */
async function httpError(status: number) {
	const { SdkErrorCode, SdkHttpError } = await import('@modelcontextprotocol/client');
	return new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing to endpoint', {
		status,
	});
}

/** The `versionNegotiation` each client was created with, in order. */
function negotiations() {
	return (clientCtor.mock.calls as Array<[unknown, { versionNegotiation?: unknown }]>).map(
		([, options]) => options.versionNegotiation,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpConnection — custom fetch forwarding', () => {
	beforeEach(() => {
		clientCtor.mockClear();
		sseCtor.mockClear();
		streamableHttpCtor.mockClear();
		stdioCtor.mockClear();
		clientConnect.mockReset().mockResolvedValue(undefined);
		clientClose.mockReset().mockResolvedValue(undefined);
		clientListTools.mockClear();
	});

	it('forwards `fetch` to StreamableHTTPClientTransport when provided', async () => {
		const customFetch = vi.fn();
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			fetch: customFetch as unknown as typeof fetch,
		});

		await conn.connect();

		expect(streamableHttpCtor).toHaveBeenCalledTimes(1);
		const [, options] = streamableHttpCtor.mock.calls[0] as [URL, { fetch?: typeof fetch }];
		expect(options.fetch).toBe(customFetch);
	});

	it('uses Streamable HTTP for an unconfigured URL', async () => {
		const conn = new McpConnection({ name: 'default', url: 'https://example.test/mcp' });
		await conn.connect();
		expect(streamableHttpCtor).toHaveBeenCalledTimes(1);
		expect(sseCtor).not.toHaveBeenCalled();
	});

	it('offers MCP 2026-07-28 first over Streamable HTTP and stdio, with the 2025 handshake as fallback', async () => {
		await new McpConnection({ name: 'http', url: 'https://example.test/mcp' }).connect();
		await new McpConnection({ name: 'stdio', command: 'node', args: ['server.mjs'] }).connect();
		expect(negotiations()).toEqual([{ mode: 'auto' }, { mode: 'auto' }]);
	});

	it('uses the 2025 handshake alone over SSE', async () => {
		await new McpConnection({
			name: 'sse',
			url: 'https://example.test/sse',
			transport: 'sse',
		}).connect();
		expect(negotiations()).toEqual([undefined]);
	});

	it('retries a legacy SSE endpoint when Streamable HTTP is unsupported', async () => {
		clientConnect.mockRejectedValueOnce(await httpError(404));
		const conn = new McpConnection({ name: 'legacy', url: 'https://example.test/sse' });
		await conn.connect();
		expect(streamableHttpCtor).toHaveBeenCalledTimes(1);
		expect(sseCtor).toHaveBeenCalledTimes(1);
		expect(clientClose).toHaveBeenCalled();
		expect(negotiations()).toEqual([{ mode: 'auto' }, undefined]);
	});

	it('does not retry over SSE when the server refuses authorization', async () => {
		clientConnect.mockRejectedValueOnce(await httpError(401));
		const conn = new McpConnection({ name: 'private', url: 'https://example.test/mcp' });
		await expect(conn.connect()).rejects.toThrow('Error POSTing to endpoint');
		expect(sseCtor).not.toHaveBeenCalled();
	});

	it('shares the connection timeout with the SSE retry', async () => {
		const notFound = await httpError(404);
		vi.useFakeTimers();
		try {
			clientConnect
				.mockImplementationOnce(async () => {
					await new Promise((resolve) => setTimeout(resolve, 90));
					throw notFound;
				})
				.mockImplementationOnce(async () => await new Promise<void>(() => {}));
			const conn = new McpConnection({
				name: 'legacy',
				url: 'https://example.test/sse',
				connectionTimeoutMs: 100,
			});

			const connecting = conn.connect();
			await vi.advanceTimersByTimeAsync(90);
			expect(sseCtor).toHaveBeenCalledTimes(1);
			const timedOut = expect(connecting).rejects.toThrow('connection timed out after 100ms');
			await vi.advanceTimersByTimeAsync(10);
			await timedOut;
			expect(clientConnect).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('forwards `fetch` to SSEClientTransport and to its eventSourceInit when provided', async () => {
		const customFetch = vi.fn();
		const conn = new McpConnection({
			name: 's2',
			url: 'https://example.test/mcp',
			transport: 'sse',
			fetch: customFetch as unknown as typeof fetch,
		});

		await conn.connect();

		expect(sseCtor).toHaveBeenCalledTimes(1);
		const [, options] = sseCtor.mock.calls[0] as [
			URL,
			{ fetch?: typeof fetch; eventSourceInit?: { fetch?: typeof fetch } },
		];
		expect(options.fetch).toBe(customFetch);
		expect(options.eventSourceInit?.fetch).toBe(customFetch);
	});

	it('omits `fetch` and `eventSourceInit` when no custom fetch is provided', async () => {
		const conn = new McpConnection({
			name: 's3',
			url: 'https://example.test/mcp',
			transport: 'sse',
		});

		await conn.connect();

		expect(sseCtor).toHaveBeenCalledTimes(1);
		const [, options] = sseCtor.mock.calls[0] as [
			URL,
			{ fetch?: typeof fetch; eventSourceInit?: { fetch?: typeof fetch } },
		];
		expect(options.fetch).toBeUndefined();
		expect(options.eventSourceInit).toBeUndefined();
	});
});

describe('McpClient — connection failure handling', () => {
	beforeEach(() => {
		clientConnect.mockReset();
		clientListTools.mockReset();
		clientClose.mockReset();
	});

	it('skips a failing server, records the failure, and keeps the run going', async () => {
		clientConnect.mockRejectedValueOnce(
			new TypeError('fetch failed', {
				cause: new Error('The request was blocked because it resolves to a restricted IP address'),
			}),
		);

		const client = new McpClient([
			{
				name: 'custom_mcp',
				url: 'http://localhost:5678/mcp/my-mcp-server',
				transport: 'streamableHttp',
			},
		]);

		// The run is NOT aborted — listTools resolves with an empty tool list
		// (the failing server contributed nothing).
		const tools = await client.listTools();
		expect(tools).toEqual([]);

		// The failure is recorded with the nested cause flattened in.
		expect(client.getConnectionFailures()).toEqual([
			{
				server: 'custom_mcp',
				error:
					'fetch failed. The request was blocked because it resolves to a restricted IP address',
			},
		]);
	});

	it('invokes onConnectionFailed for each failing server', async () => {
		clientConnect.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));

		clientListTools.mockResolvedValueOnce({
			tools: [{ name: 'echo', description: '', inputSchema: { type: 'object' } }],
		});

		const onConnectionFailed = vi.fn();
		const client = new McpClient([
			{
				name: 'ok_server',
				url: 'https://example.test/mcp',
				transport: 'streamableHttp',
				onConnectionFailed,
			},
			{
				name: 'bad_server',
				url: 'https://example.test/mcp',
				transport: 'streamableHttp',
				onConnectionFailed,
			},
		]);

		const tools = await client.listTools();

		// Tools from the healthy server survive.
		expect(tools.map((t) => t.name)).toEqual(['ok_server_echo']);
		expect(onConnectionFailed).toHaveBeenCalledTimes(1);
		expect(onConnectionFailed).toHaveBeenCalledWith({
			server: 'bad_server',
			error: 'boom',
		});
		expect(client.getConnectionFailures()).toEqual([{ server: 'bad_server', error: 'boom' }]);
	});

	it('swallows a throwing onConnectionFailed observer', async () => {
		clientConnect.mockRejectedValueOnce(new Error('boom'));
		const onConnectionFailed = vi.fn().mockImplementation(() => {
			throw new Error('observer blew up');
		});

		const client = new McpClient([
			{
				name: 'custom_mcp',
				url: 'http://localhost:5678/mcp/my-mcp-server',
				transport: 'streamableHttp',
				onConnectionFailed,
			},
		]);

		// A faulty observer must not break the run.
		const tools = await client.listTools();
		expect(tools).toEqual([]);
		expect(client.getConnectionFailures()).toHaveLength(1);
	});

	it('disconnects a connection that connects but fails to list tools', async () => {
		// connect() succeeds, but listTools() throws. The connection opened a
		// transport, so it must be torn down rather than leaked for the run.
		clientConnect.mockResolvedValueOnce(undefined);
		clientListTools.mockRejectedValueOnce(new Error('listTools blew up'));

		const client = new McpClient([
			{ name: 'flaky', url: 'https://example.test/mcp', transport: 'streamableHttp' },
		]);

		const tools = await client.listTools();
		expect(tools).toEqual([]);
		expect(client.getConnectionFailures()).toEqual([
			{ server: 'flaky', error: 'listTools blew up' },
		]);
		// The transport that opened before listTools threw was closed.
		expect(clientClose).toHaveBeenCalledTimes(1);
	});

	it('retries a failed server on the next tool-list request', async () => {
		clientConnect
			.mockRejectedValueOnce(new Error('temporary failure'))
			.mockResolvedValue(undefined);
		clientListTools.mockResolvedValue({
			tools: [{ name: 'echo', description: '', inputSchema: { type: 'object' } }],
		});
		clientClose.mockResolvedValue(undefined);

		const client = new McpClient([
			{ name: 'flaky', url: 'https://example.test/mcp', transport: 'streamableHttp' },
		]);

		expect(await client.listTools()).toEqual([]);
		const tools = await client.listTools();

		expect(tools.map((tool) => tool.name)).toEqual(['flaky_echo']);
		expect(clientConnect).toHaveBeenCalledTimes(2);
		expect(client.getConnectionFailures()).toEqual([]);
	});
});

describe('McpClient — tool name normalization', () => {
	beforeEach(() => {
		clientConnect.mockReset().mockResolvedValue(undefined);
		clientListTools.mockReset().mockResolvedValue({
			tools: [{ name: 'read', description: '', inputSchema: { type: 'object' } }],
		});
		clientClose.mockReset().mockResolvedValue(undefined);
	});

	it('keeps model-facing names unique across normalized server prefixes', async () => {
		const client = new McpClient([
			{ name: 'foo bar', url: 'https://example.test/first' },
			{ name: 'foo_bar', url: 'https://example.test/second' },
		]);

		const tools = await client.listTools();

		expect(new Set(tools.map((tool) => tool.name)).size).toBe(2);
		await client.close();
	});
});

describe('McpConnection - tool call settled callback', () => {
	beforeEach(() => {
		clientConnect.mockReset().mockResolvedValue(undefined);
		clientCallTool.mockReset();
	});

	it('reports completed MCP tool calls', async () => {
		const onToolCallSettled = vi.fn();
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			onToolCallSettled,
		});
		await conn.connect();

		clientCallTool
			.mockResolvedValueOnce({ content: [] })
			.mockResolvedValueOnce({ content: [], isError: true });

		await conn.callTool('echo', { message: 'ok' });
		await conn.callTool('echo', { message: 'bad' });

		expect(onToolCallSettled).toHaveBeenNthCalledWith(1, { toolName: 'echo', success: true });
		expect(onToolCallSettled).toHaveBeenNthCalledWith(2, { toolName: 'echo', success: false });
	});

	it('reports failed MCP tool calls', async () => {
		const onToolCallSettled = vi.fn();
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			onToolCallSettled,
		});
		await conn.connect();
		clientCallTool.mockRejectedValueOnce(new Error('boom'));

		await expect(conn.callTool('echo', { message: 'bad' })).rejects.toThrow('boom');

		expect(onToolCallSettled).toHaveBeenCalledWith({ toolName: 'echo', success: false });
	});

	it("lifts the protocol's reserved _meta keys out of a tool's result", async () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
		});
		await conn.connect();
		const serverInfo = { name: 'server', version: '1.0.0' };
		clientCallTool
			.mockResolvedValueOnce({
				content: [{ type: 'text', text: 'ok' }],
				_meta: { 'io.modelcontextprotocol/serverInfo': serverInfo, 'com.example/trace': 't1' },
			})
			.mockResolvedValueOnce({
				content: [{ type: 'text', text: 'ok' }],
				_meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
			});

		expect(await conn.callTool('echo', {})).toEqual({
			content: [{ type: 'text', text: 'ok' }],
			_meta: { 'com.example/trace': 't1' },
		});
		expect(await conn.callTool('echo', {})).toEqual({ content: [{ type: 'text', text: 'ok' }] });
	});

	it('passes resetTimeoutOnProgress: true to the SDK client so stalled calls die at the idle deadline', async () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
		});
		await conn.connect();
		clientCallTool.mockResolvedValueOnce({ content: [] });

		await conn.callTool('echo', { message: 'ok' });

		expect(clientCallTool).toHaveBeenCalledTimes(1);
		const callArgs = clientCallTool.mock.calls[0];
		// callTool(request, options)
		const options = callArgs[1] as { resetTimeoutOnProgress?: boolean };
		expect(options.resetTimeoutOnProgress).toBe(true);
	});

	it('forwards abortSignal alongside resetTimeoutOnProgress when provided', async () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
		});
		await conn.connect();
		clientCallTool.mockResolvedValueOnce({ content: [] });

		const controller = new AbortController();
		await conn.callTool('echo', { message: 'ok' }, { abortSignal: controller.signal });

		const options = clientCallTool.mock.calls[0][1] as {
			signal?: AbortSignal;
			resetTimeoutOnProgress?: boolean;
		};
		expect(options.signal).toBe(controller.signal);
		expect(options.resetTimeoutOnProgress).toBe(true);
	});
});

describe('McpConnection — tool filtering', () => {
	beforeEach(() => {
		clientConnect.mockClear();
		clientListTools.mockClear();
		clientCallTool.mockReset().mockResolvedValue({ content: [] });
		clientListTools.mockResolvedValue({
			tools: [
				{ name: 'echo', description: '', inputSchema: { type: 'object' } },
				{ name: 'add', description: '', inputSchema: { type: 'object' } },
				{ name: 'subtract', description: '', inputSchema: { type: 'object' } },
			],
		});
	});

	it('returns all tools when no filter is configured', async () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
		});

		await conn.connect();
		const tools = await conn.listTools();

		expect(tools.map((tool) => tool.name)).toEqual(['s1_echo', 's1_add', 's1_subtract']);
	});

	it('normalizes the model-facing prefix while preserving the MCP server name', async () => {
		const conn = new McpConnection({
			name: 'Linear Prod',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			requireApproval: ['echo'],
		});

		await conn.connect();
		const tools = await conn.listTools();

		expect(tools.map((tool) => tool.name)).toEqual([
			'Linear_Prod_echo',
			'Linear_Prod_add',
			'Linear_Prod_subtract',
		]);
		expect(tools.every((tool) => tool.mcpServerName === 'Linear Prod')).toBe(true);
		expect(tools).toEqual([
			expect.objectContaining({ mcpToolName: 'echo' }),
			expect.objectContaining({ mcpToolName: 'add' }),
			expect.objectContaining({ mcpToolName: 'subtract' }),
		]);
		expect(tools[0]?.suspendSchema).toBeDefined();
		expect(tools[1]?.suspendSchema).toBeUndefined();
	});

	it('keeps model-facing names unique when tool names normalize identically', async () => {
		const onToolCallSettled = vi.fn();
		const rawTools = [
			{ name: 'read file', description: '', inputSchema: { type: 'object' } },
			{ name: 'read_file', description: '', inputSchema: { type: 'object' } },
		];
		clientListTools
			.mockResolvedValueOnce({ tools: rawTools })
			.mockResolvedValueOnce({ tools: [...rawTools].reverse() });

		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			onToolCallSettled,
		});

		await conn.connect();
		const tools = await conn.listTools();
		const reversedTools = await conn.listTools();

		expect(new Set(tools.map((tool) => tool.name)).size).toBe(2);
		expect(tools.map((tool) => tool.name)).toEqual([
			reversedTools[1]?.name,
			reversedTools[0]?.name,
		]);
		await executeTool({}, tools[0]);
		await executeTool({}, tools[1]);
		expect(onToolCallSettled).toHaveBeenNthCalledWith(1, {
			toolName: 'read file',
			modelToolName: tools[0].name,
			success: true,
		});
		expect(onToolCallSettled).toHaveBeenNthCalledWith(2, {
			toolName: 'read_file',
			modelToolName: tools[1].name,
			success: true,
		});
	});

	it('keeps model-facing names unique when truncation removes the differing suffix', async () => {
		const sharedPrefix = 'a'.repeat(80);
		const rawTools = [
			{ name: `${sharedPrefix}x`, description: '', inputSchema: { type: 'object' } },
			{ name: `${sharedPrefix}y`, description: '', inputSchema: { type: 'object' } },
		];
		clientListTools
			.mockResolvedValueOnce({ tools: rawTools })
			.mockResolvedValueOnce({ tools: [...rawTools].reverse() });

		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
		});

		await conn.connect();
		const tools = await conn.listTools();
		const reversedTools = await conn.listTools();

		expect(new Set(tools.map((tool) => tool.name)).size).toBe(2);
		expect(tools.every((tool) => tool.name.length <= 64)).toBe(true);
		expect(tools.map((tool) => tool.name)).toEqual([
			reversedTools[1]?.name,
			reversedTools[0]?.name,
		]);
	});

	it('keeps only allowed tools when allow filter is configured', async () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			toolFilter: { mode: 'allow', tools: ['echo', 'subtract'] },
		});

		await conn.connect();
		const tools = await conn.listTools();

		expect(tools.map((tool) => tool.name)).toEqual(['s1_echo', 's1_subtract']);
	});

	it('removes excluded tools when exclude filter is configured', async () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			toolFilter: { mode: 'exclude', tools: ['add'] },
		});

		await conn.connect();
		const tools = await conn.listTools();

		expect(tools.map((tool) => tool.name)).toEqual(['s1_echo', 's1_subtract']);
	});

	it('returns no tools for allow mode with an empty list', async () => {
		const allowConn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			toolFilter: { mode: 'allow', tools: [] },
		});
		await allowConn.connect();
		const allowTools = await allowConn.listTools();

		expect(allowTools).toHaveLength(0);
	});

	it('keeps all tools for exclude mode with an empty list', async () => {
		const excludeConn = new McpConnection({
			name: 's2',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
			toolFilter: { mode: 'exclude', tools: [] },
		});
		await excludeConn.connect();
		const excludeTools = await excludeConn.listTools();

		expect(excludeTools.map((tool) => tool.name)).toEqual(['s2_echo', 's2_add', 's2_subtract']);
	});
});

describe('McpConnection — reconnect after disconnect', () => {
	beforeEach(() => {
		clientConnect.mockClear();
		clientClose.mockClear().mockResolvedValue(undefined);
	});

	it('tears down the new client when reconnected after a disconnect', async () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			transport: 'streamableHttp',
		});

		await conn.connect();
		await conn.disconnect();
		// First disconnect closes the first client.
		expect(clientClose).toHaveBeenCalledTimes(1);

		// A retry (listTools() clears its cache on a hard error and re-runs)
		// creates a new client. The second disconnect must close THAT client,
		// not no-op because `closed` was left true by the first disconnect.
		await conn.connect();
		await conn.disconnect();
		expect(clientClose).toHaveBeenCalledTimes(2);
	});
});

describe('McpConnection — approval declaration', () => {
	it('declares approval when tool configuration is resolved after discovery', () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			configureTools: () => ({ requireApproval: [] }),
		});

		expect(conn.declaresApproval()).toBe(true);
	});

	it('does not declare approval for non-interrupting tool configuration', () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			configureTools: () => ({ toolFilter: { mode: 'exclude', tools: ['x'] } }),
			configureToolsNonInterrupting: true,
		});

		expect(conn.declaresApproval()).toBe(false);
	});

	it('ignores the non-interrupting flag when there is no tool configuration', () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			configureToolsNonInterrupting: true,
		});

		expect(conn.declaresApproval()).toBe(false);
	});

	it('still declares approval for a static requireApproval with non-interrupting tool configuration', () => {
		const conn = new McpConnection({
			name: 's1',
			url: 'https://example.test/mcp',
			configureTools: () => ({}),
			configureToolsNonInterrupting: true,
			requireApproval: ['delete'],
		});

		expect(conn.declaresApproval()).toBe(true);
	});
});
