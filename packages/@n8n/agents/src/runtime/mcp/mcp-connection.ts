/* eslint-disable @typescript-eslint/consistent-type-imports */
import type { CallToolResult } from '@modelcontextprotocol/client';

import { McpToolResolver } from './mcp-tool-resolver';
import { wrapToolForApproval } from '../../sdk/tool';
import type {
	McpServerConfig,
	McpToolCallSettledEvent,
	McpToolDescriptor,
	McpRequireApproval,
} from '../../types/sdk/mcp';
import type { BuiltTool } from '../../types/sdk/tool';

/** The raw result returned by an MCP tool call. */
export type McpCallToolResult = CallToolResult;

/**
 * The one MCP protocol revision this client speaks. Every connection pins it: the
 * server's `server/discover` must offer it, and a server that does not fails the
 * connection. There is no 2025-era `initialize` handshake and no fallback.
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/**
 * The prefix of the `_meta` keys MCP 2026-07-28 reserves for its per-message envelope.
 * A server stamps `io.modelcontextprotocol/serverInfo` on every result. Such keys describe
 * the exchange, not the tool's output: the SDK lifts them out of requests and
 * notifications, and {@link withoutProtocolEnvelope} lifts them out of a tool's result.
 */
const PROTOCOL_META_PREFIX = 'io.modelcontextprotocol/';

/** `result` without the protocol's reserved `_meta` keys; other `_meta` keys stay. */
function withoutProtocolEnvelope(result: McpCallToolResult): McpCallToolResult {
	if (!result._meta) return result;
	const { _meta: meta, ...rest } = result;
	const kept = Object.entries(meta).filter(([key]) => !key.startsWith(PROTOCOL_META_PREFIX));
	return kept.length > 0
		? { ...rest, _meta: Object.fromEntries(kept) as McpCallToolResult['_meta'] }
		: rest;
}

/**
 * Import the @modelcontextprotocol/client entry points. Every SDK type used in this
 * file is derived from this function's inferred return type, so module resolution
 * has a single source of truth: value-space dynamic imports resolve to the SDK's ESM
 * declarations under NodeNext, which static `import type` in this CommonJS-context
 * file would not.
 */
async function importMcpSdk() {
	const [{ Client, StreamableHTTPClientTransport }, { StdioClientTransport }] = await Promise.all([
		import('@modelcontextprotocol/client'),
		import('@modelcontextprotocol/client/stdio'),
	]);
	return { Client, StreamableHTTPClientTransport, StdioClientTransport };
}

type McpSdkModule = Awaited<ReturnType<typeof importMcpSdk>>;
type McpClient = InstanceType<McpSdkModule['Client']>;
type McpTransport =
	| InstanceType<McpSdkModule['StreamableHTTPClientTransport']>
	| InstanceType<McpSdkModule['StdioClientTransport']>;

let mcpSdkPromise: Promise<McpSdkModule> | undefined;

/**
 * Load the @modelcontextprotocol/client entry points on first use. Deferred so the
 * agents module's startup cost stays low: the SDK is only needed once a user
 * actually configures an MCP server.
 */
async function loadMcpSdk(): Promise<McpSdkModule> {
	mcpSdkPromise ??= importMcpSdk();
	return await mcpSdkPromise;
}

function applyToolFilter<T extends { name: string }>(
	tools: T[],
	toolFilter: McpServerConfig['toolFilter'],
): T[] {
	if (!toolFilter?.mode || !toolFilter?.tools) {
		return tools;
	}

	const filterSet = new Set(toolFilter.tools);
	if (toolFilter.mode === 'allow') {
		return tools.filter((tool) => filterSet.has(tool.name));
	} else if (toolFilter.mode === 'exclude') {
		return tools.filter((tool) => !filterSet.has(tool.name));
	}

	// Return tools as-is if `mode` is not `'allow' | 'exclude'` for some reason
	return tools;
}

/** Wraps a single MCP SDK Client instance for one server. Not publicly exported. */
export class McpConnection {
	private client: McpClient | undefined;

	private config: McpServerConfig;

	private connectionPromise: Promise<void> | undefined = undefined;
	private disconnectPromise: Promise<void> | undefined = undefined;
	private closed = false;

