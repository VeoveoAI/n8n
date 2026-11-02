import { createHash } from 'crypto';

import type { McpConnectionSkills, McpSkillEntry } from './mcp-connection';
import { groupRuntimeSkillLinkedFiles, hashRuntimeSkillRegistry } from '../../skills/registry';
import {
	RUNTIME_SKILL_FILE_NAME,
	RUNTIME_SKILL_REGISTRY_SCHEMA_VERSION,
	type RuntimeSkillContent,
	type RuntimeSkillLoadError,
	type RuntimeSkillMcpOrigin,
	type RuntimeSkillRegistryEntry,
	type RuntimeSkillSource,
} from '../../skills/types';

/** The MCP Skills extension's publication limits for one skill: its files and their bytes. */
export const MCP_SKILL_LIMITS = { files: 512, bytes: 16 * 1024 * 1024 } as const;

/** One MCP server whose skills join a skill source. */
export interface McpSkillServer {
	/** The configured name of the server, the skills' label. */
	name: string;
	skills: McpConnectionSkills;
	/** Skill URIs, or URI prefixes that end in `/`, that load without asking. */
	approved?: readonly string[];
}

/** A skill the source left out, and why. */
export interface McpSkillSkipped {
	server: string;
	uri?: string;
	reason: string;
}

/**
 * The skills of MCP servers as one skill source, read lazily: the registry holds each
 * listed skill's entry and nothing is fetched until a skill loads. Each skill's id encodes
 * its server, its `SKILL.md` URI and its file set, so a changed file set is another skill
 * that needs approval again. A skill's text and frontmatter are the server's: the source
 * takes no `allowed-tools`, dependencies or policy from them, refuses `"dynamic"` skills
 * and skills over {@link MCP_SKILL_LIMITS}, and marks each skill's origin.
 */
export async function createMcpRuntimeSkillSource(
	servers: readonly McpSkillServer[],
	options: { onSkipped?: (event: McpSkillSkipped) => void } = {},
): Promise<RuntimeSkillSource> {
	const skip = (event: McpSkillSkipped) => options.onSkipped?.(event);
	const listed = await Promise.all(
		servers.map(async (server) => {
			try {
				return { server, entries: await server.skills.list() };
			} catch (error) {
				skip({ server: server.name, reason: errorMessage(error) });
				return { server, entries: [] };
			}
		}),
	);
	const skills = new Map<string, { server: McpSkillServer; entry: McpSkillEntry }>();
	const registryEntries: RuntimeSkillRegistryEntry[] = [];
	for (const { server, entries } of listed) {
		for (const entry of entries) {
			const refused = refusal(entry);
			if (refused) {
				skip({ server: server.name, uri: entry.uri, reason: refused });
				continue;
			}
			const registryEntry = toRegistryEntry(server, entry);
			if (skills.has(registryEntry.id)) continue;
			skills.set(registryEntry.id, { server, entry });
			registryEntries.push(registryEntry);
		}
	}
	registryEntries.sort(
		(left, right) => compare(left.name, right.name) || compare(left.id, right.id),
	);
	const entriesById = new Map(registryEntries.map((entry) => [entry.id, entry]));
	const loadErrors = new Map<string, RuntimeSkillLoadError>();

	const failed = (id: string, error: unknown) => {
		// A server that cannot answer now may answer on a later turn.
		loadErrors.set(id, { message: errorMessage(error), retryable: true });
		return null;
	};

	return {
		registry: {
			schemaVersion: RUNTIME_SKILL_REGISTRY_SCHEMA_VERSION,
			skillsHash: hashRuntimeSkillRegistry(registryEntries),
			skills: registryEntries,
		},
		loadSkill: async (skillId) => {
			const skill = skills.get(skillId);
			const registered = entriesById.get(skillId);
			if (!skill || !registered) return null;
			try {
				const file = await skill.server.skills.read(skill.entry);
				loadErrors.delete(skillId);
				const content: RuntimeSkillContent = {
					id: registered.id,
					name: registered.name,
					description: registered.description,
					instructions: file.body ?? file.text ?? '',
					linkedFiles: registered.linkedFiles,
					...(registered.sourceName ? { sourceName: registered.sourceName } : {}),
					...(registered.origin ? { origin: registered.origin } : {}),
				};
				return content;
			} catch (error) {
				return failed(skillId, error);
			}
		},
		loadFile: async (skillId, filePath) => {
			const skill = skills.get(skillId);
			if (!skill) return null;
			try {
				const file = await skill.server.skills.read(skill.entry, filePath);
				const listedFile =
					skill.entry.resources === 'dynamic'
						? undefined
						: skill.entry.resources.find((resource) => resource.uri === file.uri);
				return {
					skillId,
					filePath,
					content:
						file.text ??
						`${filePath} is a ${file.mimeType ?? 'binary'} file of ${file.bytes.byteLength} bytes, which is not shown as text.`,
					bytes: file.bytes.byteLength,
					...(listedFile ? { sha256: listedFile.digest.replace(/^sha256:/, '') } : {}),
				};
			} catch (error) {
				return failed(skillId, error);
			}
		},
		getLoadError: (skillId) => loadErrors.get(skillId),
	};
}

