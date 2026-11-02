/**
 * MCP Skills (SEP-2640) against a server of `@modelcontextprotocol/server` 2.4.0 that serves
 * them through its Skills extension. The skill files are synthetic fixture text.
 */
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
	SkillsExtension,
	skillEntry,
	type SkillSource,
} from '@modelcontextprotocol/server/ext/skills';
import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startStreamableHttpServer, type TestServer } from './mcp-server-helpers';
import { McpConnection } from '../../runtime/mcp/mcp-connection';
import { McpClient } from '../../sdk/mcp-client';

const markdown = (name: string, body: string) =>
	`---\nname: ${name}\ndescription: ${name} guidance\n---\n${body}`;

const skills: Record<string, Record<string, string>> = {
	'veoveo/home': { 'SKILL.md': markdown('home', 'Your home.\n') },
	'console/watch': {
		'SKILL.md': markdown('watch', 'Watch the branch.\n'),
		'references/status.md': 'Status codes.',
	},
};

/**
 * A 2026-07-28 server that serves `skills`, whose `tampered` URIs answer a read with other
 * text than their digest covers, and that records each file read.
 */
async function startSkillServer(tampered: Record<string, string> = {}) {
	const files = new Map<string, string>();
	for (const [path, entries] of Object.entries(skills))
		for (const [file, text] of Object.entries(entries)) files.set(`skill://${path}/${file}`, text);
	const entries = await Promise.all(
		Object.entries(skills).map(async ([path, entries]) => await skillEntry(path, entries)),
	);
	const reads: string[] = [];
	const source: SkillSource = {
		list: async () => await Promise.resolve({ skills: entries }),
		get: async (uri) => await Promise.resolve(entries.find((entry) => entry.uri === uri)),
		read: async (uri) => {
			reads.push(uri);
			const text = tampered[uri] ?? files.get(uri);
			return await Promise.resolve(
				text === undefined ? undefined : { text, mimeType: 'text/markdown' },
			);
		},
	};
	const extension = new SkillsExtension({ source });
	const handler = toNodeHandler(
		createMcpHandler(
			() => {
				const server = new McpServer(
					{ name: 'skills', version: '1.0.0' },
					{ instructions: 'Its skills say how: skill://console/watch/SKILL.md.' },
				);
				extension.attach(server);
				return server;
			},
			{ legacy: 'reject' },
		),
	);
	const httpServer = http.createServer(async (req, res) => {
		try {
			await handler(req, res);
		} catch {
			if (!res.headersSent) res.writeHead(500).end('Internal server error');
		}
	});
	await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const { port } = httpServer.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		reads,
		close: async () => {
			httpServer.closeAllConnections();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

describe('MCP Skills over a 2026-07-28 connection', () => {
	let server: Awaited<ReturnType<typeof startSkillServer>>;
	let tampering: Awaited<ReturnType<typeof startSkillServer>>;
	let legacy: TestServer;

	beforeAll(async () => {
		[server, tampering, legacy] = await Promise.all([
			startSkillServer(),
			// The same length, so only the digest tells.
			startSkillServer({
				'skill://console/watch/SKILL.md': markdown('watch', 'Watch the brench.\n'),
			}),
			startStreamableHttpServer(),
		]);
	});

	afterAll(async () => {
		await Promise.all([server, tampering, legacy].map(async (s) => await s.close()));
	});

	it("lists and reads verified skills and reads the server's instructions", async () => {
		const conn = new McpConnection({ name: 'veoveo', url: server.url });
		await conn.connect();
		const served = await conn.skills();
		expect(conn.instructions()).toBe('Its skills say how: skill://console/watch/SKILL.md.');
		const listed = await served!.list();
		expect(listed.map((skill) => skill.uri).sort()).toEqual([
			'skill://console/watch/SKILL.md',
			'skill://veoveo/home/SKILL.md',
		]);
		const watch = listed.find((skill) => skill.frontmatter.name === 'watch')!;
		expect((await served!.read(watch)).body).toBe('Watch the branch.\n');
		await expect(served!.read(watch, 'references/missing.md')).rejects.toThrow();
		await conn.disconnect();
	});

	it('offers no skills on a 2025 connection', async () => {
		const conn = new McpConnection({ name: 'legacy', url: legacy.url });
		await conn.connect();
		expect(await conn.skills()).toBeUndefined();
		await conn.disconnect();
	});

	it("serves a connected server's skills as one source, nothing read until a skill loads", async () => {
		const client = new McpClient([
			{ name: 'veoveo', url: server.url, skills: { approved: ['skill://veoveo/'] } },
		]);
		await client.listTools();
		const reads = server.reads.length;
		const source = await client.skillSource();
		expect(server.reads.length).toBe(reads);
		expect(
			source!.registry.skills.map((skill) => [
				skill.name,
				skill.sourceName,
				skill.origin?.approved,
			]),
		).toEqual([
			['home', 'veoveo', true],
			['watch', 'veoveo', false],
		]);
		const watch = source!.registry.skills[1];
		expect((await source!.loadSkill(watch.id))?.instructions).toBe('Watch the branch.\n');
		expect((await source!.loadFile?.(watch.id, 'references/status.md'))?.content).toBe(
			'Status codes.',
		);
		expect(client.instructions()).toEqual([
			{ server: 'veoveo', instructions: 'Its skills say how: skill://console/watch/SKILL.md.' },
		]);
		await client.close();
	});

	it('refuses a skill whose bytes do not match the digest its entry lists', async () => {
		const client = new McpClient([{ name: 'veoveo', url: tampering.url }]);
		await client.listTools();
		const source = await client.skillSource();
		const watch = source!.registry.skills.find((skill) => skill.name === 'watch')!;
		expect(await source!.loadSkill(watch.id)).toBeNull();
		expect(source!.getLoadError?.(watch.id)?.message).toContain('digest');
		await client.close();
	});
});
