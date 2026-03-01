import { describe, it, expect, vi } from 'vitest';
import { Operations } from '../src/operations.js';
import { CostTracker } from '../src/cost.js';
import { rmSync, existsSync } from 'fs';

const TEST_DIR = '/tmp/organism-test-crystallize';

function mockClient() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'This text introduces layering as a concept that extends structural security. The idea of defense in depth challenges the notion that a single barrier suffices. Questions arise about how layering relates to temporal patience.' }],
        usage: { input_tokens: 200, output_tokens: 300 },
      }),
      parse: vi.fn().mockResolvedValue({
        parsed_output: {
          concepts: [
            {
              name: 'defense-in-depth',
              facets: [
                { domain: 'structural', attribute: 'structural-layering', salience: 0.95, novelty: true, tension: null },
                { domain: 'process', attribute: 'iterative-reinforcement', salience: 0.8, novelty: false, tension: 'contradicts single-barrier model' },
              ],
            },
            {
              name: 'firewall',
              facets: [
                { domain: 'structural', attribute: 'structural-barrier', salience: 0.9, novelty: false, tension: null },
              ],
            },
          ],
          questions: [
            { text: 'How does layering relate to temporal patience?', relatedConcepts: ['defense-in-depth', 'patience'] },
          ],
        },
        usage: { input_tokens: 300, output_tokens: 400 },
      }),
    },
  } as any;
}

describe('decomposeCrystallize', () => {
  it('phase A produces freeform text, phase B produces structured output', async () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR, 100);
    const ops = new Operations(client, costTracker);

    const result = await ops.decomposeCrystallize('A text about security layering.', {
      topBridges: ['existing-bridge'],
      recentRearrangements: [],
      highUncertaintyRegions: [],
    });

    // Phase A: client.messages.create was called (freeform)
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    // Phase B: client.messages.parse was called (structured)
    expect(client.messages.parse).toHaveBeenCalledTimes(1);

    expect(result.concepts).toHaveLength(2);
    expect(result.questions).toHaveLength(1);
  });

  it('returns domain-qualified attributes and novelty flags', async () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR, 100);
    const ops = new Operations(client, costTracker);

    const result = await ops.decomposeCrystallize('Text.', {
      topBridges: [], recentRearrangements: [], highUncertaintyRegions: [],
    });

    const firstFacet = result.concepts[0].facets[0];
    expect(firstFacet.attribute).toBe('structural-layering');
    expect(firstFacet.novelty).toBe(true);
  });

  it('questions extracted and returned', async () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR, 100);
    const ops = new Operations(client, costTracker);

    const result = await ops.decomposeCrystallize('Text.', {
      topBridges: [], recentRearrangements: [], highUncertaintyRegions: [],
    });

    expect(result.questions[0].text).toContain('layering');
    expect(result.questions[0].relatedConcepts).toContain('defense-in-depth');
  });

  it('old decompose() still works (backward compat)', async () => {
    const client = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: {
            concepts: [
              { name: 'test', facets: [{ domain: 'abstract', attribute: 'testing', salience: 0.8 }] },
            ],
          },
          usage: { input_tokens: 50, output_tokens: 100 },
        }),
        create: vi.fn(),
      },
    } as any;
    const costTracker = new CostTracker(TEST_DIR, 100);
    const ops = new Operations(client, costTracker);

    const result = await ops.decompose('Simple test text.');
    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0].name).toBe('test');
  });

  it('cost tracked as two separate operations', async () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR, 100);
    const ops = new Operations(client, costTracker);

    await ops.decomposeCrystallize('Text.', {
      topBridges: [], recentRearrangements: [], highUncertaintyRegions: [],
    });

    const summary = costTracker.summarize();
    expect(summary.byOperation['decompose-think']).toBeDefined();
    expect(summary.byOperation['decompose-extract']).toBeDefined();
  });
});
