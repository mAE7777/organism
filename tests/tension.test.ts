import { describe, it, expect } from 'vitest';
import { formanRicci, earlyWarning, kendallTauTrend } from '../src/tension.js';
import type { Concept, Chain } from '../src/types.js';

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

// Deterministic PRNG (mulberry32) so the synthetic series are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const unit = (r: () => number) => 2 * r() - 1; // noise in [-1, 1)

describe('formanRicci', () => {
  // Two triangles {a,b,c} and {d,e,f} joined by a single bridge edge c-d.
  // Unit-weight Forman reduces to F(e) = 4 - deg(u) - deg(v):
  //   bridge c-d: deg 3,3 -> -2 (most negative)
  //   triangle edge with a hub end (e.g. b-c): deg 2,3 -> -1
  //   pure triangle edge a-b: deg 2,2 -> 0
  const concepts = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => makeConcept(n));
  const chains = [
    makeChain('a', 'b'),
    makeChain('b', 'c'),
    makeChain('c', 'a'),
    makeChain('d', 'e'),
    makeChain('e', 'f'),
    makeChain('f', 'd'),
    makeChain('c', 'd'), // the bridge
  ];

  it('gives the bridge edge the most negative curvature', () => {
    const { edges } = formanRicci(concepts, chains);
    const mostNegative = edges[0];
    const pair = [mostNegative.from, mostNegative.to].sort();
    expect(pair).toEqual(['c', 'd']);
    expect(mostNegative.curvature).toBeCloseTo(-2, 6);
  });

  it('makes the bridge more negative than a pure-triangle edge', () => {
    const { edges } = formanRicci(concepts, chains);
    const byKey = (u: string, v: string) =>
      edges.find((e) => [e.from, e.to].sort().join() === [u, v].sort().join())!;
    const bridge = byKey('c', 'd');
    const triangleEdge = byKey('a', 'b'); // both endpoints degree 2
    expect(triangleEdge.curvature).toBeCloseTo(0, 6);
    expect(bridge.curvature).toBeLessThan(triangleEdge.curvature);
  });

  it('flags the two bridge endpoints as the highest-tension concepts', () => {
    const { conceptTension } = formanRicci(concepts, chains);
    const topTwo = conceptTension.slice(0, 2).map((c) => c.concept).sort();
    expect(topTwo).toEqual(['c', 'd']);
  });

  it('summarizes the curvature distribution correctly', () => {
    const { distribution } = formanRicci(concepts, chains);
    expect(distribution.count).toBe(7);
    expect(distribution.min).toBeCloseTo(-2, 6);
    expect(distribution.max).toBeCloseTo(0, 6);
    // negatives: c-d, b-c, c-a, d-e, f-d = 5 of 7
    expect(distribution.fracNegative).toBeCloseTo(5 / 7, 6);
  });

  it('a hub star gives strongly negative spokes and a central concept under tension', () => {
    const star = ['hub', 's1', 's2', 's3', 's4', 's5'].map((n) => makeConcept(n));
    const spokes = ['s1', 's2', 's3', 's4', 's5'].map((s) => makeChain('hub', s));
    const { edges, conceptTension } = formanRicci(star, spokes);
    // every spoke: deg(hub)=5, deg(leaf)=1 -> F = 4 - 5 - 1 = -2
    for (const e of edges) expect(e.curvature).toBeCloseTo(-2, 6);
    expect(conceptTension[0].concept).toBe('hub');
  });
});

describe('kendallTauTrend', () => {
  it('is +1 for a strictly increasing series and highly significant', () => {
    const { tau, z } = kendallTauTrend([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(tau).toBeCloseTo(1, 6);
    expect(z).toBeGreaterThan(2.5);
  });

  it('is -1 for a strictly decreasing series', () => {
    const { tau } = kendallTauTrend([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(tau).toBeCloseTo(-1, 6);
  });
});

describe('earlyWarning', () => {
  const n = 150;
  const window = 40;

  // Approaching-transition series: an Ornstein-Uhlenbeck process whose linear
  // restoring rate lambda decays toward 0 as it approaches a fold bifurcation.
  // This is the canonical critical-slowing-down test system: as lambda -> 0 the
  // process recovers ever more slowly from perturbations, so BOTH the variance
  // and the lag-1 autocorrelation of the residuals rise (Scheffer 2009; Dakos 2012).
  function approachSeries(seed: number): number[] {
    const r = rng(seed);
    const out: number[] = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const lambda = 0.6 * (1 - 0.98 * f); // restoring rate decays 0.6 -> ~0.012
      x = x - lambda * x + 0.25 * unit(r);
      out.push(x);
    }
    return out;
  }

  // Stationary control: the same process with a FIXED restoring rate. No CSD.
  function stationarySeries(seed: number): number[] {
    const r = rng(seed);
    const out: number[] = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
      x = x - 0.6 * x + 0.25 * unit(r);
      out.push(x);
    }
    return out;
  }

  it('flags high proximity on a series with rising variance + autocorrelation', () => {
    const res = earlyWarning({ signal: approachSeries(37) }, { window });
    const m = res.perMetric.find((p) => p.metric === 'signal')!;
    expect(m.available).toBe(true);
    // both CSD indicators trend upward (the injected signature) ...
    expect(m.tauVariance!).toBeGreaterThan(0);
    expect(m.tauAutocorr!).toBeGreaterThan(0);
    // ... and both are significant against the reshuffled-residual surrogates.
    expect(m.varianceRisingSignificant).toBe(true);
    expect(m.autocorrRisingSignificant).toBe(true);
    expect(res.compositeProximity).toBeGreaterThanOrEqual(0.5);
  });

  it('reports low proximity on a stationary series', () => {
    const res = earlyWarning({ signal: stationarySeries(6) }, { window });
    expect(res.compositeProximity).toBeLessThan(0.5);
  });

  it('separates the approaching regime from the stationary regime', () => {
    const approaching = earlyWarning({ signal: approachSeries(37) }, { window });
    const stationary = earlyWarning({ signal: stationarySeries(6) }, { window });
    expect(approaching.compositeProximity).toBeGreaterThan(stationary.compositeProximity);
  });

  it('marks a too-short series as unavailable rather than guessing', () => {
    const res = earlyWarning({ tiny: [1, 2, 3, 4] });
    const m = res.perMetric.find((p) => p.metric === 'tiny')!;
    expect(m.available).toBe(false);
    expect(res.indicatorsTotal).toBe(0);
  });
});
