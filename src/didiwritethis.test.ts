import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { badgeMarkdown, renderCard } from './card.js';
import { isAgentCommit, isCandidate, parseLog, redact, selectFiles, type SourceFile } from './git.js';
import {
  buildQuiz,
  keepConfirmed,
  parseJsonArray,
  pickMix,
  shuffleOptions,
  toQuestions,
  type Question,
  type QuestionType,
} from './quiz.js';
import { rankFor, scoreAttempts } from './score.js';

const question = (id: number, type: QuestionType = 'debug', answer = 0): Question => ({
  id,
  type,
  file: 'a.ts',
  symbol: 'f',
  question: `q${id}`,
  options: ['a', 'b', 'c', 'd'],
  answer,
  explanation: 'because',
});

const raw = (overrides: object = {}) => ({
  type: 'debug',
  file: 'a.ts',
  symbol: 'f',
  question: 'q',
  options: ['a', 'b', 'c', 'd'],
  answer: 1,
  explanation: 'e',
  ...overrides,
});

test('isCandidate keeps source and drops tests, builds, locks and secrets', () => {
  assert.equal(isCandidate('src/app.ts'), true);
  assert.equal(isCandidate('src/app.test.ts'), false);
  assert.equal(isCandidate('tests/app.py'), false);
  assert.equal(isCandidate('dist/app.js'), false);
  assert.equal(isCandidate('docs/prototype/engine.py'), false);
  assert.equal(isCandidate('examples/demo.js'), false);
  assert.equal(isCandidate('package-lock.json'), false);
  assert.equal(isCandidate('src/types.d.ts'), false);
  assert.equal(isCandidate('src/credentials.py'), false);
  assert.equal(isCandidate('.env.ts'), false);
});

test('isAgentCommit recognises agent trailers', () => {
  assert.equal(isAgentCommit('fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>'), true);
  assert.equal(isAgentCommit('Generated with Cursor'), true);
  assert.equal(isAgentCommit('fix\n\nCo-Authored-By: Jan <jan@example.com>'), false);
});

test('redact removes assigned secrets and known token shapes', () => {
  const out = redact(`const api_key = "abcdefghijkl"\ntoken: ghp_${'a'.repeat(30)}\nconst name = "visible"`);
  assert.ok(!out.includes('abcdefghijkl'));
  assert.ok(!out.includes('ghp_'));
  assert.ok(out.includes('visible'));
});

test('parseLog reads messages and numstat, and skips binaries and renames', () => {
  const log = '\x01first\n\x02\n3\t1\ta.ts\n-\t-\tlogo.png\n1\t1\t{a => b}.ts\n\x01second\x02\n2\t0\tb.ts\n';
  assert.deepEqual(parseLog(log), [
    { message: 'first\n', changes: [{ path: 'a.ts', lines: 4 }] },
    { message: 'second', changes: [{ path: 'b.ts', lines: 2 }] },
  ]);
});

test('selectFiles ranks by changes and weighs agent commits higher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diwt-test-'));
  const run = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  writeFileSync(join(dir, 'human.ts'), 'x\n'.repeat(120));
  run('add', '.');
  run('commit', '-qm', 'human');
  writeFileSync(join(dir, 'agent.ts'), 'y\n'.repeat(100));
  writeFileSync(join(dir, 'tiny.ts'), 'z\n');
  writeFileSync(join(dir, 'agent.test.ts'), 't\n'.repeat(500));
  run('add', '.');
  run('commit', '-qm', 'agent\n\nCo-Authored-By: Claude <noreply@anthropic.com>');

  const selection = selectFiles(dir);
  assert.deepEqual(selection.files.map((file) => file.path), ['agent.ts', 'human.ts']);
  assert.equal(selection.agentCommits, 1);
  assert.equal(selection.commitsScanned, 2);
});

test('selectFiles respects the total character budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diwt-test-'));
  const run = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  writeFileSync(join(dir, 'a.ts'), 'a'.repeat(500));
  writeFileSync(join(dir, 'b.ts'), 'b'.repeat(500));
  run('add', '.');
  run('commit', '-qm', 'x');
  const { files } = selectFiles(dir, { maxCharsPerFile: 300, maxTotalChars: 400 });
  assert.equal(files.reduce((sum, file) => sum + file.content.length, 0), 400);
  assert.ok(files.every((file) => file.truncated));
});

test('parseJsonArray accepts fenced replies and rejects prose', () => {
  assert.deepEqual(parseJsonArray('Here:\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(parseJsonArray('Option [a] looks right.\n[{"id":1,"answer":2},{"id":2,"answer":0}]\nSee [b].'), [
    { id: 1, answer: 2 },
    { id: 2, answer: 0 },
  ]);
  assert.deepEqual(parseJsonArray('[{"q":"a ] b [ c"}]'), [{ q: 'a ] b [ c' }]);
  assert.throws(() => parseJsonArray('no json here'));
});

