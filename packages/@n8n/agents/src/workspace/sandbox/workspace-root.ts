import { runInSandbox, type SandboxCommandTarget } from './run-in-sandbox';
import type { SandboxProvider } from './types';

export const WORKSPACE_DIR = 'workspace';
export const DAYTONA_HOME = '/home/daytona';
export const DAYTONA_WORKSPACE_ROOT = `${DAYTONA_HOME}/${WORKSPACE_DIR}`;
export const N8N_SANDBOX_HOME = '/home/user';
export const N8N_SANDBOX_WORKSPACE_ROOT = `${N8N_SANDBOX_HOME}/${WORKSPACE_DIR}`;
/**
 * Workspace root that is the same on every provider: the n8n sandbox service
 * uses it natively, and current Daytona snapshots bake the workspace there.
 * Sandboxes from older Daytona snapshots use {@link DAYTONA_WORKSPACE_ROOT}.
 */
export const PORTABLE_WORKSPACE_ROOT = N8N_SANDBOX_WORKSPACE_ROOT;

/**
 * Makes the portable root exist in a Daytona sandbox and prints the root to use. Sandboxes from
 * older snapshots have their workspace at the Daytona root, so the portable root becomes a link
 * to it. A link that another call made first also counts. The Daytona user needs sudo to create
 * the parent directory. When that fails, the command prints the Daytona root.
 */
const ENSURE_DAYTONA_PORTABLE_WORKSPACE_ROOT_COMMAND = [
	`if [ -d '${PORTABLE_WORKSPACE_ROOT}' ]; then echo '${PORTABLE_WORKSPACE_ROOT}';`,
	'elif SUDO=$([ "$(id -u)" = 0 ] || echo \'sudo -n\')',
	`&& $SUDO mkdir -p '${N8N_SANDBOX_HOME}'`,
	`&& $SUDO chown "$(id -u):$(id -g)" '${N8N_SANDBOX_HOME}'`,
	`&& if [ -d '${DAYTONA_WORKSPACE_ROOT}' ]; then ln -sn '${DAYTONA_WORKSPACE_ROOT}' '${PORTABLE_WORKSPACE_ROOT}' || [ -d '${PORTABLE_WORKSPACE_ROOT}' ]; else mkdir -p '${PORTABLE_WORKSPACE_ROOT}'; fi;`,
	`then echo '${PORTABLE_WORKSPACE_ROOT}';`,
	`else echo '${DAYTONA_WORKSPACE_ROOT}'; fi`,
].join(' ');

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

	// The snapshot decides where the workspace is baked. Older snapshots get a link at the
	// portable root, so the agent can use the same paths on every provider.
	if (workspace.sandbox?.provider === 'daytona') {
		const result = await runInSandbox(workspace, ENSURE_DAYTONA_PORTABLE_WORKSPACE_ROOT_COMMAND);
		const root =
			result.stdout.trim() === PORTABLE_WORKSPACE_ROOT
				? PORTABLE_WORKSPACE_ROOT
				: DAYTONA_WORKSPACE_ROOT;
		workspaceRootCache.set(workspace, root);
		return root;
	}

	const result = await runInSandbox(workspace, 'echo $HOME');
	const home = result.stdout.trim() || getFallbackHome(workspace);
	const root = `${home}/${WORKSPACE_DIR}`;
	workspaceRootCache.set(workspace, root);
	return root;
}
