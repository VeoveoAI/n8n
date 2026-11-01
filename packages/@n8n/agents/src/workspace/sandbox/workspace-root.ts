import { runInSandbox, type SandboxCommandTarget } from './run-in-sandbox';
import type { SandboxProvider } from './types';

export const WORKSPACE_DIR = 'workspace';
export const DAYTONA_HOME = '/home/daytona';
export const DAYTONA_WORKSPACE_ROOT = `${DAYTONA_HOME}/${WORKSPACE_DIR}`;
export const N8N_SANDBOX_HOME = '/home/user';
export const N8N_SANDBOX_WORKSPACE_ROOT = `${N8N_SANDBOX_HOME}/${WORKSPACE_DIR}`;

/**
 * The home of an n8n-sandbox sandbox. The n8n sandbox service runs each sandbox in its
 * own container, whose home is `/home/user`. A sandbox service that keeps every sandbox
 * in a directory of one machine names the directory that holds them in
 * `N8N_SANDBOX_SERVICE_HOMES`, and a sandbox's home is its subdirectory named by the
 * sandbox's id.
 */
export function getN8nSandboxHome(sandboxId?: string): string {
	const homes = process.env.N8N_SANDBOX_SERVICE_HOMES?.trim().replace(/\/+$/, '');
	if (!homes) return N8N_SANDBOX_HOME;
	if (!sandboxId) {
		throw new Error(
			'N8N_SANDBOX_SERVICE_HOMES gives each sandbox its own home, and this sandbox has no id',
		);
	}
	return `${homes}/${sandboxId}`;
}

export function getSandboxHome(provider: SandboxProvider, sandboxId?: string): string {
	switch (provider) {
		case 'daytona':
			return DAYTONA_HOME;
		case 'n8n-sandbox':
			return getN8nSandboxHome(sandboxId);
	}
}

export function getPromptWorkspaceRoot(provider: SandboxProvider, sandboxId?: string): string {
	return `${getSandboxHome(provider, sandboxId)}/${WORKSPACE_DIR}`;
}

export interface SandboxWorkspace extends SandboxCommandTarget {
	filesystem?: {
		provider?: string;
		basePath?: string;
		init?: () => Promise<void>;
	};
}

const workspaceRootCache = new WeakMap<SandboxWorkspace, string>();

function getLocalFilesystemRoot(workspace: SandboxWorkspace): string | null {
	const filesystem = workspace.filesystem;
	if (!filesystem) return null;

	const provider = filesystem.provider;
	if (provider !== 'local' && provider !== 'lazy') return null;

	const basePath = Reflect.get(filesystem, 'basePath');
	return typeof basePath === 'string' && basePath.length > 0 ? basePath : null;
}

async function initializeLazyFilesystem(workspace: SandboxWorkspace): Promise<void> {
	const filesystem = workspace.filesystem;
	if (filesystem?.provider !== 'lazy') return;

	await filesystem.init?.();
}

function getFallbackHome(workspace: SandboxWorkspace): string {
	const provider = workspace.sandbox?.provider;
	return getSandboxHome(provider === 'n8n-sandbox' ? provider : 'daytona', workspace.sandbox?.id);
}

export async function getWorkspaceRoot(workspace: SandboxWorkspace): Promise<string> {
	const cached = workspaceRootCache.get(workspace);
	if (cached) return cached;

	const localRoot = getLocalFilesystemRoot(workspace);
	if (localRoot) {
		workspaceRootCache.set(workspace, localRoot);
		return localRoot;
	}

	await initializeLazyFilesystem(workspace);
	const initializedLocalRoot = getLocalFilesystemRoot(workspace);
	if (initializedLocalRoot) {
		workspaceRootCache.set(workspace, initializedLocalRoot);
		return initializedLocalRoot;
	}

	const result = await runInSandbox(workspace, 'echo $HOME');
	const home = result.stdout.trim() || getFallbackHome(workspace);
	const root = `${home}/${WORKSPACE_DIR}`;
	workspaceRootCache.set(workspace, root);
	return root;
}