	constructor(config: McpServerConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connectionPromise !== undefined) {
			return await this.connectionPromise;
		}
		// Starting a fresh connection (the initial connect, or a retry after a
		// prior disconnect cleared `connectionPromise`). Reset the closed
		// flag so a subsequent disconnect() can tear down the new client —
		// otherwise a reconnect after disconnect would leave the new transport
		// open (doDisconnect() no-ops while `closed` is true).
		this.closed = false;
		this.disconnectPromise = undefined;
		const connectionPromise = this.doConnect();
		this.connectionPromise = connectionPromise;
		try {
			await connectionPromise;
		} catch (error) {
			if (this.connectionPromise === connectionPromise) this.connectionPromise = undefined;
			throw error;
		}
	}

	private async doConnect(): Promise<void> {
		const sdk = await loadMcpSdk();
		this.client = new sdk.Client(
			{ name: '@n8n/agents', version: '0.1.0' },
			{ capabilities: {}, versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
		);
		await this.connectWithTransport(this.createTransport(this.config, sdk));
	}

	private async connectWithTransport(transport: McpTransport): Promise<void> {
		if (!this.client) throw new Error('MCP client not initialized; connect() must be called first');
		const client = this.client;
		const timeoutMs = this.config.connectionTimeoutMs;
		if (timeoutMs === undefined) {
			await client.connect(transport);
			return;
		}
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error(
				`MCP server "${this.config.name}": connectionTimeoutMs must be a positive finite number`,
			);
		}
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				client.connect(transport),
				new Promise<never>((_, reject) => {
					timeoutId = setTimeout(() => {
						reject(
							new Error(
								`MCP server "${this.config.name}": connection timed out after ${timeoutMs}ms`,
							),
						);
					}, timeoutMs);
				}),
			]);
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
		}
	}

	/** List tools from the server, resolving them into BuiltTool instances with prefixed names. */
	async listTools(): Promise<BuiltTool[]> {
		if (!this.client) throw new Error('MCP client not initialized; connect() must be called first');
		const result = await this.client.listTools();
		const descriptors: McpToolDescriptor[] = result.tools.map((tool) => ({
			name: tool.name,
			...(tool.annotations ? { annotations: tool.annotations } : {}),
		}));
		const configured = this.config.configureTools?.(descriptors);
		const toolFilter = configured?.toolFilter ?? this.config.toolFilter;
		const requireApproval = configured?.requireApproval ?? this.config.requireApproval;
		const resolver = new McpToolResolver();
		const filteredRawTools = applyToolFilter(result.tools, toolFilter);
		const tools = resolver.resolve(this, filteredRawTools);
		return tools.map((t) =>
			t.suspendSchema || !this.shouldRequireToolApproval(t, requireApproval)
				? t
				: wrapToolForApproval(t, { requireApproval: true }),
		);
	}

	/**
	 * Returns true when a resolved tool should be wrapped with an approval gate.
	 *
	 * A tool needs approval when either:
	 * - `config.requireApproval` is `true` (all tools on this server), OR
	 * - `config.requireApproval` is a string array that includes the tool's original (un-prefixed) name.
	 */
	private shouldRequireToolApproval(
		tool: BuiltTool,
		requireApproval: McpRequireApproval | undefined,
	): boolean {
		if (requireApproval === true) return true;

		if (Array.isArray(requireApproval) && requireApproval.length > 0) {
			const originalName = tool.mcpToolName ?? tool.name;
			return requireApproval.includes(originalName);
		}

		return false;
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		options?: { abortSignal?: AbortSignal; modelToolName?: string },
	): Promise<McpCallToolResult> {
		if (!this.client) throw new Error('MCP client not initialized; connect() must be called first');
		try {
			const result = withoutProtocolEnvelope(
				await this.client.callTool(
					{ name, arguments: args },
					{
						...(options?.abortSignal ? { signal: options.abortSignal } : {}),
						// Reset the SDK's idle timeout on progress notifications so a
						// long-running MCP call that streams progress stays alive, while
						// a stalled call (no progress) dies at the idle deadline.
						resetTimeoutOnProgress: true,
					},
				),
			);
			await this.notifyToolCallSettled({
				toolName: name,
				...(options?.modelToolName !== undefined && { modelToolName: options.modelToolName }),
				success: result.isError !== true,
			});
			return result;
		} catch (error) {
			await this.notifyToolCallSettled({
				toolName: name,
				...(options?.modelToolName !== undefined && { modelToolName: options.modelToolName }),
				success: false,
			});
			throw error;
		}
	}

	private async notifyToolCallSettled(event: McpToolCallSettledEvent): Promise<void> {
		try {
			await this.config.onToolCallSettled?.(event);
		} catch (error) {
			console.error(`MCP tool call observer error for server "${this.config.name}":`, error);
		}
	}

	async disconnect(): Promise<void> {
		if (this.disconnectPromise) return await this.disconnectPromise;
		const promise = this.doDisconnect();
		this.disconnectPromise = promise;
		return await promise.finally(() => {
			if (this.disconnectPromise === promise) this.disconnectPromise = undefined;
		});
	}

	private async doDisconnect(): Promise<void> {
		if (this.closed) return;
		if (this.client) await this.client.close();
		this.connectionPromise = undefined;
		this.closed = true;
	}

	get name(): string {
		return this.config.name;
	}

	/**
	 * Returns true when this server's config declares per-server approval requirements
	 * without requiring a network connection.
	 */
	declaresApproval(): boolean {
		const { configureTools, configureToolsNonInterrupting, requireApproval } = this.config;
		return (
			(configureTools !== undefined && !configureToolsNonInterrupting) ||
			requireApproval === true ||
			(Array.isArray(requireApproval) && requireApproval.length > 0)
		);
	}

	private createTransport(config: McpServerConfig, sdk: McpSdkModule): McpTransport {
		if (config.command) {
			return new sdk.StdioClientTransport({
				command: config.command,
				args: config.args,
				env: config.env,
			});
		} else if (config.url) {
			// The SSE transport predates the protocol revision every connection pins.
			if (config.transport === 'sse') {
				throw new Error(
					`MCP server "${config.name}": the SSE transport cannot carry MCP ${MCP_PROTOCOL_VERSION}; use Streamable HTTP`,
				);
			}
			const requestInit: RequestInit | undefined = config.headers
				? { headers: config.headers }
				: undefined;
			return new sdk.StreamableHTTPClientTransport(new URL(config.url), {
				requestInit,
				fetch: config.fetch,
			});
		}
		throw new Error(`MCP server "${config.name}": provide either "url" or "command"`);
	}
}
