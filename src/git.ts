import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, basename, join } from 'node:path';

export interface SourceFile {
  path: string;
  content: string;
  weight: number;
  truncated: boolean;
}

export interface Selection {
  files: SourceFile[];
  commitsScanned: number;
  agentCommits: number;
}

export interface SelectOptions {
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
  commits?: number;
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.cs', '.go', '.rs', '.rb',
  '.php', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.vue', '.svelte', '.dart',
  '.scala', '.lua', '.ex', '.exs', '.sh',
]);

const EXCLUDED_PATH =
  /(^|\/)(node_modules|dist|build|out|target|vendor|coverage|__generated__|generated|\.next|\.git)\//i;
const EXCLUDED_NAME =
  /(\.min\.|\.d\.ts$|\.generated\.|\.gen\.|\.test\.|\.spec\.|_test\.|^test_|^conftest\.py$)/i;
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?)\//i;
const SECRET_NAME =
  /(^\.env|\.pem$|\.key$|\.p12$|\.pfx$|^id_(rsa|ed25519|ecdsa)|credential|secret|\.keystore$)/i;

const AGENT_MARKER =
  /co-authored-by:.*(claude|copilot|codex|cursor|gemini|aider|devin|windsurf|opencode|openclaw)|generated (with|by) .*(claude|copilot|codex|cursor|gemini|aider|devin|windsurf)/i;

/** Commits an agent is credited on count for more. Agents are often uncredited, so this is only a hint. */
const AGENT_WEIGHT = 3;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export function repoRoot(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
}

export function isCandidate(path: string): boolean {
  const name = basename(path);
  return (
    SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) &&
    !EXCLUDED_PATH.test(path) &&
    !TEST_DIR.test(path) &&
    !EXCLUDED_NAME.test(name) &&
    !SECRET_NAME.test(name)
  );
}

export function isAgentCommit(message: string): boolean {
  return AGENT_MARKER.test(message);
}

const SECRET_VALUE: RegExp[] = [
  /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*)(["'`])[^"'`\n]{8,}\2/gi;

export function redact(text: string): string {
  let out = text.replace(SECRET_ASSIGNMENT, '$1$2[REDACTED]$2');
  for (const pattern of SECRET_VALUE) out = out.replace(pattern, '[REDACTED]');
  return out;
}

interface HistoryEntry {
  message: string;
  changes: { path: string; lines: number }[];
}

export function parseLog(log: string): HistoryEntry[] {
  return log
    .split('\x01')
    .filter(Boolean)
    .map((chunk) => {
      const [message = '', stats = ''] = chunk.split('\x02');
      const changes = stats
        .split('\n')
        .map((line) => line.split('\t'))
        .filter((parts): parts is [string, string, string] => parts.length === 3)
        .filter(([added, , path]) => added !== '-' && !path.includes('=>'))
        .map(([added, removed, path]) => ({ path, lines: Number(added) + Number(removed) }));
      return { message, changes };
    });
}

export function selectFiles(root: string, options: SelectOptions = {}): Selection {
  const { maxFiles = 8, maxCharsPerFile = 12_000, maxTotalChars = 60_000, commits = 300 } = options;

  const tracked = new Set(git(root, ['ls-files']).split('\n').filter(Boolean));
  const history = parseLog(git(root, ['log', `-n${commits}`, '--format=%x01%B%x02', '--numstat']));

  const weights = new Map<string, number>();
  let agentCommits = 0;
  for (const entry of history) {
    const agent = isAgentCommit(entry.message);
    if (agent) agentCommits += 1;
    for (const { path, lines } of entry.changes) {
      if (!tracked.has(path) || !isCandidate(path)) continue;
      weights.set(path, (weights.get(path) ?? 0) + lines * (agent ? AGENT_WEIGHT : 1));
    }
  }

  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const files: SourceFile[] = [];
  let total = 0;
  for (const [path, weight] of ranked) {
    if (files.length >= maxFiles || total >= maxTotalChars) break;
    const absolute = join(root, path);
    try {
      if (statSync(absolute).size < 200) continue;
      const raw = readFileSync(absolute, 'utf8');
      if (raw.includes('\0')) continue;
      const limit = Math.min(maxCharsPerFile, maxTotalChars - total);
      const content = redact(raw).slice(0, limit);
      total += content.length;
      files.push({ path, content, weight, truncated: raw.length > limit });
    } catch {
      continue;
    }
  }
  return { files, commitsScanned: history.length, agentCommits };
}