/** Why an entry is not taken, or `undefined` when it is. */
function refusal(entry: McpSkillEntry): string | undefined {
	if (entry.resources === 'dynamic')
		return 'its files are "dynamic", not listed, so they cannot be verified';
	if (entry.resources.length > MCP_SKILL_LIMITS.files)
		return `it lists ${entry.resources.length} files, more than ${MCP_SKILL_LIMITS.files}`;
	const bytes = entry.resources.reduce((total, resource) => total + resource.size, 0);
	if (bytes > MCP_SKILL_LIMITS.bytes)
		return `its files hold ${bytes} bytes, more than ${MCP_SKILL_LIMITS.bytes}`;
	return undefined;
}

function toRegistryEntry(server: McpSkillServer, entry: McpSkillEntry): RuntimeSkillRegistryEntry {
	const resources = entry.resources === 'dynamic' ? [] : entry.resources;
	const fingerprint = createHash('sha256')
		.update(
			JSON.stringify(
				resources
					.map((resource) => [resource.uri, resource.digest, resource.size] as const)
					.sort((left, right) => compare(left[0], right[0])),
			),
		)
		.digest('hex');
	const root = entry.uri.slice(0, entry.uri.lastIndexOf('/') + 1);
	const origin: RuntimeSkillMcpOrigin = {
		type: 'mcp',
		server: server.name,
		uri: entry.uri,
		approved: isApproved(server.approved ?? [], entry.uri),
		fingerprint,
	};
	return {
		id: mcpSkillId(server.name, entry.uri, fingerprint),
		name: entry.frontmatter.name,
		description: entry.frontmatter.description,
		hash: fingerprint.slice(0, 12),
		sourceName: server.name,
		origin,
		linkedFiles: groupRuntimeSkillLinkedFiles(
			resources
				.filter((resource) => resource.uri.startsWith(root))
				.map((resource) => ({
					path: resource.uri.slice(root.length),
					bytes: resource.size,
					sha256: resource.digest.replace(/^sha256:/, ''),
				}))
				.filter((file) => file.path !== RUNTIME_SKILL_FILE_NAME),
		),
	};
}

/**
 * A skill's id: `mcp:{server}:{SKILL.md URI}#{file set}`, so an active skill names its
 * server and URI, and one whose files changed is not the skill that was approved.
 */
export function mcpSkillId(server: string, uri: string, fingerprint: string): string {
	return `mcp:${server}:${uri}#${fingerprint.slice(0, 12)}`;
}

/** Whether `approved` names `uri` itself or a prefix of it that ends in `/`. */
function isApproved(approved: readonly string[], uri: string): boolean {
	return approved.some((item) => (item.endsWith('/') ? uri.startsWith(item) : uri === item));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compare(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
