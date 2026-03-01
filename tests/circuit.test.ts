import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Circuit } from '../src/circuit.js';
import { TopologyStore } from '../src/topology.js';
import { MetadataStore } from '../src/metadata.js';
import { Operations } from '../src/operations.js';
import { IdentityEngine } from '../src/identity.js';
import { CostTracker } from '../src/cost.js';
import { rmSync, existsSync } from 'fs';

const TEST_DIR = '/tmp/organism-test-circuit';
const TRACE_DIR = '/tmp/organism-test-circuit/traces';
const META_DIR = '/tmp/organism-test-circuit/metadata';

function mockClient() {
  return {
    messages: {
      parse: vi.fn()
        .mockResolvedValueOnce({
          // decompose response
          parsed_output: {
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
                ],
              },
            ],
          },
          usage: { input_tokens: 100, output_tokens: 200 },
        })
        .mockResolvedValueOnce({
          // connect response
          parsed_output: {
            results: [
              {
                pairIndex: 0,
                connected: true,
                chain: [
                  { fromConcept: 'firewall', fromFacet: 'barrier', toConcept: 'defense in depth', toFacet: 'layered' },
                ],
                confidence: 0.85,
                domainsCrossed: ['structural'],
              },
            ],
          },
          usage: { input_tokens: 200, output_tokens: 300 },
        })
        .mockResolvedValueOnce({
          // connect response (second concept)
          parsed_output: {
            results: [
              {
                pairIndex: 0,
                connected: false,
                chain: [],
                confidence: 0.3,
                domainsCrossed: [],
              },
            ],
          },
          usage: { input_tokens: 150, output_tokens: 100 },
        })
        .mockResolvedValueOnce({
          // compare response
          parsed_output: {
            appeared: ['firewall → defense in depth'],
            disappeared: [],
            shifted: [],
            crossInputChains: [],
            interpretation: 'Initial security topology forming around structural layering.',
          },
          usage: { input_tokens: 300, output_tokens: 200 },
        }),
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Topology-based answer.' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  } as any;
}

