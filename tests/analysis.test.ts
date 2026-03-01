import { describe, it, expect } from 'vitest';
import { computeResonance, findResonantPairs, computeBridgeScores, detectRearrangements } from '../src/analysis.js';
import type { Concept, Facet, TopologyState, ChainHistory } from '../src/types.js';

function makeFacet(domain: string, attribute: string, salience = 0.9): Facet {
  return { domain, attribute, salience };
}

function makeConcept(name: string, sourceInput: number, facets: Facet[]): Concept {
  return { id: `c-${name}`, name, facets, sourceInput };
}

describe('computeResonance', () => {
  it('returns high score for same domain + same attribute', () => {
    const a = makeFacet('structural', 'layered', 0.9);
    const b = makeFacet('structural', 'layered', 0.8);
    const score = computeResonance(a, b);
    // 1.0 * 1.0 * 0.9 * 0.8 = 0.72
    expect(score).toBeCloseTo(0.72, 2);
  });

  it('returns moderate score for same domain + substring attribute', () => {
    const a = makeFacet('structural', 'layer', 0.9);
    const b = makeFacet('structural', 'layered', 0.8);
    const score = computeResonance(a, b);
    // 1.0 * 0.7 * 0.9 * 0.8 = 0.504
    expect(score).toBeCloseTo(0.504, 2);
  });

  it('returns zero for different domain + different attribute', () => {
    const a = makeFacet('structural', 'barrier', 0.9);
    const b = makeFacet('temporal', 'patience', 0.8);
    const score = computeResonance(a, b);
    // domainMatch = 0, so result = 0
    expect(score).toBe(0);
  });

  it('returns zero for same domain but no attribute similarity', () => {
    const a = makeFacet('structural', 'barrier', 0.9);
    const b = makeFacet('structural', 'flow', 0.8);
    const score = computeResonance(a, b);
    // domainMatch = 1.0, attributeSimilarity = 0 (no overlap)
    expect(score).toBe(0);
  });

  it('uses word-overlap Jaccard for partial matches', () => {
    const a = makeFacet('process', 'iterative learning', 1.0);
    const b = makeFacet('process', 'active learning', 1.0);
    const score = computeResonance(a, b);
    // domainMatch = 1.0
    // words: {iterative, learning} vs {active, learning} → intersection=1, union=3 → Jaccard=0.333
    // capped at 0.5, so 0.333
    // 1.0 * 0.333 * 1.0 * 1.0 = 0.333
    expect(score).toBeCloseTo(0.333, 2);
  });

  it('respects salience weights', () => {
    const a = makeFacet('structural', 'layered', 1.0);
    const b = makeFacet('structural', 'layered', 0.5);
    const score = computeResonance(a, b);
    // 1.0 * 1.0 * 1.0 * 0.5 = 0.5
    expect(score).toBeCloseTo(0.5, 2);
  });
});

describe('findResonantPairs', () => {
  it('finds resonant pairs above threshold', () => {
    const newConcept = makeConcept('defense', 1, [
      makeFacet('structural', 'layered', 0.9),
    ]);
    const existing = [
      makeConcept('onion', 2, [makeFacet('structural', 'layered', 0.8)]),
      makeConcept('patience', 3, [makeFacet('temporal', 'waiting', 0.7)]),
    ];

    const pairs = findResonantPairs(newConcept, existing, 0.5);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].toConcept).toBe('onion');
    expect(pairs[0].resonanceScore).toBeCloseTo(0.72, 2);
  });

  it('returns empty when no pairs meet threshold', () => {
    const newConcept = makeConcept('speed', 1, [
      makeFacet('temporal', 'fast', 0.5),
    ]);
    const existing = [
      makeConcept('rock', 2, [makeFacet('physical', 'hard', 0.3)]),
    ];

    const pairs = findResonantPairs(newConcept, existing, 0.5);
    expect(pairs).toHaveLength(0);
  });

  it('excludes self-matches', () => {
    const concept = makeConcept('test', 1, [makeFacet('structural', 'layered', 0.9)]);
    const pairs = findResonantPairs(concept, [concept], 0.1);
    expect(pairs).toHaveLength(0);
  });
});

