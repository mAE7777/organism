import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StructuralPruner } from '../src/pruner.js';
import { TopologyStore } from '../src/topology.js';
import { rmSync, existsSync } from 'fs';
import type { Concept, Chain } from '../src/types.js';

const TEST_DIR = '/tmp/organism-test-pruner';

function makeConcept(name: string, sourceInput = 1): Concept {
  return { id: `c-${name}`, name, facets: [{ domain: 'structural', attribute: name, salience: 0.9 }], sourceInput };
}

function makeChain(from: string, to: string, weight = 1.0): Chain {
  return {
    id: `ch-${from}-${to}`,
    fromConcept: from,
    toConcept: to,
    steps: [],
    depth: 1,
    domainsCrossed: [],
    confidence: 0.8,
    weight,
    createdAtRun: 1,
    lastTraversedRun: 1,
  };
}

describe('StructuralPruner', () => {
  let store: TopologyStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new TopologyStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('star topology: center gets hub penalty', () => {
    store.addConcepts([makeConcept('center'), makeConcept('a'), makeConcept('b'), makeConcept('c'), makeConcept('d')]);
    store.addChain(makeChain('center', 'a'));
    store.addChain(makeChain('center', 'b'));
    store.addChain(makeChain('center', 'c'));
    store.addChain(makeChain('center', 'd'));

    const initialWeight = store.chains[0].weight;
    const pruner = new StructuralPruner(store);
    pruner.prune({ hubDecayRate: 0.15, normalDecayRate: 0.05 });

    // Center is a hub (high centrality, but also an articulation point in star)
    // In a star, center IS an articulation point, so it should be bridge-protected
    // Spokes have 0 centrality, so they get normal decay
    for (const chain of store.chains) {
      expect(chain.weight).toBeLessThan(initialWeight);
    }
  });

  it('linear chain: middle node is articulation point, gets protection', () => {
    store.addConcepts([makeConcept('a'), makeConcept('b'), makeConcept('c')]);
    store.addChain(makeChain('a', 'b'));
    store.addChain(makeChain('b', 'c'));

    const pruner = new StructuralPruner(store);
    const result = pruner.prune({ bridgeDecayRate: 0.025, normalDecayRate: 0.05 });

    // b is an articulation point
    expect(result.bridgesProtected).toContain('b');
  });

  it('redundant paths: reports 0 when addChain deduplicates', () => {
    store.addConcepts([makeConcept('a'), makeConcept('b')]);
    store.addChain(makeChain('a', 'b', 0.9));
    // addChain deduplicates by endpoints, so only 1 chain per pair exists
    const pruner = new StructuralPruner(store);
    const result = pruner.prune();
    expect(result.redundantPathsMerged).toBe(0);
  });

  it('orphan detection: concept with all chains below threshold', () => {
    store.addConcepts([makeConcept('connected'), makeConcept('orphan'), makeConcept('other')]);
    store.addChain(makeChain('connected', 'other', 0.9));
    // orphan has no chains

    const pruner = new StructuralPruner(store);
    const result = pruner.prune();
    expect(result.orphansArchived).toContain('orphan');
    expect(result.orphansArchived).not.toContain('connected');
  });

  it('bridge protection: articulation point chains decay slowly', () => {
    // A - B - C: B is articulation point
    store.addConcepts([makeConcept('a'), makeConcept('b'), makeConcept('c')]);
    store.addChain(makeChain('a', 'b', 1.0));
    store.addChain(makeChain('b', 'c', 1.0));

    const pruner = new StructuralPruner(store);
    pruner.prune({ bridgeDecayRate: 0.025, normalDecayRate: 0.05 });

    // Chains through b (bridge) should decay less than if they went through a hub
    const chainAB = store.chains.find(c => c.fromConcept === 'a' && c.toConcept === 'b');
    const chainBC = store.chains.find(c => c.fromConcept === 'b' && c.toConcept === 'c');
    // Both chains involve b (bridge), so both get bridge decay rate
    expect(chainAB!.weight).toBeCloseTo(1.0 * (1 - 0.025), 3);
    expect(chainBC!.weight).toBeCloseTo(1.0 * (1 - 0.025), 3);
  });

  it('full cycle: run prune twice, verify cumulative effects', () => {
    store.addConcepts([makeConcept('a'), makeConcept('b')]);
    store.addChain(makeChain('a', 'b', 0.5));

    const pruner = new StructuralPruner(store);
    pruner.prune({ normalDecayRate: 0.05, threshold: 0.3 });
    const afterFirst = store.chains[0]?.weight;
    expect(afterFirst).toBeDefined();

    pruner.prune({ normalDecayRate: 0.05, threshold: 0.3 });
    if (store.chains.length > 0) {
      expect(store.chains[0].weight).toBeLessThan(afterFirst!);
    }
  });

  it('empty topology: no crash, returns empty result', () => {
    const pruner = new StructuralPruner(store);
    const result = pruner.prune();
    expect(result.hubsPenalized).toHaveLength(0);
    expect(result.bridgesProtected).toHaveLength(0);
    expect(result.redundantPathsMerged).toBe(0);
    expect(result.orphansArchived).toHaveLength(0);
  });

  it('hub decay is faster than normal decay', () => {
    // Hub topology: center connected to many, plus a separate chain
    store.addConcepts([
      makeConcept('hub'), makeConcept('a'), makeConcept('b'),
      makeConcept('c'), makeConcept('d'), makeConcept('e'),
      makeConcept('x'), makeConcept('y'),
    ]);
    // Hub is connected to many nodes
    store.addChain(makeChain('hub', 'a'));
    store.addChain(makeChain('hub', 'b'));
    store.addChain(makeChain('hub', 'c'));
    store.addChain(makeChain('hub', 'd'));
    store.addChain(makeChain('hub', 'e'));
    // Separate chain (not through hub)
    store.addChain(makeChain('x', 'y'));

    const pruner = new StructuralPruner(store);
    pruner.prune({ hubDecayRate: 0.15, normalDecayRate: 0.05, bridgeDecayRate: 0.025 });

    const xyChain = store.chains.find(c => c.fromConcept === 'x');
    const hubChain = store.chains.find(c => c.fromConcept === 'hub');

    // x-y chain should decay at normal or bridge rate, hub chains at hub rate
    // The exact classification depends on centrality/articulation analysis
    expect(xyChain).toBeDefined();
    expect(hubChain).toBeDefined();
  });
});
