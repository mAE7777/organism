import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { CostTracker } from './cost.js';
import { withRetry } from './operations.js';

const SONNET = 'claude-sonnet-4-6';

const JudgeSchema = {
  type: 'object',
  properties: {
    winner: { type: 'string', enum: ['A', 'B', 'tie'] },
    reasoning: { type: 'string' },
    scores: {
      type: 'object',
      properties: {
        A: {
          type: 'object',
          properties: {
            insightDepth: { type: 'number' },
            crossDomainSynthesis: { type: 'number' },
            specificity: { type: 'number' },
            surprise: { type: 'number' },
          },
          required: ['insightDepth', 'crossDomainSynthesis', 'specificity', 'surprise'],
          additionalProperties: false,
        },
        B: {
          type: 'object',
          properties: {
            insightDepth: { type: 'number' },
            crossDomainSynthesis: { type: 'number' },
            specificity: { type: 'number' },
            surprise: { type: 'number' },
          },
          required: ['insightDepth', 'crossDomainSynthesis', 'specificity', 'surprise'],
          additionalProperties: false,
        },
      },
      required: ['A', 'B'],
      additionalProperties: false,
    },
  },
  required: ['winner', 'reasoning', 'scores'],
  additionalProperties: false,
} as const;

export interface JudgeScores {
  insightDepth: number;
  crossDomainSynthesis: number;
  specificity: number;
  surprise: number;
}

export interface JudgeResult {
  winner: 'A' | 'B' | 'tie';
  reasoning: string;
  scores: { A: JudgeScores; B: JudgeScores };
  presentationOrder: { first: 'topology' | 'baseline'; second: 'topology' | 'baseline' };
}

export class Judge {
  private client: Anthropic;
  private costTracker: CostTracker;

  constructor(client: Anthropic, costTracker: CostTracker) {
    this.client = client;
    this.costTracker = costTracker;
  }

  async blindCompare(
    question: string,
    topologyAnswer: string,
    baselineAnswer: string,
  ): Promise<JudgeResult> {
    this.costTracker.checkBudget();

    // Randomize order to eliminate position bias
    const topologyFirst = Math.random() < 0.5;
    const answerA = topologyFirst ? topologyAnswer : baselineAnswer;
    const answerB = topologyFirst ? baselineAnswer : topologyAnswer;

    const message = await withRetry(() => this.client.messages.parse({
      model: SONNET,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `You are judging two answers to the same question. Rate each on a 1-10 scale for four criteria, then pick a winner.

Question: ${question}

Answer A:
${answerA}

Answer B:
${answerB}

Rate each answer on:
1. Insight depth (1-10): How deep does the analysis go beyond surface observations?
2. Cross-domain synthesis (1-10): How well does it connect ideas across different fields?
3. Specificity (1-10): How concrete and specific are the claims (vs generic platitudes)?
4. Surprise (1-10): Does it surface connections or insights that are genuinely non-obvious?

Then pick a winner: "A", "B", or "tie". Explain your reasoning.`,
        },
      ],
      output_config: {
        format: jsonSchemaOutputFormat(JudgeSchema),
      },
    }));

    this.costTracker.record(
      'judge',
      SONNET,
      message.usage.input_tokens,
      message.usage.output_tokens,
    );

    const parsed = message.parsed_output as {
      winner: 'A' | 'B' | 'tie';
      reasoning: string;
      scores: { A: JudgeScores; B: JudgeScores };
    };

    // Map back from presentation order to actual systems
    const winnerA: 'A' | 'B' = topologyFirst ? 'A' : 'B';
    const winnerB: 'A' | 'B' = topologyFirst ? 'B' : 'A';
    const mappedWinner: 'A' | 'B' | 'tie' = parsed.winner === 'tie'
      ? 'tie'
      : parsed.winner === 'A'
        ? winnerA
        : winnerB;

    // Re-key scores to match actual presentation
    const mappedScores = topologyFirst
      ? { A: parsed.scores.A, B: parsed.scores.B }
      : { A: parsed.scores.B, B: parsed.scores.A };

    return {
      winner: mappedWinner,
      reasoning: parsed.reasoning,
      scores: mappedScores,
      presentationOrder: {
        first: topologyFirst ? 'topology' : 'baseline',
        second: topologyFirst ? 'baseline' : 'topology',
      },
    };
  }
}
