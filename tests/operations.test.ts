import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Operations } from '../src/operations.js';
import { CostTracker } from '../src/cost.js';
import { rmSync, existsSync } from 'fs';
import type { TopologyState } from '../src/types.js';

const TEST_DIR = '/tmp/organism-test-ops';

function mockClient(parsedOutput: unknown, usage = { input_tokens: 100, output_tokens: 50 }) {
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: parsedOutput,
        usage,
        content: [{ type: 'text', text: '' }],
      }),
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'mock response' }],
        usage,
      }),
    },
  } as any;
}

describe('Operations', () => {
  let costTracker: CostTracker;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    costTracker = new CostTracker(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('decompose', () => {
    it('extracts concepts from text', async () => {
      const client = mockClient({
        concepts: [
          {
            name: 'firewall',
            facets: [
              { domain: 'structural', attribute: 'barrier', salience: 0.9 },
              { domain: 'process', attribute: 'filtering', salience: 0.7 },
            ],
          },
          {
            name: 'defense in depth',
            facets: [
              { domain: 'structural', attribute: 'layered', salience: 0.95 },
              { domain: 'abstract', attribute: 'redundancy', salience: 0.8 },
            ],
          },
        ],
      });

      const ops = new Operations(client, costTracker);
      const result = await ops.decompose('A text about security concepts.');

      expect(result.concepts).toHaveLength(2);
      expect(result.concepts[0].name).toBe('firewall');
      expect(result.concepts[0].facets).toHaveLength(2);
      expect(client.messages.parse).toHaveBeenCalledOnce();

      const callArgs = client.messages.parse.mock.calls[0][0];
      expect(callArgs.model).toContain('haiku');
      expect(callArgs.messages[0].content).toContain('security concepts');
    });

    it('tracks cost', async () => {
      const client = mockClient(
        { concepts: [] },
        { input_tokens: 200, output_tokens: 100 }
      );
      const ops = new Operations(client, costTracker);
      await ops.decompose('test');
      expect(costTracker.totalCost).toBeGreaterThan(0);
    });
  });

  describe('connect', () => {
    it('returns connections for valid pairs', async () => {
      const client = mockClient({
        results: [
          {
            pairIndex: 0,
            connected: true,
            chain: [
              { fromConcept: 'firewall', fromFacet: 'barrier', toConcept: 'onion', toFacet: 'layers' },
            ],
            confidence: 0.8,
            domainsCrossed: ['structural', 'physical'],
          },
        ],
      });

      const ops = new Operations(client, costTracker);
      const results = await ops.connect(
        [
          {
            facetA: { concept: 'firewall', facet: { domain: 'structural', attribute: 'barrier', salience: 0.9 } },
            facetB: { concept: 'onion', facet: { domain: 'physical', attribute: 'layers', salience: 0.8 } },
          },
        ],
        'some context'
      );

      expect(results).toHaveLength(1);
      expect(results[0]).not.toBeNull();
      expect(results[0]!.confidence).toBe(0.8);
    });

    it('returns null for low confidence connections', async () => {
      const client = mockClient({
        results: [
          {
            pairIndex: 0,
            connected: true,
            chain: [],
            confidence: 0.3,
            domainsCrossed: [],
          },
        ],
      });

      const ops = new Operations(client, costTracker);
      const results = await ops.connect(
        [
          {
            facetA: { concept: 'a', facet: { domain: 'abstract', attribute: 'x', salience: 0.5 } },
            facetB: { concept: 'b', facet: { domain: 'abstract', attribute: 'y', salience: 0.5 } },
          },
        ],
        ''
      );

      expect(results[0]).toBeNull();
    });

    it('returns empty array for empty pairs', async () => {
      const client = mockClient({});
      const ops = new Operations(client, costTracker);
      const results = await ops.connect([], '');
      expect(results).toEqual([]);
    });

    it('batches pairs in prompt', async () => {
      const client = mockClient({
        results: [
          { pairIndex: 0, connected: false, chain: [], confidence: 0, domainsCrossed: [] },
          { pairIndex: 1, connected: false, chain: [], confidence: 0, domainsCrossed: [] },
        ],
      });

      const ops = new Operations(client, costTracker);
      await ops.connect(
        [
          {
            facetA: { concept: 'a', facet: { domain: 'x', attribute: 'x', salience: 0.5 } },
            facetB: { concept: 'b', facet: { domain: 'y', attribute: 'y', salience: 0.5 } },
          },
          {
            facetA: { concept: 'c', facet: { domain: 'x', attribute: 'x', salience: 0.5 } },
            facetB: { concept: 'd', facet: { domain: 'y', attribute: 'y', salience: 0.5 } },
          },
        ],
        ''
      );

      // should be a single API call with both pairs
      expect(client.messages.parse).toHaveBeenCalledOnce();
      const prompt = client.messages.parse.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('Pair 0');
      expect(prompt).toContain('Pair 1');
    });
  });

  describe('compare', () => {
    it('returns comparison result', async () => {
      const client = mockClient({
        appeared: ['firewall → onion (structural layering)'],
        disappeared: [],
        shifted: [],
        crossInputChains: ['security:defense-in-depth → cooking:layered-flavors'],
        interpretation: 'Both domains share structural layering patterns.',
      });

      const ops = new Operations(client, costTracker);
      const prev: TopologyState = { concepts: [], chains: [], latentConnections: [], runCount: 0 };
      const curr: TopologyState = {
        concepts: [
          { id: 'c1', name: 'firewall', facets: [], sourceInput: 1 },
        ],
        chains: [],
        latentConnections: [],
        runCount: 1,
      };

      const result = await ops.compare(prev, curr);
      expect(result.crossInputChains).toHaveLength(1);
      expect(result.interpretation).toContain('layering');
    });
  });

  describe('queryWithTopology', () => {
    it('calls sonnet with topology context', async () => {
      const client = mockClient({});
      const ops = new Operations(client, costTracker);

      const result = await ops.queryWithTopology('What connects A to B?', {
        concepts: [{ id: 'c1', name: 'A', facets: [{ domain: 'abstract', attribute: 'x', salience: 0.9 }], sourceInput: 1 }],
        chains: [],
        latentConnections: [],
        runCount: 1,
      });

      expect(result).toBe('mock response');
      expect(client.messages.create).toHaveBeenCalledOnce();
      const prompt = client.messages.create.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('topology');
      expect(prompt).toContain('What connects A to B?');
    });
  });

  describe('queryWithFlatMemory', () => {
    it('calls sonnet with flat memory context', async () => {
      const client = mockClient({});
      const ops = new Operations(client, costTracker);

      const result = await ops.queryWithFlatMemory('What connects A to B?', 'Some memory content.');
      expect(result).toBe('mock response');
      expect(client.messages.create).toHaveBeenCalledOnce();
    });
  });

  describe('queryWithSignal', () => {
    it('constructs prompt with bridges, paths, and contradictions', async () => {
      const client = mockClient({});
      const ops = new Operations(client, costTracker);

      const context = {
        inputCount: 50,
        domainCount: 7,
        bridges: [
          { name: 'layering', structuralClaim: 'structural:barrier, process:filtering', domains: ['security', 'cooking'], sourceCount: 5 },
        ],
        emergentPaths: [
          { from: 'firewall', to: 'onion', hops: ['defense', 'layers'], weight: 0.8 },
        ],
        contradictions: [
          { description: 'simplicity vs complexity: opposing design philosophies' },
        ],
      };

      const result = await ops.queryWithSignal('What connects security to cooking?', context);
      expect(result).toBe('mock response');

      const prompt = client.messages.create.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('50 diverse sources');
      expect(prompt).toContain('7 domains');
      expect(prompt).toContain('BRIDGE: "layering"');
      expect(prompt).toContain('security, cooking');
      expect(prompt).toContain('5 independent sources');
      expect(prompt).toContain('HIDDEN CONNECTIONS');
      expect(prompt).toContain('firewall → onion');
      expect(prompt).toContain('UNRESOLVED TENSIONS');
      expect(prompt).toContain('simplicity vs complexity');
    });

    it('handles empty context gracefully', async () => {
      const client = mockClient({});
      const ops = new Operations(client, costTracker);

      const context = {
        inputCount: 0,
        domainCount: 0,
        bridges: [],
        emergentPaths: [],
        contradictions: [],
      };

      const result = await ops.queryWithSignal('Test question?', context);
      expect(result).toBe('mock response');
      expect(client.messages.create).toHaveBeenCalledOnce();
    });

    it('tracks cost correctly', async () => {
      const client = mockClient({}, { input_tokens: 500, output_tokens: 200 });
      const ops = new Operations(client, costTracker);

      await ops.queryWithSignal('Test?', {
        inputCount: 10, domainCount: 3,
        bridges: [], emergentPaths: [], contradictions: [],
      });

      expect(costTracker.totalCost).toBeGreaterThan(0);
    });
  });

  describe('budget enforcement', () => {
    it('throws when budget exceeded', async () => {
      const tracker = new CostTracker(TEST_DIR, 0.001); // tiny budget
      tracker.record('test', 'claude-sonnet-4-6', 10000, 10000); // exceed it

      const client = mockClient({ concepts: [] });
      const ops = new Operations(client, tracker);
      await expect(ops.decompose('test')).rejects.toThrow('Budget cap exceeded');
    });
  });
});
