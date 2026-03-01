import { describe, it, expect, vi } from 'vitest';
import { evaluatePathSemantic, evaluateRearrangement, findContradictions } from '../src/evaluator.js';
import { CostTracker } from '../src/cost.js';
import type { TopologyState } from '../src/types.js';
import type { TransitivePath } from '../src/traversal.js';
import type { RearrangementEvent } from '../src/analysis.js';

const TEST_DIR = '/tmp/organism-test-evaluator';

function mockClient() {
  return {
    messages: {
      parse: vi.fn(),
      create: vi.fn(),
    },
  } as any;
}

describe('evaluatePathSemantic', () => {
  it('returns scores in 1-5 range', async () => {
    const client = mockClient();
    client.messages.parse.mockResolvedValueOnce({
      parsed_output: { surprise: 4, validity: 3, insight: 5, meaning: 'Security and cooking share layering patterns' },
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const costTracker = new CostTracker(TEST_DIR, 100);

    const path: TransitivePath = {
      from: 'firewall', to: 'onion', hops: ['defense-in-depth'],
      weight: 0.5, sourceInputsSpanned: [1, 3, 5], depth: 2, chainIds: [],
    };

    const score = await evaluatePathSemantic(path, { concepts: [], chains: [], latentConnections: [], runCount: 5 }, client, costTracker);

    expect(score.surprise).toBe(4);
    expect(score.validity).toBe(3);
    expect(score.insight).toBe(5);
    expect(score.compositeScore).toBe(4);
    expect(score.isShallow).toBe(false);
    expect(score.meaning).toContain('layering');
  });

  it('marks shallow paths correctly', async () => {
    const client = mockClient();
    client.messages.parse.mockResolvedValueOnce({
      parsed_output: { surprise: 1, validity: 1, insight: 1, meaning: 'Trivial connection' },
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const costTracker = new CostTracker(TEST_DIR, 100);

    const path: TransitivePath = {
      from: 'a', to: 'b', hops: ['c'], weight: 0.1,
      sourceInputsSpanned: [1], depth: 1, chainIds: [],
    };

    const score = await evaluatePathSemantic(path, { concepts: [], chains: [], latentConnections: [], runCount: 1 }, client, costTracker);
    expect(score.isShallow).toBe(true);
    expect(score.compositeScore).toBe(1);
  });
});

describe('evaluateRearrangement', () => {
  it('returns all 4 fields', async () => {
    const client = mockClient();
    client.messages.parse.mockResolvedValueOnce({
      parsed_output: { specificity: 4, depth: 3, crossDomain: 5, genuine: 4 },
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const costTracker = new CostTracker(TEST_DIR, 100);

    const event: RearrangementEvent = {
      endpoints: ['a', 'b'], fromRun: 1, toRun: 10,
      oldIntermediates: ['x'], newIntermediates: ['y'], domainShift: true,
    };

    const score = await evaluateRearrangement(event, client, costTracker);
    expect(score.specificity).toBe(4);
    expect(score.depth).toBe(3);
    expect(score.crossDomain).toBe(5);
    expect(score.genuine).toBe(4);
  });
});

describe('findContradictions', () => {
  it('returns empty for topology with no multi-path pairs', async () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR, 100);

    const topology: TopologyState = {
      concepts: [
        { id: 'c1', name: 'a', facets: [], sourceInput: 1 },
        { id: 'c2', name: 'b', facets: [], sourceInput: 2 },
      ],
      chains: [
        { id: 'ch1', fromConcept: 'a', toConcept: 'b', steps: [], depth: 1, domainsCrossed: [], confidence: 0.8, weight: 0.9, createdAtRun: 1, lastTraversedRun: 1 },
      ],
      latentConnections: [],
      runCount: 5,
    };

    const contradictions = await findContradictions(topology, client, costTracker);
    expect(contradictions).toHaveLength(0);
    expect(client.messages.parse).not.toHaveBeenCalled();
  });

  it('cost tracked per evaluation', async () => {
    const client = mockClient();
    client.messages.parse.mockResolvedValueOnce({
      parsed_output: { surprise: 3, validity: 3, insight: 3, meaning: 'test' },
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const isolatedDir = '/tmp/organism-test-evaluator-cost';
    const costTracker = new CostTracker(isolatedDir, 100);
    costTracker.reset();

    const path: TransitivePath = {
      from: 'a', to: 'b', hops: ['c'], weight: 0.5,
      sourceInputsSpanned: [1, 2], depth: 2, chainIds: [],
    };

    await evaluatePathSemantic(path, { concepts: [], chains: [], latentConnections: [], runCount: 1 }, client, costTracker);
    const summary = costTracker.summarize();
    expect(summary.byOperation['evaluate-path']).toBeDefined();
    expect(summary.byOperation['evaluate-path'].count).toBe(1);
  });
});
