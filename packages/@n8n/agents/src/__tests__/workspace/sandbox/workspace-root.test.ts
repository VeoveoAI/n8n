import {
	DAYTONA_HOME,
	N8N_SANDBOX_HOME,
	getPromptWorkspaceRoot,
	getWorkspaceRoot,
	WORKSPACE_DIR,
	type SandboxWorkspace,
} from '../../../workspace/sandbox/workspace-root';

describe('getPromptWorkspaceRoot', () => {
	it('returns daytona workspace root', () => {
		expect(getPromptWorkspaceRoot('daytona')).toBe('/home/daytona/workspace');
	});

	it('returns n8n-sandbox workspace root', () => {
		expect(getPromptWorkspaceRoot('n8n-sandbox')).toBe('/home/user/workspace');
	});

	describe('when N8N_SANDBOX_SERVICE_HOMES gives each sandbox its own home', () => {
		beforeEach(() => {
			vi.stubEnv('N8N_SANDBOX_SERVICE_HOMES', '/sandbox/n8n/.sandboxes/');
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("returns the workspace in the sandbox's home", () => {
			expect(getPromptWorkspaceRoot('n8n-sandbox', '44444444-4444-4444-8444-444444444444')).toBe(
				'/sandbox/n8n/.sandboxes/44444444-4444-4444-8444-444444444444/workspace',
			);
		});

		it('refuses a sandbox without an id', () => {
			expect(() => getPromptWorkspaceRoot('n8n-sandbox')).toThrow('has no id');
		});

		it('leaves daytona as it is', () => {
			expect(getPromptWorkspaceRoot('daytona', 'sb')).toBe('/home/daytona/workspace');
		});
	});
});

describe('getWorkspaceRoot', () => {
	it('returns local filesystem basePath when provider is local', async () => {
		const workspace = {
			filesystem: {
				provider: 'local',
				basePath: '/local/workspace',
			},
		} as SandboxWorkspace;

		await expect(getWorkspaceRoot(workspace)).resolves.toBe('/local/workspace');
	});

	it('initializes lazy filesystem and returns its basePath', async () => {
		let initialized = false;
		const executeCommand = vi.fn();
		const init = vi.fn<(...args: []) => Promise<void>>(async () => {
			await Promise.resolve();
			initialized = true;
		});
		const workspace = {
			filesystem: {
				provider: 'lazy',
				get basePath() {
					return initialized ? '/sandbox' : undefined;
				},
				init,
			},
			sandbox: {
				executeCommand,
			},
		} as SandboxWorkspace;

		await expect(getWorkspaceRoot(workspace)).resolves.toBe('/sandbox');

		expect(init).toHaveBeenCalledTimes(1);
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it('falls back to echo $HOME through sandbox command execution', async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: '/custom/home\n',
			stderr: '',
		});
		const workspace = {
			sandbox: {
				executeCommand,
			},
		} as SandboxWorkspace;

		await expect(getWorkspaceRoot(workspace)).resolves.toBe('/custom/home/workspace');

		expect(executeCommand).toHaveBeenCalledWith('echo $HOME', [], { cwd: undefined });
	});

	it('uses DAYTONA_HOME when echo $HOME returns empty stdout for Daytona', async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: '   \n',
			stderr: '',
		});
		const workspace = {
			sandbox: {
				provider: 'daytona',
				executeCommand,
			},
		} as SandboxWorkspace;

		await expect(getWorkspaceRoot(workspace)).resolves.toBe(`${DAYTONA_HOME}/${WORKSPACE_DIR}`);
	});

	it('uses N8N_SANDBOX_HOME when echo $HOME returns empty stdout for n8n-sandbox', async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: '   \n',
			stderr: '',
		});
		const workspace = {
			sandbox: {
				provider: 'n8n-sandbox',
				executeCommand,
			},
		} as SandboxWorkspace;

		await expect(getWorkspaceRoot(workspace)).resolves.toBe(`${N8N_SANDBOX_HOME}/${WORKSPACE_DIR}`);
	});

	it("uses the sandbox's own home when echo $HOME returns empty stdout under N8N_SANDBOX_SERVICE_HOMES", async () => {
		vi.stubEnv('N8N_SANDBOX_SERVICE_HOMES', '/sandbox/n8n/.sandboxes');
		const executeCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: '   \n',
			stderr: '',
		});
		const workspace = {
			sandbox: {
				id: 'sb-1',
				provider: 'n8n-sandbox',
				executeCommand,
			},
		} as SandboxWorkspace;

		await expect(getWorkspaceRoot(workspace)).resolves.toBe(
			'/sandbox/n8n/.sandboxes/sb-1/workspace',
		);
		vi.unstubAllEnvs();
	});

	it('uses DAYTONA_HOME when echo $HOME returns empty stdout without provider metadata', async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: '   \n',
			stderr: '',
		});
		const workspace = {
			sandbox: {
				executeCommand,
			},
		} as SandboxWorkspace;

		await expect(getWorkspaceRoot(workspace)).resolves.toBe(`${DAYTONA_HOME}/${WORKSPACE_DIR}`);
	});

	it('uses DAYTONA_HOME when echo $HOME is empty for an unsupported provider', async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: '   \n',
			stderr: '',
		});
		const workspace = {
			sandbox: {
				provider: 'unknown',
				executeCommand,
			},
		} as SandboxWorkspace;

		await expect(getWorkspaceRoot(workspace)).resolves.toBe(`${DAYTONA_HOME}/${WORKSPACE_DIR}`);
	});

	it('caches result per workspace object', async () => {
		const executeCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: '/cached/home\n',
			stderr: '',
		});
		const workspace = {
			sandbox: {
				executeCommand,
			},
		} as SandboxWorkspace;

		const first = await getWorkspaceRoot(workspace);
		const second = await getWorkspaceRoot(workspace);

		expect(first).toBe('/cached/home/workspace');
		expect(second).toBe('/cached/home/workspace');
		expect(executeCommand).toHaveBeenCalledTimes(1);
	});
});
