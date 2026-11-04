import { QUESTION_TYPES, type Question, type QuestionType } from './quiz.js';

export interface Attempt {
  question: Question;
  /** Chosen option index, or null when the user flagged the question as wrong. */
  choice: number | null;
}

export interface Tally {
  correct: number;
  total: number;
}

export interface Rank {
  name: string;
  line: string;
}

export interface Score extends Tally {
  percent: number;
  rank: Rank;
  byType: Record<QuestionType, Tally>;
  flagged: number;
  weakSpots: { file: string; symbol: string; type: QuestionType }[];
}

export function rankFor(percent: number): Rank {
  if (percent >= 70) return { name: 'Pilot', line: 'You are flying this thing.' };
  if (percent >= 40) return { name: 'Copilot', line: 'You know the route, not the engine.' };
  return { name: 'Passenger', line: 'Your agent is flying. You are in seat 34B.' };
}

export function scoreAttempts(attempts: Attempt[]): Score {
  const counted = attempts.filter((attempt) => attempt.choice !== null);
  const wrong = counted.filter((attempt) => attempt.choice !== attempt.question.answer);
  const correct = counted.length - wrong.length;
  const percent = counted.length === 0 ? 0 : Math.round((correct / counted.length) * 100);

  const byType = Object.fromEntries(
    QUESTION_TYPES.map((type) => {
      const ofType = counted.filter((attempt) => attempt.question.type === type);
      return [
        type,
        {
          correct: ofType.filter((attempt) => attempt.choice === attempt.question.answer).length,
          total: ofType.length,
        },
      ];
    }),
  ) as Record<QuestionType, Tally>;

  return {
    correct,
    total: counted.length,
    percent,
    rank: rankFor(percent),
    byType,
    flagged: attempts.length - counted.length,
    weakSpots: wrong.map(({ question: { file, symbol, type } }) => ({ file, symbol, type })),
  };
}
