import { describe, it, expect } from 'vitest';
import { emitSignal } from '../src/signals.js';
import type { TopologyState, BridgeConcept, PrunerResult, TopologySignal } from '../src/types.js';
import type { RearrangementEvent } from '../src/analysis.js';
import type { TransitivePath } from '../src/traversal.js';

function makeState(concepts: number, chains: number): TopologyState {
  return {
    concepts: Array.from({ length: concepts }, (_, i) => ({
      id: `c${i}`, name: `concept-${i}`,
      facets: [{ domain: 'structural', attribute: `attr-${i}`, salience: 0.9 }],
      sourceInput: i + 1,
    })),
    chains: Array.from({ length: chains }, (_, i) => ({
      id: `ch${i}`, fromConcept: `concept-${i}`, toConcept: `concept-${(i + 1) % concepts}`,
      steps: [], depth: 1, domainsCrossed: ['structural'], confidence: 0.8,
      weight: 0.9, createdAtRun: 1, lastTraversedRun: 1,
    })),
    latentConnections: [],
    runCount: 5,
    questions: [
      { id: 'q1', text: 'Open question?', sourceInput: 1, relatedConcepts: [], status: 'open' as const },
      { id: 'q2', text: 'Addressed?', sourceInput: 2, relatedConcepts: [], status: 'addressed' as const, addressedByInput: 3 },
    ],
  };
}

function makeBridges(): BridgeConcept[] {
  return [
    { conceptId: 'c0', bridgeScore: 5.0, uniqueSourceInputs: 3, uniqueDomains: 2, chainsThrough: 4, discoveredAtRun: 3 },
    { conceptId: 'c1', bridgeScore: 3.0, uniqueSourceInputs: 2, uniqueDomains: 2, chainsThrough: 2, discoveredAtRun: 4 },
  ];
}

const emptyPrunerResult: PrunerResult = {
  hubsPenalized: ['hub-a'], bridgesProtected: ['bridge-b'],
  redundantPathsMerged: 0, orphansArchived: [],
};

const emptyRearrangements: RearrangementEvent[] = [];
const emptyPaths: TransitivePath[] = [];

describe('emitSignal', () => {
  it('populates all 10 fields', () => {
    const state = makeState(3, 3);
    const signal = emitSignal(state, null, makeBridges(), [], emptyPrunerResult, emptyRearrangements, emptyPaths, 5);

    expect(signal.bridges).toHaveLength(2);
    expect(signal.emergentPaths).toBeDefined();
    expect(signal.rearrangements).toBeDefined();
    expect(signal.contradictions).toEqual([]);
    expect(signal.uncertaintyProfile).toBeDefined();
    expect(signal.decayReport).toBeDefined();
    expect(signal.openQuestions).toHaveLength(1);
    expect(signal.delta).toBeDefined();
    expect(signal.runNumber).toBe(5);
    expect(signal.timestamp).toBeGreaterThan(0);
  });

  it('delta correctly computed with previous signal', () => {
    const state = makeState(3, 3);
    const prev: TopologySignal = {
      bridges: [{ concept: 'concept-0', score: 5.0, isArticulationPoint: false }],
      emergentPaths: [{ from: 'a', to: 'b', hops: ['c'], weight: 0.5 }],
      rearrangements: [],
      contradictions: [],
      uncertaintyProfile: { density: 0.5, contradictionCount: 0, facetCount: 3, identityOscillation: 0 },
      decayReport: emptyPrunerResult,
      openQuestions: [{ id: 'q1', text: 'test', sourceInput: 1, relatedConcepts: [], status: 'open' }],
      delta: { newBridges: [], lostBridges: [], newEmergentPaths: 0, rearrangementsThisRun: 0, questionsOpened: 0, questionsClosed: 0 },
      runNumber: 4,
      timestamp: Date.now() - 1000,
    };

    const signal = emitSignal(state, prev, makeBridges(), [], emptyPrunerResult, emptyRearrangements, emptyPaths, 5);

    // concept-1 is new bridge, concept-0 still present
    expect(signal.delta.newBridges).toContain('concept-1');
    expect(signal.delta.lostBridges).toHaveLength(0);
  });

  it('no LM dependency', () => {
    const state = makeState(2, 1);
    const signal = emitSignal(state, null, [], [], emptyPrunerResult, [], [], 1);
    expect(signal).toBeDefined();
  });

  it('empty topology produces valid signal', () => {
    const state: TopologyState = { concepts: [], chains: [], latentConnections: [], runCount: 0 };
    const signal = emitSignal(state, null, [], [], emptyPrunerResult, [], [], 0);
    expect(signal.bridges).toHaveLength(0);
    expect(signal.emergentPaths).toHaveLength(0);
    expect(signal.uncertaintyProfile.density).toBe(0);
  });

  it('bridges correctly marked as articulation points', () => {
    const state = makeState(3, 3);
    const signal = emitSignal(state, null, makeBridges(), ['concept-0'], emptyPrunerResult, [], [], 5);
    const bridge0 = signal.bridges.find(b => b.concept === 'concept-0');
    const bridge1 = signal.bridges.find(b => b.concept === 'concept-1');
    expect(bridge0?.isArticulationPoint).toBe(true);
    expect(bridge1?.isArticulationPoint).toBe(false);
  });

  it('bridges include structuralClaim, domains, and sourceCount', () => {
    const state = makeState(3, 3);
    const signal = emitSignal(state, null, makeBridges(), [], emptyPrunerResult, emptyRearrangements, emptyPaths, 5);

    expect(signal.bridges[0].structuralClaim).toBeDefined();
    expect(signal.bridges[0].domains).toBeDefined();
    expect(signal.bridges[0].sourceCount).toBeDefined();
    expect(signal.bridges[0].sourceCount).toBe(3); // from makeBridges
    expect(typeof signal.bridges[0].structuralClaim).toBe('string');
    expect(Array.isArray(signal.bridges[0].domains)).toBe(true);
  });

  it('rearrangements filtered by run', () => {
    const state = makeState(3, 3);
    const rearrangements: RearrangementEvent[] = [
      { endpoints: ['a', 'b'], fromRun: 3, toRun: 5, oldIntermediates: ['x'], newIntermediates: ['y'], domainShift: false },
      { endpoints: ['c', 'd'], fromRun: 1, toRun: 2, oldIntermediates: ['m'], newIntermediates: ['n'], domainShift: false },
    ];
    const signal = emitSignal(state, null, [], [], emptyPrunerResult, rearrangements, [], 5);
    expect(signal.delta.rearrangementsThisRun).toBe(1);
  });
});
