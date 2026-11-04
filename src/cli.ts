#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { AGENTS, createRunner, detectAgent, isInstalled, type AgentName } from './agents.js';
import { badgeMarkdown, renderCard } from './card.js';
import { repoRoot, selectFiles, type Selection } from './git.js';
import { buildQuiz, type Question } from './quiz.js';
import { scoreAttempts, type Attempt, type Score } from './score.js';

const HELP = `didiwritethis: a 3-minute test of how much of your own repo you understand.

Usage: npx didiwritethis [options]

Options:
  --agent <name>      Agent CLI to use: ${AGENTS.join(', ')} (default: first one found)
  --questions <n>     Number of questions (default: 10)
  --files <n>         Number of files to quiz on (default: 8)
  --out <path>        Where to write the score card (default: didiwritethis-card.png)
  --no-card           Do not write a score card
  --list              Show which files would be sent, then stop
  -y, --yes           Skip the confirmation before sending code to your agent
  -h, --help          Show this help

Your code goes to the provider behind your own agent CLI, and nowhere else.`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

/** Reads line by line so answers can also be piped in. */
function lineReader() {
  const rl = createInterface({ input: process.stdin });
  const iterator = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt: string): Promise<string | null> {
      process.stdout.write(prompt);
      const { value, done } = await iterator.next();
      return done ? null : String(value).trim();
    },
    close: () => rl.close(),
  };
}

type Reader = ReturnType<typeof lineReader>;

function spinner(message: string) {
  if (!process.stderr.isTTY) {
    console.error(dim(message));
    return () => {};
  }
  const frames = ['-', '\\', '|', '/'];
  let frame = 0;
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    process.stderr.write(`\r${frames.at(frame)} ${message}`);
  }, 120);
  return () => {
    clearInterval(timer);
    process.stderr.write(`\r\x1b[K`);
  };
}

function printSelection({ files, commitsScanned, agentCommits }: Selection, agent: AgentName) {
  console.log(
    `\nScanned ${commitsScanned} ${commitsScanned === 1 ? 'commit' : 'commits'} (${agentCommits} credit an agent).` +
      `\nThese ${files.length} files go to ${bold(agent)}, the agent CLI on this machine:\n`,
  );
  for (const file of files) {
    console.log(`  ${file.path}${file.truncated ? dim(' (first part only)') : ''}`);
  }
  console.log('');
}

async function takeQuiz(questions: Question[], reader: Reader): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  for (const [index, question] of questions.entries()) {
    const where = question.symbol ? `${question.file} > ${question.symbol}` : question.file;
    console.log(`\n${bold(`Question ${index + 1}/${questions.length}`)}  ${dim(`${question.type}: ${where}`)}`);
    console.log(`\n${question.question}\n`);
    question.options.forEach((option, i) => console.log(`  ${'abcd'.charAt(i)}) ${option}`));

    let choice: number | null | undefined;
    while (choice === undefined) {
      const reply = await reader.ask(`\n${dim('a/b/c/d, or x if this question is wrong:')} `);
      if (reply === null) return attempts;
      const key = reply.toLowerCase();
      if (key === 'x') choice = null;
      else if (key.length === 1 && 'abcd'.includes(key)) choice = 'abcd'.indexOf(key);
    }

    attempts.push({ question, choice });
    if (choice === null) console.log(dim('Flagged. This question will not count.'));
    else if (choice === question.answer) console.log(`${green('Correct.')} ${question.explanation}`);
    else {
      const right = 'abcd'.charAt(question.answer);
      console.log(`${red(`Wrong, it was ${right}.`)} ${question.explanation}`);
    }
  }
  return attempts;
}

function printScore(score: Score) {
  const tint = score.percent >= 70 ? green : score.percent >= 40 ? yellow : red;
  console.log(`\n${bold('You understand')} ${bold(tint(`${score.percent}%`))} ${bold('of this repo.')}`);
  console.log(`${bold(score.rank.name)}: ${score.rank.line}\n`);
  console.log(`  Score:      ${score.correct}/${score.total} questions`);
  console.log(`  Debugging:  ${score.byType.debug.correct}/${score.byType.debug.total}`);
  console.log(`  Reading:    ${score.byType.read.correct}/${score.byType.read.total}`);
  console.log(`  Concepts:   ${score.byType.concept.correct}/${score.byType.concept.total}`);
  if (score.flagged > 0) console.log(`  Flagged:    ${score.flagged}`);
  if (score.weakSpots.length > 0) {
    console.log(`\n${bold('Read these again:')}`);
    for (const file of new Set(score.weakSpots.map((spot) => spot.file))) console.log(`  ${file}`);
  }
}

function saveResult(score: Score) {
  const directory = join(homedir(), '.didiwritethis');
  mkdirSync(directory, { recursive: true });
  const { percent, correct, total, byType, weakSpots } = score;
  const entry = { date: new Date().toISOString(), repo: process.cwd(), percent, correct, total, byType, weakSpots };
  appendFileSync(join(directory, 'history.jsonl'), `${JSON.stringify(entry)}\n`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string' },
      questions: { type: 'string', default: '10' },
      files: { type: 'string', default: '8' },
      out: { type: 'string', default: 'didiwritethis-card.png' },
      'no-card': { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const count = Number(values.questions);
  const maxFiles = Number(values.files);
  if (!Number.isInteger(count) || count < 5 || count > 20) {
    console.error('--questions must be a whole number from 5 to 20.');
    return 2;
  }
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 30) {
    console.error('--files must be a whole number from 1 to 30.');
    return 2;
  }

  const root = repoRoot(process.cwd());
  if (!root) {
    console.error('Run this inside a git repository.');
    return 2;
  }

  const agent = (values.agent ?? detectAgent()) as AgentName | null;
  if (!agent || !AGENTS.includes(agent)) {
    console.error(`No supported agent found. Install one of: ${AGENTS.join(', ')}, or pass --agent.`);
    return 2;
  }
  if (!isInstalled(agent)) {
    console.error(`${agent} is not installed.`);
    return 2;
  }

  const selection = selectFiles(root, { maxFiles });
  if (selection.files.length === 0) {
    console.error('Found no source files with commit history to quiz you on.');
    return 2;
  }
  printSelection(selection, agent);
  if (values.list) return 0;

  const reader = lineReader();
  try {
    if (!values.yes) {
      const reply = await reader.ask('Send these files to your agent? [Y/n] ');
      if (reply === null || !['', 'y', 'yes'].includes(reply.toLowerCase())) {
        console.log('Nothing was sent.');
        return 0;
      }
    }

    let stop = () => {};
    let questions: Question[];
    try {
      questions = await buildQuiz(createRunner(agent), selection.files, count, (message) => {
        stop();
        stop = spinner(message);
      });
    } finally {
      stop();
    }

    console.log(dim(`\n${questions.length} questions. You will not see the code while you answer.`));
    const attempts = await takeQuiz(questions, reader);
    const score = scoreAttempts(attempts);
    if (score.total === 0) {
      console.log('\nNo questions were answered, so there is no score.');
      return 0;
    }

    printScore(score);
    saveResult(score);

    if (!values['no-card']) {
      const path = resolve(values.out);
      const date = new Date().toISOString().slice(0, 10);
      writeFileSync(path, renderCard(score, date));
      console.log(`\n${bold('Score card:')} ${path}`);
      console.log(`${bold('README badge:')}\n${badgeMarkdown(score)}`);
    }
    return 0;
  } finally {
    reader.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`didiwritethis: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
