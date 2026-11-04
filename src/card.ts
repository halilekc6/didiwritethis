import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { QUESTION_TYPES, type QuestionType } from './quiz.js';
import type { Score } from './score.js';

const asset = (name: string) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));

const LABELS: Record<QuestionType, string> = {
  debug: 'Debugging',
  read: 'Reading',
  concept: 'Concepts',
};

const INK = '#f4f1ea';
const QUIET = '#9b978c';
const TRACK = '#34322c';
const BACKGROUND = '#17160f';

export function accentFor(percent: number): string {
  if (percent >= 80) return '#7bd88f';
  if (percent >= 50) return '#ffd166';
  return '#ff6b5e';
}

const escapeXml = (text: string) =>
  text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function cardSvg(score: Score, date: string): string {
  const accent = accentFor(score.percent);
  const bars = QUESTION_TYPES.filter((type) => score.byType[type].total > 0)
    .map((type, index) => {
      const { correct, total } = score.byType[type];
      const y = 232 + index * 92;
      const width = Math.round((correct / total) * 460);
      return `
  <text x="660" y="${y}" font-size="30" fill="${INK}">${LABELS[type]}</text>
  <text x="1120" y="${y}" font-size="30" fill="${QUIET}" text-anchor="end">${correct}/${total}</text>
  <rect x="660" y="${y + 18}" width="460" height="14" rx="7" fill="${TRACK}"/>
  ${width > 0 ? `<rect x="660" y="${y + 18}" width="${Math.max(width, 14)}" height="14" rx="7" fill="${accent}"/>` : ''}`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="JetBrains Mono">
  <rect width="1200" height="630" fill="${BACKGROUND}"/>
  <text x="80" y="104" font-size="34" font-weight="700" fill="${INK}">Did I write this?</text>
  <text x="80" y="344" font-size="190" font-weight="700" fill="${accent}">${score.percent}%</text>
  <text x="80" y="408" font-size="30" fill="${INK}">of my own repo understood</text>
  <text x="80" y="464" font-size="34" font-weight="700" fill="${INK}">${escapeXml(score.rank.name)}</text>
  <text x="80" y="508" font-size="24" fill="${QUIET}">${escapeXml(score.rank.line)}</text>${bars}
  <text x="80" y="576" font-size="26" fill="${accent}">npx didiwritethis</text>
  <text x="1120" y="576" font-size="24" fill="${QUIET}" text-anchor="end">${escapeXml(date)}</text>
</svg>`;
}

export function renderCard(score: Score, date: string): Buffer {
  const resvg = new Resvg(cardSvg(score, date), {
    fitTo: { mode: 'width', value: 1200 },
    font: {
      loadSystemFonts: false,
      fontFiles: [asset('JetBrainsMono-Regular.ttf'), asset('JetBrainsMono-Bold.ttf')],
      defaultFontFamily: 'JetBrains Mono',
    },
  });
  return resvg.render().asPng();
}

export function badgeMarkdown(score: Score): string {
  const color = accentFor(score.percent).slice(1);
  const label = encodeURIComponent('understood by me');
  const message = encodeURIComponent(`${score.percent}% ${score.rank.name}`);
  return `[![${score.percent}% understood](https://img.shields.io/badge/${label}-${message}-${color})](https://www.npmjs.com/package/didiwritethis)`;
}
