import { describe, it, expect } from 'vitest';
import { findPaths, discoverEmergentPaths } from '../src/traversal.js';
import type { TopologyState, Concept, Chain } from '../src/types.js';

function makeConcept(name: string, sourceInput: number): Concept {
  return { id: `c-${name}`, name, facets: [], sourceInput };
}

function makeChain(from: string, to: string, weight = 1.0, id?: string): Chain {
  return {
    id: id ?? `chain-${from}-${to}`,
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

function makeTopology(concepts: Concept[], chains: Chain[]): TopologyState {
  return { concepts, chains, latentConnections: [], runCount: 1 };
}

describe('findPaths', () => {
  it('finds linear chain A→B→C', () => {
    const topo = makeTopology(
      [makeConcept('a', 1), makeConcept('b', 2), makeConcept('c', 3)],
      [makeChain('a', 'b'), makeChain('b', 'c')]
    );

    const paths = findPaths('a', 'c', topo);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0].hops).toEqual(['b']);
    expect(paths[0].depth).toBe(2);
  });

  it('finds diamond path A→B→D, A→C→D', () => {
    const topo = makeTopology(
      [makeConcept('a', 1), makeConcept('b', 2), makeConcept('c', 3), makeConcept('d', 4)],
      [
        makeChain('a', 'b'), makeChain('a', 'c'),
        makeChain('b', 'd'), makeChain('c', 'd'),
      ]
    );

    const paths = findPaths('a', 'd', topo);
    expect(paths.length).toBe(2);
    const hopSets = paths.map((p) => p.hops);
    expect(hopSets).toContainEqual(['b']);
    expect(hopSets).toContainEqual(['c']);
  });

  it('computes weight as product of edge weights', () => {
    const topo = makeTopology(
      [makeConcept('a', 1), makeConcept('b', 2), makeConcept('c', 3)],
      [makeChain('a', 'b', 0.8), makeChain('b', 'c', 0.5)]
    );

    const paths = findPaths('a', 'c', topo);
    expect(paths[0].weight).toBeCloseTo(0.4, 4);
  });

  it('tracks source inputs spanned across path', () => {
    const topo = makeTopology(
      [makeConcept('a', 1), makeConcept('b', 5), makeConcept('c', 10)],
      [makeChain('a', 'b'), makeChain('b', 'c')]
    );

    const paths = findPaths('a', 'c', topo);
    expect(paths[0].sourceInputsSpanned).toEqual([1, 5, 10]);
  });

  it('respects depth cutoff', () => {
    // chain: a→b→c→d→e→f (5 hops)
    const topo = makeTopology(
      'abcdef'.split('').map((n, i) => makeConcept(n, i + 1)),
      [
        makeChain('a', 'b'), makeChain('b', 'c'),
        makeChain('c', 'd'), makeChain('d', 'e'),
        makeChain('e', 'f'),
      ]
    );

    const pathsShort = findPaths('a', 'f', topo, 3);
    expect(pathsShort).toHaveLength(0); // needs 5 hops, max 3

    const pathsLong = findPaths('a', 'f', topo, 5);
    expect(pathsLong.length).toBeGreaterThanOrEqual(1);
  });

  it('avoids cycles', () => {
    const topo = makeTopology(
      [makeConcept('a', 1), makeConcept('b', 2), makeConcept('c', 3)],
      [makeChain('a', 'b'), makeChain('b', 'c'), makeChain('c', 'a')]
    );

    const paths = findPaths('a', 'c', topo);
    // should find a→b→c, not loop
    for (const p of paths) {
      const visited = new Set(['a', ...p.hops, 'c']);
      expect(visited.size).toBe(1 + p.hops.length + 1); // no duplicates
    }
  });

  it('returns empty for no path', () => {
    const topo = makeTopology(
      [makeConcept('a', 1), makeConcept('b', 2), makeConcept('c', 3)],
      [makeChain('a', 'b')]
    );

    const paths = findPaths('a', 'c', topo);
    expect(paths).toHaveLength(0);
  });

  it('returns empty for same from/to', () => {
    const topo = makeTopology(
      [makeConcept('a', 1)],
      [makeChain('a', 'a')]
    );

    const paths = findPaths('a', 'a', topo);
    expect(paths).toHaveLength(0);
  });
});

describe('discoverEmergentPaths', () => {
  it('finds paths spanning 3+ source inputs without direct chains', () => {
    const topo = makeTopology(
      [
        makeConcept('security', 1),
        makeConcept('layers', 2),
        makeConcept('cooking', 3),
        makeConcept('ecology', 4),
      ],
      [
        // security↔layers and layers↔cooking have direct chains
        // but security↔cooking does NOT
        makeChain('security', 'layers'),
        makeChain('layers', 'cooking'),
        makeChain('layers', 'ecology'),
      ]
    );

    const emergent = discoverEmergentPaths(topo, 0.1, 3);
    // security→layers→cooking spans inputs 1,2,3
    // security→layers→ecology spans inputs 1,2,4
    expect(emergent.length).toBeGreaterThanOrEqual(1);
    const secCook = emergent.find((p) => {
      const endpoints = [p.from, p.to].sort().join('|');
      return endpoints === 'cooking|security' || endpoints === 'security|cooking';
    });
    expect(secCook).toBeDefined();
  });

  it('excludes pairs that have direct chains', () => {
    const topo = makeTopology(
      [makeConcept('a', 1), makeConcept('b', 2), makeConcept('c', 3)],
      [
        makeChain('a', 'b'), makeChain('b', 'c'),
        makeChain('a', 'c'), // direct chain exists
      ]
    );

    const emergent = discoverEmergentPaths(topo, 0.1, 2);
    // a↔c has a direct chain, so it should be excluded
    const acPath = emergent.find((p) => {
      const eps = [p.from, p.to].sort().join('|');
      return eps === 'a|c';
    });
    expect(acPath).toBeUndefined();
  });

  it('filters by minimum weight', () => {
    const topo = makeTopology(
      [makeConcept('a', 1), makeConcept('b', 2), makeConcept('c', 3)],
      [makeChain('a', 'b', 0.2), makeChain('b', 'c', 0.2)]
    );

    // weight = 0.2 * 0.2 = 0.04
    const emergent = discoverEmergentPaths(topo, 0.5, 2);
    expect(emergent).toHaveLength(0);
  });
});