describe('computeBridgeScores', () => {
  it('scores concepts that appear in many chains', () => {
    const topology: TopologyState = {
      concepts: [
        makeConcept('hub', 1, [makeFacet('structural', 'central', 0.9)]),
        makeConcept('a', 2, [makeFacet('abstract', 'x', 0.5)]),
        makeConcept('b', 3, [makeFacet('process', 'y', 0.5)]),
        makeConcept('c', 4, [makeFacet('temporal', 'z', 0.5)]),
      ],
      chains: [
        { id: 'ch1', fromConcept: 'hub', toConcept: 'a', steps: [], depth: 1, domainsCrossed: ['structural', 'abstract'], confidence: 0.8, weight: 0.9, createdAtRun: 1, lastTraversedRun: 1 },
        { id: 'ch2', fromConcept: 'hub', toConcept: 'b', steps: [], depth: 1, domainsCrossed: ['structural', 'process'], confidence: 0.8, weight: 0.8, createdAtRun: 1, lastTraversedRun: 1 },
        { id: 'ch3', fromConcept: 'hub', toConcept: 'c', steps: [], depth: 1, domainsCrossed: ['structural', 'temporal'], confidence: 0.8, weight: 0.7, createdAtRun: 1, lastTraversedRun: 1 },
      ],
      latentConnections: [],
      runCount: 5,
    };

    const bridges = computeBridgeScores(topology);
    const hubBridge = bridges.find((b) => b.conceptId === 'c-hub');
    expect(hubBridge).toBeDefined();
    expect(hubBridge!.uniqueSourceInputs).toBe(4);
    expect(hubBridge!.chainsThrough).toBe(3);
    expect(hubBridge!.bridgeScore).toBeGreaterThan(0);
  });

  it('returns empty for topology with no chains', () => {
    const topology: TopologyState = {
      concepts: [makeConcept('lonely', 1, [])],
      chains: [],
      latentConnections: [],
      runCount: 1,
    };

    const bridges = computeBridgeScores(topology);
    expect(bridges).toHaveLength(0);
  });

  it('applies maturity discount to brand-new concepts (sourceInput = runCount)', () => {
    const topology: TopologyState = {
      concepts: [
        makeConcept('new-concept', 10, [makeFacet('structural', 'central', 0.9)]),
        makeConcept('a', 1, [makeFacet('abstract', 'x', 0.5)]),
      ],
      chains: [
        { id: 'ch1', fromConcept: 'new-concept', toConcept: 'a', steps: [], depth: 1, domainsCrossed: ['structural', 'abstract'], confidence: 0.8, weight: 1.0, createdAtRun: 10, lastTraversedRun: 10 },
      ],
      latentConnections: [],
      runCount: 10,
    };

    const bridges = computeBridgeScores(topology);
    const newBridge = bridges.find(b => b.conceptId === 'c-new-concept');
    expect(newBridge).toBeDefined();
    // maturityFactor = min(1.0, 0/5) = 0, so score multiplied by 0.3
    // Without maturity: 2 * 2 * 1.0 = 4.0. With: 4.0 * 0.3 = 1.2
    expect(newBridge!.bridgeScore).toBeCloseTo(1.2, 1);
  });

  it('gives full score to mature concepts (age >= 5)', () => {
    const topology: TopologyState = {
      concepts: [
        makeConcept('old-concept', 1, [makeFacet('structural', 'central', 0.9)]),
        makeConcept('a', 2, [makeFacet('abstract', 'x', 0.5)]),
      ],
      chains: [
        { id: 'ch1', fromConcept: 'old-concept', toConcept: 'a', steps: [], depth: 1, domainsCrossed: ['structural', 'abstract'], confidence: 0.8, weight: 1.0, createdAtRun: 1, lastTraversedRun: 10 },
      ],
      latentConnections: [],
      runCount: 10,
    };

    const bridges = computeBridgeScores(topology);
    const oldBridge = bridges.find(b => b.conceptId === 'c-old-concept');
    expect(oldBridge).toBeDefined();
    // maturityFactor = min(1.0, 9/5) = 1.0, so score multiplied by 1.0
    // Raw: 2 * 2 * 1.0 = 4.0
    expect(oldBridge!.bridgeScore).toBeCloseTo(4.0, 1);
  });

  it('clamps negative age to zero (sourceInput > runCount edge case)', () => {
    const topology: TopologyState = {
      concepts: [
        makeConcept('future-concept', 15, [makeFacet('structural', 'x', 0.9)]),
        makeConcept('a', 1, [makeFacet('abstract', 'y', 0.5)]),
      ],
      chains: [
        { id: 'ch1', fromConcept: 'future-concept', toConcept: 'a', steps: [], depth: 1, domainsCrossed: ['structural', 'abstract'], confidence: 0.8, weight: 1.0, createdAtRun: 15, lastTraversedRun: 15 },
      ],
      latentConnections: [],
      runCount: 10,
    };

    const bridges = computeBridgeScores(topology);
    const futureBridge = bridges.find(b => b.conceptId === 'c-future-concept');
    expect(futureBridge).toBeDefined();
    // Math.max(0, 10-15) = 0, maturityFactor = 0, score * 0.3
    expect(futureBridge!.bridgeScore).toBeCloseTo(1.2, 1);
  });

  it('sorts by bridge score descending', () => {
    const topology: TopologyState = {
      concepts: [
        makeConcept('minor', 1, [makeFacet('x', 'a', 0.5)]),
        makeConcept('major', 2, [makeFacet('y', 'b', 0.9)]),
        makeConcept('z', 3, [makeFacet('z', 'c', 0.5)]),
      ],
      chains: [
        { id: 'ch1', fromConcept: 'minor', toConcept: 'z', steps: [], depth: 1, domainsCrossed: ['x'], confidence: 0.8, weight: 0.3, createdAtRun: 1, lastTraversedRun: 1 },
        { id: 'ch2', fromConcept: 'major', toConcept: 'z', steps: [], depth: 1, domainsCrossed: ['y', 'z'], confidence: 0.8, weight: 0.9, createdAtRun: 1, lastTraversedRun: 1 },
        { id: 'ch3', fromConcept: 'major', toConcept: 'minor', steps: [], depth: 1, domainsCrossed: ['x', 'y'], confidence: 0.8, weight: 0.8, createdAtRun: 1, lastTraversedRun: 1 },
      ],
      latentConnections: [],
      runCount: 5,
    };

    const bridges = computeBridgeScores(topology);
    expect(bridges[0].conceptId).toBe('c-major');
  });
});

