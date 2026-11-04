import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type AgentName = 'claude' | 'codex' | 'gemini';

interface AgentCommand {
  bin: string;
  args: string[];
  stdin?: string;
}

/**
 * Each command gets the code inside the prompt and has no need for tools.
 * Tools stay off or read-only, so instructions hidden in a repo have little to act on.
 */
const COMMANDS: Record<AgentName, (prompt: string) => AgentCommand> = {
  claude: (prompt) => ({
    bin: 'claude',
    args: ['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'text'],
    stdin: prompt,
  }),
  codex: (prompt) => ({
    bin: 'codex',
    args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt],
  }),
  gemini: (prompt) => ({ bin: 'gemini', args: ['--approval-mode', 'plan', '-p', prompt] }),
};

export const AGENTS = Object.keys(COMMANDS) as AgentName[];

export function isInstalled(agent: AgentName): boolean {
  return spawnSync(agent, ['--version'], { stdio: 'ignore' }).status === 0;
}

export function detectAgent(): AgentName | null {
  return AGENTS.find(isInstalled) ?? null;
}

export type Runner = (prompt: string) => Promise<string>;

export function createRunner(agent: AgentName, timeoutMs = 300_000): Runner {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const { bin, args, stdin } = COMMANDS[agent](prompt);
      // An empty directory keeps the repo's agent config and hooks out of the run.
      const cwd = mkdtempSync(join(tmpdir(), 'didiwritethis-'));
      const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const finish = (done: () => void) => {
        clearTimeout(timer);
        rmSync(cwd, { recursive: true, force: true });
        done();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`${agent} did not answer within ${timeoutMs / 1000}s`)));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code) =>
        finish(() =>
          code === 0
            ? resolve(stdout)
            : reject(new Error(`${agent} exited with code ${code}: ${stderr.trim().slice(-400)}`)),
        ),
      );
      child.stdin.on('error', () => {});
      child.stdin.end(stdin ?? '');
    });
}
