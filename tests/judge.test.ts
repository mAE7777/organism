import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Judge } from '../src/judge.js';
import { CostTracker } from '../src/cost.js';
import { rmSync, existsSync } from 'fs';

const TEST_DIR = '/tmp/organism-test-judge';

function mockClient(winner: 'A' | 'B' | 'tie', scoresA = { insightDepth: 7, crossDomainSynthesis: 8, specificity: 6, surprise: 7 }, scoresB = { insightDepth: 5, crossDomainSynthesis: 4, specificity: 6, surprise: 3 }) {
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: {
          winner,
          reasoning: 'Answer A showed deeper cross-domain connections.',
          scores: { A: scoresA, B: scoresB },
        },
        usage: { input_tokens: 500, output_tokens: 200 },
      }),
    },
  } as any;
}

describe('Judge', () => {
  let costTracker: CostTracker;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    costTracker = new CostTracker(TEST_DIR, 100);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns judge result with scores', async () => {
    const client = mockClient('A');
    const judge = new Judge(client, costTracker);

    const result = await judge.blindCompare(
      'What connects security to cooking?',
      'Topology answer with deep chains.',
      'Baseline answer with flat memory.',
    );

    expect(result.scores.A).toHaveProperty('insightDepth');
    expect(result.scores.A).toHaveProperty('crossDomainSynthesis');
    expect(result.scores.A).toHaveProperty('specificity');
    expect(result.scores.A).toHaveProperty('surprise');
    expect(result.reasoning).toBeTruthy();
    expect(client.messages.parse).toHaveBeenCalledOnce();
  });

  it('records presentation order for bias tracking', async () => {
    const client = mockClient('A');
    const judge = new Judge(client, costTracker);

    const result = await judge.blindCompare(
      'Test question',
      'Topology answer.',
      'Baseline answer.',
    );

    expect(result.presentationOrder).toHaveProperty('first');
    expect(result.presentationOrder).toHaveProperty('second');
    expect(['topology', 'baseline']).toContain(result.presentationOrder.first);
    expect(['topology', 'baseline']).toContain(result.presentationOrder.second);
    expect(result.presentationOrder.first).not.toBe(result.presentationOrder.second);
  });

  it('handles tie result', async () => {
    const client = mockClient('tie',
      { insightDepth: 7, crossDomainSynthesis: 6, specificity: 6, surprise: 5 },
      { insightDepth: 7, crossDomainSynthesis: 6, specificity: 6, surprise: 5 },
    );
    const judge = new Judge(client, costTracker);

    const result = await judge.blindCompare('Test', 'A answer.', 'B answer.');
    expect(result.winner).toBe('tie');
  });

  it('tracks cost', async () => {
    const client = mockClient('A');
    const judge = new Judge(client, costTracker);

    await judge.blindCompare('Test', 'A', 'B');
    expect(costTracker.totalCost).toBeGreaterThan(0);
  });
});
