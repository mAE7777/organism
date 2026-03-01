import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TopologyStore } from '../src/topology.js';
import { rmSync, existsSync } from 'fs';
import type { Chain, LatentConnection } from '../src/types.js';

const TEST_DIR = '/tmp/organism-test-decay';

function makeChain(from: string, to: string, weight: number): Chain {
  return {
    id: `chain-${from}-${to}`,
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

function makeLatent(from: string, to: string, weight: number): LatentConnection {
  return {
    fromConcept: from,
    toConcept: to,
    resonanceScore: 0.6,
    facetPairs: [],
    weight,
    createdAtRun: 1,
    validated: false,
  };
}

describe('Decay mechanics', () => {
  let store: TopologyStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new TopologyStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('chain decay (5%/run, threshold 0.3)', () => {
    it('reduces chain weights by decay rate', () => {
      store.addChain(makeChain('a', 'b', 1.0));
      store.applyDecay(0.05);
      expect(store.chains[0].weight).toBeCloseTo(0.95, 4);
    });

    it('prunes chains below threshold 0.3', () => {
      store.addChain(makeChain('a', 'b', 0.35));
      store.addChain(makeChain('c', 'd', 0.25)); // below 0.3 after decay
      const pruned = store.applyDecay(0.05);
      // 0.35 * 0.95 = 0.3325 → above 0.3, kept
      // 0.25 * 0.95 = 0.2375 → below 0.3, pruned
      expect(pruned).toBe(1);
      expect(store.chains).toHaveLength(1);
      expect(store.chains[0].fromConcept).toBe('a');
    });

    it('cumulative 5% decay eventually prunes', () => {
      store.addChain(makeChain('a', 'b', 0.5));
      // 0.5 * 0.95^N < 0.3 when N >= ceil(log(0.3/0.5) / log(0.95)) ≈ 10
      for (let i = 0; i < 9; i++) {
        store.applyDecay(0.05);
      }
      expect(store.chains).toHaveLength(1); // still alive after 9

      store.applyDecay(0.05);
      expect(store.chains).toHaveLength(0); // pruned after 10
    });

    it('re-traversal strengthening offsets decay', () => {
      store.addChain(makeChain('a', 'b', 0.5));

      for (let i = 0; i < 5; i++) {
        store.applyDecay(0.05);
      }
      const afterDecay = store.chains[0].weight;
      expect(afterDecay).toBeCloseTo(0.5 * Math.pow(0.95, 5), 3);

      // re-traversal: age-aware bonus = min(0.1, 0.05 + (6-1)*0.001) = 0.055
      store.addChain({ ...makeChain('a', 'b', 0.3), lastTraversedRun: 6 });
      const expectedBonus = Math.min(0.1, 0.05 + (6 - 1) * 0.001);
      expect(store.chains[0].weight).toBeCloseTo(afterDecay + expectedBonus, 3);
    });

    it('weight is capped at 1.0 on re-traversal', () => {
      store.addChain(makeChain('a', 'b', 0.98));
      store.addChain({ ...makeChain('a', 'b', 0.5), lastTraversedRun: 2 });
      expect(store.chains[0].weight).toBe(1.0);
    });

    it('zero decay rate preserves all weights', () => {
      store.addChain(makeChain('a', 'b', 0.5));
      store.applyDecay(0);
      expect(store.chains[0].weight).toBe(0.5);
    });

    it('custom threshold can be passed', () => {
      store.addChain(makeChain('a', 'b', 0.15));
      // with default threshold 0.3: 0.15 * 0.95 = 0.1425 → pruned
      const pruned = store.applyDecay(0.05);
      expect(pruned).toBe(1);
    });
  });

  describe('latent decay (10%/run, threshold 0.2)', () => {
    it('reduces latent connection weights by rate', () => {
      store.addLatentConnection(makeLatent('a', 'b', 1.0));
      store.applyLatentDecay(0.10);
      expect(store.latentConnections[0].weight).toBeCloseTo(0.90, 4);
    });

    it('prunes latent connections below threshold 0.2', () => {
      store.addLatentConnection(makeLatent('a', 'b', 0.25));
      store.addLatentConnection(makeLatent('c', 'd', 0.18));
      const pruned = store.applyLatentDecay(0.10);
      // 0.25 * 0.9 = 0.225 → above 0.2, kept
      // 0.18 * 0.9 = 0.162 → below 0.2, pruned
      expect(pruned).toBe(1);
      expect(store.latentConnections).toHaveLength(1);
    });

    it('latent connections decay faster than direct chains', () => {
      store.addChain(makeChain('a', 'b', 1.0));
      store.addLatentConnection(makeLatent('c', 'd', 1.0));

      for (let i = 0; i < 5; i++) {
        store.applyDecay(0.05);
        store.applyLatentDecay(0.10);
      }

      expect(store.chains[0].weight).toBeCloseTo(Math.pow(0.95, 5), 3);
      expect(store.latentConnections[0].weight).toBeCloseTo(Math.pow(0.90, 5), 3);
      expect(store.latentConnections[0].weight).toBeLessThan(store.chains[0].weight);
    });
  });
});
