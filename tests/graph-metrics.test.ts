import { describe, it, expect } from 'vitest';
import {
  computeBetweennessCentrality,
  findArticulationPoints,
  giniCoefficient,
  computeClusteringCoefficient,
  computeDiameter,
  computeNetworkMetrics,
} from '../src/graph-metrics.js';
import type { TopologyState, Concept, Chain } from '../src/types.js';

function makeConcept(name: string, sourceInput = 1): Concept {
  return { id: `c-${name}`, name, facets: [], sourceInput };
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

function makeTopology(concepts: Concept[], chains: Chain[]): TopologyState {
  return { concepts, chains, latentConnections: [], runCount: 1 };
}

describe('computeBetweennessCentrality', () => {
  it('peaks at middle of linear chain', () => {
    // A - B - C
    const topo = makeTopology(
      [makeConcept('a'), makeConcept('b'), makeConcept('c')],
      [makeChain('a', 'b'), makeChain('b', 'c')],
    );
    const bc = computeBetweennessCentrality(topo);
    expect(bc['b']).toBeGreaterThan(bc['a']);
    expect(bc['b']).toBeGreaterThan(bc['c']);
  });

  it('star graph: center has max centrality', () => {
    // center connected to a, b, c, d
    const topo = makeTopology(
      [makeConcept('center'), makeConcept('a'), makeConcept('b'), makeConcept('c'), makeConcept('d')],
      [makeChain('center', 'a'), makeChain('center', 'b'), makeChain('center', 'c'), makeChain('center', 'd')],
    );
    const bc = computeBetweennessCentrality(topo);
    expect(bc['center']).toBeGreaterThan(bc['a']);
    expect(bc['center']).toBeGreaterThan(bc['b']);
    expect(bc['center']).toBeGreaterThan(bc['c']);
    expect(bc['center']).toBeGreaterThan(bc['d']);
  });

  it('returns zero for all nodes in a triangle', () => {
    // A - B - C - A: no node is "between" others
    const topo = makeTopology(
      [makeConcept('a'), makeConcept('b'), makeConcept('c')],
      [makeChain('a', 'b'), makeChain('b', 'c'), makeChain('c', 'a')],
    );
    const bc = computeBetweennessCentrality(topo);
    expect(bc['a']).toBe(0);
    expect(bc['b']).toBe(0);
    expect(bc['c']).toBe(0);
  });

  it('returns empty for empty topology', () => {
    const topo = makeTopology([], []);
    const bc = computeBetweennessCentrality(topo);
    expect(Object.keys(bc)).toHaveLength(0);
  });
});

describe('findArticulationPoints', () => {
  it('finds articulation point in linear chain', () => {
    // A - B - C: B is articulation point
    const topo = makeTopology(
      [makeConcept('a'), makeConcept('b'), makeConcept('c')],
      [makeChain('a', 'b'), makeChain('b', 'c')],
    );
    const aps = findArticulationPoints(topo);
    expect(aps).toContain('b');
    expect(aps).not.toContain('a');
    expect(aps).not.toContain('c');
  });

  it('returns empty for a triangle (no articulation points)', () => {
    const topo = makeTopology(
      [makeConcept('a'), makeConcept('b'), makeConcept('c')],
      [makeChain('a', 'b'), makeChain('b', 'c'), makeChain('c', 'a')],
    );
    const aps = findArticulationPoints(topo);
    expect(aps).toHaveLength(0);
  });

  it('returns empty for empty topology', () => {
    const topo = makeTopology([], []);
    expect(findArticulationPoints(topo)).toHaveLength(0);
  });
});

describe('giniCoefficient', () => {
  it('returns 0 for equal values', () => {
    expect(giniCoefficient([1, 1, 1, 1])).toBeCloseTo(0, 2);
  });

  it('returns high value for unequal distribution', () => {
    const g = giniCoefficient([0, 0, 0, 100]);
    expect(g).toBeGreaterThan(0.7);
  });

  it('returns 0 for empty array', () => {
    expect(giniCoefficient([])).toBe(0);
  });

  it('returns 0 for all zeros', () => {
    expect(giniCoefficient([0, 0, 0])).toBe(0);
  });
});

describe('computeClusteringCoefficient', () => {
  it('returns 1.0 for a complete triangle', () => {
    const topo = makeTopology(
      [makeConcept('a'), makeConcept('b'), makeConcept('c')],
      [makeChain('a', 'b'), makeChain('b', 'c'), makeChain('c', 'a')],
    );
    expect(computeClusteringCoefficient(topo)).toBeCloseTo(1.0, 2);
  });

  it('returns 0 for a star graph (no triangles)', () => {
    const topo = makeTopology(
      [makeConcept('center'), makeConcept('a'), makeConcept('b'), makeConcept('c')],
      [makeChain('center', 'a'), makeChain('center', 'b'), makeChain('center', 'c')],
    );
    expect(computeClusteringCoefficient(topo)).toBeCloseTo(0, 2);
  });

  it('returns 0 for empty topology', () => {
    expect(computeClusteringCoefficient(makeTopology([], []))).toBe(0);
  });
});

describe('computeDiameter', () => {
  it('returns 2 for A-B-C chain', () => {
    const topo = makeTopology(
      [makeConcept('a'), makeConcept('b'), makeConcept('c')],
      [makeChain('a', 'b'), makeChain('b', 'c')],
    );
    expect(computeDiameter(topo)).toBe(2);
  });

  it('returns 0 for single node', () => {
    const topo = makeTopology([makeConcept('a')], []);
    expect(computeDiameter(topo)).toBe(0);
  });

  it('returns Infinity for disconnected components', () => {
    const topo = makeTopology(
      [makeConcept('a'), makeConcept('b'), makeConcept('c'), makeConcept('d')],
      [makeChain('a', 'b'), makeChain('c', 'd')],
    );
    expect(computeDiameter(topo)).toBe(Infinity);
  });
});

describe('computeNetworkMetrics', () => {
  it('returns valid metrics for a simple graph', () => {
    const topo = makeTopology(
      [makeConcept('a'), makeConcept('b'), makeConcept('c')],
      [makeChain('a', 'b'), makeChain('b', 'c'), makeChain('c', 'a')],
    );
    const metrics = computeNetworkMetrics(topo);
    expect(metrics.top3PathShare).toBeDefined();
    expect(metrics.diameter).toBe(1);
    expect(metrics.clusteringCoeff).toBeCloseTo(1.0, 2);
    expect(metrics.articulationPoints).toHaveLength(0);
    expect(metrics.avgPathLength).toBeGreaterThanOrEqual(0);
  });
});
