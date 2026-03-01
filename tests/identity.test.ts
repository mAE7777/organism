import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdentityEngine } from '../src/identity.js';
import { CostTracker } from '../src/cost.js';
import { rmSync, existsSync } from 'fs';
import type { TopologyState, BridgeConcept, IdentitySnapshot } from '../src/types.js';

const TEST_DIR = '/tmp/organism-test-identity';

function mockClient(responseText: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
        usage: { input_tokens: 100, output_tokens: 80 },
      }),
    },
  } as any;
}

function makeTopology(conceptCount: number, chainCount: number, run: number): TopologyState {
  const concepts = Array.from({ length: conceptCount }, (_, i) => ({
    id: `c${i}`,
    name: `concept-${i}`,
    facets: [{ domain: 'structural', attribute: `attr-${i}`, salience: 0.8 }],
    sourceInput: i + 1,
  }));

  const chains = Array.from({ length: chainCount }, (_, i) => ({
    id: `ch${i}`,
    fromConcept: `concept-${i}`,
    toConcept: `concept-${(i + 1) % conceptCount}`,
    steps: [],
    depth: 1,
    domainsCrossed: ['structural'],
    confidence: 0.8,
    weight: 0.9,
    createdAtRun: 1,
    lastTraversedRun: run,
  }));

  return { concepts, chains, latentConnections: [], runCount: run };
}

describe('IdentityEngine', () => {
  let costTracker: CostTracker;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    costTracker = new CostTracker(TEST_DIR, 100);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('generates first-run snapshot without previous identity', async () => {
    const client = mockClient('This topology is starting to form connections around structural concepts.');
    const engine = new IdentityEngine(client, costTracker);
    const topology = makeTopology(5, 3, 1);
    const bridges: BridgeConcept[] = [
      { conceptId: 'c0', bridgeScore: 5.0, uniqueSourceInputs: 3, uniqueDomains: 2, chainsThrough: 4, discoveredAtRun: 1 },
    ];

    const snapshot = await engine.generateSnapshot(topology, bridges, undefined, [], { chains: 0, latent: 0 }, 1);

    expect(snapshot.run).toBe(1);
    expect(snapshot.description).toContain('structural');
    expect(snapshot.topBridges).toContain('concept-0');
    expect(client.messages.create).toHaveBeenCalledOnce();

    const prompt = client.messages.create.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain('Previous self-description');
  });

  it('includes previous identity in prompt when available', async () => {
    const client = mockClient('The topology has expanded with new connections.');
    const engine = new IdentityEngine(client, costTracker);
    const topology = makeTopology(10, 8, 5);

    const previousIdentity: IdentitySnapshot = {
      run: 1,
      description: 'Initial topology forming.',
      topBridges: ['concept-0'],
      dominantDomains: ['structural'],
      recentShifts: [],
    };

    const snapshot = await engine.generateSnapshot(topology, [], previousIdentity, [], { chains: 2, latent: 1 }, 5);

    const prompt = client.messages.create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Previous self-description');
    expect(prompt).toContain('Initial topology forming.');
    expect(snapshot.recentShifts).toContain('2 direct chain(s) pruned by decay');
    expect(snapshot.recentShifts).toContain('1 latent connection(s) pruned by decay');
  });

  it('includes rearrangement shifts', async () => {
    const client = mockClient('Connections rearranging.');
    const engine = new IdentityEngine(client, costTracker);
    const topology = makeTopology(5, 3, 10);

    const rearrangements = [
      { endpoints: ['a', 'b'] as [string, string], fromRun: 1, toRun: 10, oldIntermediates: ['x'], newIntermediates: ['y'], domainShift: true },
    ];

    const snapshot = await engine.generateSnapshot(topology, [], undefined, rearrangements, { chains: 0, latent: 0 }, 10);
    expect(snapshot.recentShifts).toContain('1 connection path(s) rearranged');
  });

  it('formatForDecompose produces context string', () => {
    const client = mockClient('');
    const engine = new IdentityEngine(client, costTracker);

    const snapshot: IdentitySnapshot = {
      run: 5,
      description: 'The topology sees layering patterns across security and cooking.',
      topBridges: ['layering', 'defense'],
      dominantDomains: ['structural', 'process'],
      recentShifts: [],
    };

    const context = engine.formatForDecompose(snapshot);
    expect(context).toContain('after 5 inputs');
    expect(context).toContain('layering patterns');
    expect(context).toContain('layering, defense');
    expect(context).toContain('structural, process');
  });
});