describe('Circuit', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('runs full L2 cycle: decompose → connect → resonance → bridge → decay → compare', async () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR);
    const ops = new Operations(client, costTracker);
    const topology = new TopologyStore(TEST_DIR);
    const circuit = new Circuit(topology, ops, TRACE_DIR);

    const result = await circuit.processInput('A text about security.', 1);

    expect(result.newConcepts).toBe(2);
    expect(result.newChains).toBeGreaterThanOrEqual(0);
    expect(result.comparison.interpretation).toContain('layering');
    expect(result).toHaveProperty('newLatentConnections');
    expect(result).toHaveProperty('bridgesDetected');
    expect(result).toHaveProperty('latentPruned');

    const loaded = new TopologyStore(TEST_DIR);
    expect(loaded.concepts.length).toBeGreaterThanOrEqual(2);
  });

  it('runs with identity engine when provided', async () => {
    const client = mockClient();
    // add identity response
    client.messages.create
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Topology-based answer.' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'This topology understands structural layering.' }],
        usage: { input_tokens: 80, output_tokens: 60 },
      });

    const costTracker = new CostTracker(TEST_DIR, 100);
    const ops = new Operations(client, costTracker);
    const topology = new TopologyStore(TEST_DIR);
    const metadata = new MetadataStore(META_DIR);
    const identityEngine = new IdentityEngine(client, costTracker);
    const circuit = new Circuit(topology, ops, TRACE_DIR, metadata, identityEngine);

    const result = await circuit.processInput('A text about security.', 1);

    expect(result.identityShift).toBe(true);
    expect(metadata.getAllIdentitySnapshots()).toHaveLength(1);
  });

  it('queries topology with L2 result', async () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR);
    const ops = new Operations(client, costTracker);
    const topology = new TopologyStore(TEST_DIR);
    const circuit = new Circuit(topology, ops, TRACE_DIR);

    const result = await circuit.query('What is security?');
    expect(result.answer).toBe('Topology-based answer.');
    expect(result.pathsUsed).toHaveProperty('direct');
    expect(result.pathsUsed).toHaveProperty('transitive');
    expect(result.pathsUsed).toHaveProperty('latent');
  });

  it('reports metrics including latent count', () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR);
    const ops = new Operations(client, costTracker);
    const topology = new TopologyStore(TEST_DIR);
    const circuit = new Circuit(topology, ops, TRACE_DIR);

    const metrics = circuit.getMetrics();
    expect(metrics.conceptCount).toBe(0);
    expect(metrics.chainCount).toBe(0);
    expect(metrics).toHaveProperty('latentConnectionCount');
  });

  it('buildSignalContext returns correct structure from signal data', () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR);
    const ops = new Operations(client, costTracker);
    const topology = new TopologyStore(TEST_DIR);
    const metadata = new MetadataStore(META_DIR);
    const circuit = new Circuit(topology, ops, TRACE_DIR, metadata);

    // Add some concepts for domain counting
    topology.addConcepts([
      { id: 'c1', name: 'firewall', facets: [{ domain: 'structural', attribute: 'barrier', salience: 0.9 }], sourceInput: 1 },
      { id: 'c2', name: 'onion', facets: [{ domain: 'physical', attribute: 'layers', salience: 0.8 }], sourceInput: 2 },
    ]);

    const signal = {
      bridges: [
        { concept: 'firewall', score: 5.0, isArticulationPoint: true, structuralClaim: 'structural:barrier', domains: ['security', 'cooking'], sourceCount: 3 },
      ],
      emergentPaths: [
        { from: 'a', to: 'b', hops: ['c'], weight: 0.5 },
      ],
      rearrangements: [],
      contradictions: [
        { conceptA: 'x', conceptB: 'y', pathA: { intermediates: [], implication: '' }, pathB: { intermediates: [], implication: '' }, tension: 'test tension' },
      ],
      uncertaintyProfile: { density: 0.5, contradictionCount: 1, facetCount: 2, identityOscillation: 0 },
      decayReport: { hubsPenalized: [], bridgesProtected: [], redundantPathsMerged: 0, orphansArchived: [] },
      openQuestions: [],
      delta: { newBridges: [], lostBridges: [], newEmergentPaths: 0, rearrangementsThisRun: 0, questionsOpened: 0, questionsClosed: 0 },
      runNumber: 5,
      timestamp: Date.now(),
    };

    const state = topology.snapshot();
    const context = circuit.buildSignalContext('test?', [], state, signal);

    expect(context.inputCount).toBe(0); // runCount is 0
    expect(context.domainCount).toBe(2); // structural + physical
    expect(context.bridges).toHaveLength(1);
    expect(context.bridges[0].name).toBe('firewall');
    expect(context.bridges[0].structuralClaim).toBe('structural:barrier');
    expect(context.bridges[0].domains).toEqual(['security', 'cooking']);
    expect(context.bridges[0].sourceCount).toBe(3);
    expect(context.emergentPaths).toHaveLength(1);
    expect(context.contradictions).toHaveLength(1);
    expect(context.contradictions[0].description).toContain('test tension');
  });

  it('buildSignalContext handles null signal gracefully', () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR);
    const ops = new Operations(client, costTracker);
    const topology = new TopologyStore(TEST_DIR);
    const metadata = new MetadataStore(META_DIR);
    const circuit = new Circuit(topology, ops, TRACE_DIR, metadata);

    const state = topology.snapshot();
    const context = circuit.buildSignalContext('test?', [], state, null);

    expect(context.bridges).toHaveLength(0);
    expect(context.emergentPaths).toHaveLength(0);
    expect(context.contradictions).toHaveLength(0);
    expect(context.inputCount).toBe(0);
    expect(context.domainCount).toBe(0);
  });

  it('getLastCompletedRun returns topology runCount', async () => {
    const client = mockClient();
    const costTracker = new CostTracker(TEST_DIR);
    const ops = new Operations(client, costTracker);
    const topology = new TopologyStore(TEST_DIR);
    const circuit = new Circuit(topology, ops, TRACE_DIR);

    expect(circuit.getLastCompletedRun()).toBe(0);

    await circuit.processInput('Test.', 5);
    expect(circuit.getLastCompletedRun()).toBe(5);
  });
});