test('toQuestions drops malformed items', () => {
  const paths = new Set(['a.ts']);
  const items = [
    raw(),
    raw({ file: 'other.ts' }),
    raw({ options: ['a', 'a', 'b', 'c'] }),
    raw({ options: ['a', 'b', 'c'] }),
    raw({ answer: 4 }),
    raw({ type: 'trivia' }),
    raw({ explanation: 'It is b. Actually, see below.' }),
    raw({ options: ['a', 'the much longer and more careful right answer', 'c', 'd'] }),
    null,
  ].map((item) => item ?? {});
  assert.equal(toQuestions(items, paths).length, 1);
});

test('keepConfirmed keeps only questions the blind pass agrees with', () => {
  const kept = keepConfirmed(
    [question(0, 'debug', 1), question(1, 'debug', 2), question(2, 'debug', 3)],
    [{ id: 0, answer: 1 }, { id: 1, answer: 0 }, { id: 2, answer: -1 }],
  );
  assert.deepEqual(kept.map((q) => q.id), [0]);
});

test('pickMix follows 5 debug, 3 read, 2 concept and fills gaps', () => {
  const pool = [
    ...Array.from({ length: 8 }, (_, i) => question(i, 'debug')),
    ...Array.from({ length: 4 }, (_, i) => question(10 + i, 'read')),
    ...Array.from({ length: 2 }, (_, i) => question(20 + i, 'concept')),
  ];
  const picked = pickMix(pool, 10);
  const count = (type: QuestionType) => picked.filter((q) => q.type === type).length;
  assert.deepEqual([count('debug'), count('read'), count('concept')], [5, 3, 2]);

  const debugHeavy = pickMix(Array.from({ length: 12 }, (_, i) => question(i, 'debug')), 10);
  assert.equal(debugHeavy.length, 10);
});

test('shuffleOptions keeps the correct answer attached', () => {
  const q = { ...question(0), options: ['right', 'x', 'y', 'z'] };
  for (const seed of [0, 0.3, 0.6, 0.9]) {
    const moved = shuffleOptions(q, () => seed);
    assert.equal(moved.options[moved.answer], 'right');
  }
});

test('scoreAttempts leaves flagged questions out and lists weak spots', () => {
  const score = scoreAttempts([
    { question: question(0, 'debug', 1), choice: 1 },
    { question: question(1, 'read', 1), choice: 0 },
    { question: question(2, 'concept', 1), choice: null },
  ]);
  assert.deepEqual([score.correct, score.total, score.percent, score.flagged], [1, 2, 50, 1]);
  assert.deepEqual(score.byType.concept, { correct: 0, total: 0 });
  assert.deepEqual(score.weakSpots, [{ file: 'a.ts', symbol: 'f', type: 'read' }]);
});

test('rank boundaries', () => {
  assert.equal(rankFor(49).name, 'Passenger');
  assert.equal(rankFor(50).name, 'Copilot');
  assert.equal(rankFor(79).name, 'Copilot');
  assert.equal(rankFor(80).name, 'Pilot');
});

test('buildQuiz retries bad JSON and drops unconfirmed questions', async () => {
  const files: SourceFile[] = [{ path: 'a.ts', content: 'x', weight: 1, truncated: false }];
  const items = Array.from({ length: 9 }, (_, i) => raw({ question: `q${i}` }));
  const replies = [
    'not json',
    JSON.stringify(items),
    JSON.stringify(items.map((_, id) => ({ id, answer: id === 0 ? 3 : 1 }))),
  ];
  const quiz = await buildQuiz(async () => replies.shift() ?? '', files, 5);
  assert.equal(quiz.length, 5);
  assert.ok(quiz.every((q) => q.options[q.answer] === 'b'));
});

test('buildQuiz fails when too few questions survive', async () => {
  const files: SourceFile[] = [{ path: 'a.ts', content: 'x', weight: 1, truncated: false }];
  const items = Array.from({ length: 9 }, () => raw());
  const replies = [JSON.stringify(items), '[{"id":0,"answer":-1}]'];
  await assert.rejects(buildQuiz(async () => replies.shift() ?? '', files, 5), /survived/);
});

test('renderCard produces a PNG and the badge links to the package', () => {
  const score = scoreAttempts([{ question: question(0, 'debug', 1), choice: 0 }]);
  const png = renderCard(score, '2026-11-04');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.match(badgeMarkdown(score), /img\.shields\.io.*0%25/);
});