describe('detectRearrangements', () => {
  it('detects when same endpoints get different intermediates', () => {
    const histories: ChainHistory[] = [
      {
        endpoints: ['a', 'b'],
        versions: [
          { run: 1, intermediates: ['x', 'y'], confidence: 0.8 },
          { run: 10, intermediates: ['z', 'w'], confidence: 0.9 },
        ],
        rearrangementCount: 1,
      },
    ];

    const events = detectRearrangements(histories);
    expect(events).toHaveLength(1);
    expect(events[0].fromRun).toBe(1);
    expect(events[0].toRun).toBe(10);
    expect(events[0].oldIntermediates).toEqual(['x', 'y']);
    expect(events[0].newIntermediates).toEqual(['z', 'w']);
  });

  it('returns empty for stable chains', () => {
    const histories: ChainHistory[] = [
      {
        endpoints: ['a', 'b'],
        versions: [
          { run: 1, intermediates: ['x'], confidence: 0.8 },
          { run: 10, intermediates: ['x'], confidence: 0.9 },
        ],
        rearrangementCount: 0,
      },
    ];

    const events = detectRearrangements(histories);
    expect(events).toHaveLength(0);
  });

  it('detects multiple rearrangements in one history', () => {
    const histories: ChainHistory[] = [
      {
        endpoints: ['a', 'b'],
        versions: [
          { run: 1, intermediates: ['x'], confidence: 0.8 },
          { run: 10, intermediates: ['y'], confidence: 0.8 },
          { run: 20, intermediates: ['z'], confidence: 0.9 },
        ],
        rearrangementCount: 2,
      },
    ];

    const events = detectRearrangements(histories);
    expect(events).toHaveLength(2);
  });

  it('sets domain shift flag when intermediates differ', () => {
    const histories: ChainHistory[] = [
      {
        endpoints: ['a', 'b'],
        versions: [
          { run: 1, intermediates: ['security-concept'], confidence: 0.8 },
          { run: 10, intermediates: ['cooking-concept'], confidence: 0.9 },
        ],
        rearrangementCount: 1,
      },
    ];

    const events = detectRearrangements(histories);
    expect(events[0].domainShift).toBe(true);
  });

  it('skips histories with only one version', () => {
    const histories: ChainHistory[] = [
      {
        endpoints: ['a', 'b'],
        versions: [{ run: 1, intermediates: ['x'], confidence: 0.8 }],
        rearrangementCount: 0,
      },
    ];

    const events = detectRearrangements(histories);
    expect(events).toHaveLength(0);
  });
});
