import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TopologyStore } from '../src/topology.js';
import { rmSync, existsSync } from 'fs';
import type { Concept, Chain, LatentConnection, TopologyQuestion } from '../src/types.js';

const TEST_DIR = '/tmp/organism-test-topology';

function makeConcept(name: string, sourceInput: number, facets: Array<{ domain: string; attribute: string; salience: number }> = []): Concept {
  return { id: `c-${name}`, name, facets, sourceInput };
}

function makeChain(from: string, to: string, opts: Partial<Chain> = {}): Chain {
  return {
    id: `chain-${from}-${to}`,
    fromConcept: from,
    toConcept: to,
    steps: opts.steps ?? [],
    depth: opts.depth ?? 1,
    domainsCrossed: opts.domainsCrossed ?? [],
    confidence: opts.confidence ?? 0.8,
    weight: opts.weight ?? 1.0,
    createdAtRun: opts.createdAtRun ?? 1,
    lastTraversedRun: opts.lastTraversedRun ?? 1,
  };
}

describe('TopologyStore', () => {
  let store: TopologyStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new TopologyStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe('addConcepts', () => {
    it('adds new concepts', () => {
      const c = makeConcept('firewall', 1, [{ domain: 'structural', attribute: 'barrier', salience: 0.9 }]);
      store.addConcepts([c]);
      expect(store.concepts).toHaveLength(1);
      expect(store.concepts[0].name).toBe('firewall');
    });

    it('deduplicates by name (case-insensitive)', () => {
      store.addConcepts([
        makeConcept('Firewall', 1, [{ domain: 'structural', attribute: 'barrier', salience: 0.9 }]),
      ]);
      store.addConcepts([
        makeConcept('firewall', 2, [{ domain: 'process', attribute: 'filtering', salience: 0.7 }]),
      ]);
      expect(store.concepts).toHaveLength(1);
      expect(store.concepts[0].facets).toHaveLength(2);
    });

    it('does not add duplicate facets', () => {
      const facet = { domain: 'structural', attribute: 'barrier', salience: 0.9 };
      store.addConcepts([makeConcept('firewall', 1, [facet])]);
      store.addConcepts([makeConcept('firewall', 2, [facet])]);
      expect(store.concepts[0].facets).toHaveLength(1);
    });
  });

  describe('addChain', () => {
    it('adds a new chain', () => {
      store.addChain(makeChain('firewall', 'onion', { confidence: 0.7 }));
      expect(store.chains).toHaveLength(1);
    });

    it('deduplicates by endpoints — keeps higher confidence', () => {
      store.addChain(makeChain('a', 'b', { confidence: 0.6 }));
      store.addChain(makeChain('a', 'b', { confidence: 0.9 }));
      expect(store.chains).toHaveLength(1);
      expect(store.chains[0].confidence).toBe(0.9);
    });

    it('deduplicates bidirectionally', () => {
      store.addChain(makeChain('a', 'b', { confidence: 0.7 }));
      store.addChain(makeChain('b', 'a', { confidence: 0.6 }));
      expect(store.chains).toHaveLength(1);
    });

    it('strengthens weight on re-traversal with age-aware resilience bonus', () => {
      store.addChain(makeChain('a', 'b', { weight: 0.5, createdAtRun: 1, lastTraversedRun: 1 }));
      store.addChain(makeChain('a', 'b', { weight: 0.3, createdAtRun: 1, lastTraversedRun: 5 }));
      // runSpan = max(0, 5 - 1) = 4, bonus = min(0.1, 0.05 + 4*0.001) = 0.054
      expect(store.chains[0].weight).toBeCloseTo(0.554, 3);
      expect(store.chains[0].lastTraversedRun).toBe(5);
    });

    it('gives larger resilience bonus to long-lived chains', () => {
      store.addChain(makeChain('a', 'b', { weight: 0.5, createdAtRun: 1, lastTraversedRun: 1 }));
      store.addChain(makeChain('a', 'b', { weight: 0.3, createdAtRun: 1, lastTraversedRun: 50 }));
      // runSpan = 49, bonus = min(0.1, 0.05 + 49*0.001) = min(0.1, 0.099) = 0.099
      expect(store.chains[0].weight).toBeCloseTo(0.599, 3);
    });

    it('caps resilience bonus at 0.1', () => {
      store.addChain(makeChain('a', 'b', { weight: 0.5, createdAtRun: 1, lastTraversedRun: 1 }));
      store.addChain(makeChain('a', 'b', { weight: 0.3, createdAtRun: 1, lastTraversedRun: 200 }));
      // runSpan = 199, bonus = min(0.1, 0.05 + 199*0.001) = min(0.1, 0.249) = 0.1
      expect(store.chains[0].weight).toBeCloseTo(0.6, 3);
    });

    it('gives minimum resilience bonus to fresh chains', () => {
      store.addChain(makeChain('a', 'b', { weight: 0.5, createdAtRun: 50, lastTraversedRun: 50 }));
      store.addChain(makeChain('a', 'b', { weight: 0.3, createdAtRun: 50, lastTraversedRun: 50 }));
      // runSpan = 0, bonus = min(0.1, 0.05 + 0) = 0.05
      expect(store.chains[0].weight).toBeCloseTo(0.55, 3);
    });
  });

  describe('latent connections', () => {
    it('adds a new latent connection', () => {
      const lc: LatentConnection = {
        fromConcept: 'a', toConcept: 'b',
        resonanceScore: 0.7, facetPairs: [], weight: 1.0,
        createdAtRun: 1, validated: false,
      };
      store.addLatentConnection(lc);
      expect(store.latentConnections).toHaveLength(1);
    });

    it('deduplicates by concept pair and merges facet pairs', () => {
      const fp1 = { facetA: { concept: 'a', facet: { domain: 'x', attribute: 'y', salience: 0.5 } }, facetB: { concept: 'b', facet: { domain: 'x', attribute: 'z', salience: 0.5 } } };
      const fp2 = { facetA: { concept: 'a', facet: { domain: 'p', attribute: 'q', salience: 0.5 } }, facetB: { concept: 'b', facet: { domain: 'p', attribute: 'r', salience: 0.5 } } };

      store.addLatentConnection({
        fromConcept: 'a', toConcept: 'b', resonanceScore: 0.5,
        facetPairs: [fp1], weight: 1.0, createdAtRun: 1, validated: false,
      });
      store.addLatentConnection({
        fromConcept: 'b', toConcept: 'a', resonanceScore: 0.8,
        facetPairs: [fp2], weight: 1.0, createdAtRun: 2, validated: false,
      });

      expect(store.latentConnections).toHaveLength(1);
      expect(store.latentConnections[0].facetPairs).toHaveLength(2);
      expect(store.latentConnections[0].resonanceScore).toBe(0.8);
    });
  });

  describe('markTraversed', () => {
    it('resets chain weight to 1.0 and updates lastTraversedRun', () => {
      store.addChain(makeChain('a', 'b', { weight: 0.5, lastTraversedRun: 1 }));
      const chainId = store.chains[0].id;
      store.markTraversed(chainId, 10);
      expect(store.chains[0].weight).toBe(1.0);
      expect(store.chains[0].lastTraversedRun).toBe(10);
    });

    it('does nothing for unknown chain id', () => {
      store.addChain(makeChain('a', 'b', { weight: 0.5 }));
      store.markTraversed('nonexistent', 10);
      expect(store.chains[0].weight).toBe(0.5);
    });
  });

  describe('findChainsThrough', () => {
    it('finds chains where concept is an endpoint', () => {
      store.addChain(makeChain('a', 'b'));
      store.addChain(makeChain('b', 'c'));
      store.addChain(makeChain('d', 'e'));

      const chains = store.findChainsThrough('b');
      expect(chains).toHaveLength(2);
    });

    it('finds chains where concept is an intermediate step', () => {
      store.addChain(makeChain('a', 'c', {
        steps: [
          { fromConcept: 'a', fromFacet: 'x', toConcept: 'b', toFacet: 'y' },
          { fromConcept: 'b', fromFacet: 'y', toConcept: 'c', toFacet: 'z' },
        ],
      }));

      const chains = store.findChainsThrough('b');
      expect(chains).toHaveLength(1);
    });

    it('is case-insensitive', () => {
      store.addChain(makeChain('Alpha', 'Beta'));
      const chains = store.findChainsThrough('alpha');
      expect(chains).toHaveLength(1);
    });
  });

  describe('findOverlaps', () => {
    it('finds facets with matching domain', () => {
      store.addConcepts([
        makeConcept('firewall', 1, [{ domain: 'structural', attribute: 'barrier', salience: 0.9 }]),
        makeConcept('onion', 2, [{ domain: 'structural', attribute: 'layers', salience: 0.8 }]),
        makeConcept('patience', 3, [{ domain: 'temporal', attribute: 'waiting', salience: 0.7 }]),
      ]);

      const results = store.findOverlaps({ domain: 'structural', attribute: 'wall', salience: 0.5 });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].concept.name).toBe('firewall');
    });

    it('excludes specified concept', () => {
      store.addConcepts([
        makeConcept('firewall', 1, [{ domain: 'structural', attribute: 'barrier', salience: 0.9 }]),
        makeConcept('onion', 2, [{ domain: 'structural', attribute: 'layers', salience: 0.8 }]),
      ]);

      const results = store.findOverlaps(
        { domain: 'structural', attribute: 'barrier', salience: 0.5 },
        'firewall'
      );
      expect(results.every((r) => r.concept.name !== 'firewall')).toBe(true);
    });

    it('scores attribute matches higher', () => {
      store.addConcepts([
        makeConcept('a', 1, [{ domain: 'structural', attribute: 'layers', salience: 0.9 }]),
        makeConcept('b', 2, [{ domain: 'structural', attribute: 'barrier', salience: 0.8 }]),
      ]);

      const results = store.findOverlaps({ domain: 'structural', attribute: 'layers', salience: 0.5 });
      expect(results[0].concept.name).toBe('a');
      expect(results[0].score).toBe(2.0);
      expect(results[1].score).toBe(1.0);
    });
  });

  describe('persistence', () => {
    it('saves and loads state including latent connections', () => {
      store.addConcepts([makeConcept('test', 1, [{ domain: 'abstract', attribute: 'persistence', salience: 0.9 }])]);
      store.addChain(makeChain('test', 'other'));
      store.addLatentConnection({
        fromConcept: 'x', toConcept: 'y', resonanceScore: 0.6,
        facetPairs: [], weight: 0.8, createdAtRun: 1, validated: false,
      });
      store.runCount = 5;
      store.save();

      const loaded = new TopologyStore(TEST_DIR);
      expect(loaded.concepts).toHaveLength(1);
      expect(loaded.chains).toHaveLength(1);
      expect(loaded.latentConnections).toHaveLength(1);
      expect(loaded.latentConnections[0].resonanceScore).toBe(0.6);
      expect(loaded.runCount).toBe(5);
    });

    it('backward-compatible: loads old state without latentConnections', () => {
      // simulate old state.json without latentConnections field
      const { writeFileSync, mkdirSync } = require('fs');
      const { join } = require('path');
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(
        join(TEST_DIR, 'state.json'),
        JSON.stringify({ concepts: [], chains: [], runCount: 3 })
      );

      const loaded = new TopologyStore(TEST_DIR);
      expect(loaded.latentConnections).toEqual([]);
      expect(loaded.runCount).toBe(3);
    });
  });

  describe('getMetrics', () => {
    it('returns correct metrics including latent count', () => {
      store.addConcepts([
        makeConcept('a', 1, [{ domain: 'structural', attribute: 'x', salience: 0.9 }]),
        makeConcept('b', 2, [{ domain: 'abstract', attribute: 'y', salience: 0.8 }]),
        makeConcept('c', 1, [{ domain: 'process', attribute: 'z', salience: 0.7 }]),
      ]);
      store.addChain(makeChain('a', 'b', { depth: 2 }));
      store.addChain(makeChain('a', 'c', { depth: 4 }));
      store.addLatentConnection({
        fromConcept: 'a', toConcept: 'c', resonanceScore: 0.5,
        facetPairs: [], weight: 0.7, createdAtRun: 1, validated: false,
      });

      const m = store.getMetrics();
      expect(m.conceptCount).toBe(3);
      expect(m.chainCount).toBe(2);
      expect(m.avgDepth).toBe(3);
      expect(m.crossInputChainCount).toBe(1);
      expect(m.latentConnectionCount).toBe(1);
    });
  });

  describe('snapshot', () => {
    it('returns deep copy', () => {
      store.addConcepts([makeConcept('test', 1)]);
      const snap = store.snapshot();
      snap.concepts.push(makeConcept('injected', 2));
      expect(store.concepts).toHaveLength(1);
    });
  });

  describe('questions', () => {
    it('adds and retrieves questions', () => {
      const q: TopologyQuestion = {
        id: 'q1', text: 'How do layers relate to security?',
        sourceInput: 1, relatedConcepts: ['firewall'], status: 'open',
      };
      store.addQuestion(q);
      expect(store.getQuestions()).toHaveLength(1);
      expect(store.getQuestions('open')).toHaveLength(1);
      expect(store.getQuestions('addressed')).toHaveLength(0);
    });

    it('marks question as addressed', () => {
      store.addQuestion({
        id: 'q1', text: 'Test?', sourceInput: 1,
        relatedConcepts: [], status: 'open',
      });
      store.markQuestionAddressed('q1', 5);
      const q = store.getQuestions('addressed');
      expect(q).toHaveLength(1);
      expect(q[0].addressedByInput).toBe(5);
    });

    it('dissolves question by rearrangement', () => {
      store.addQuestion({
        id: 'q1', text: 'Test?', sourceInput: 1,
        relatedConcepts: [], status: 'open',
      });
      store.dissolveQuestion('q1', 'rearrangement-42');
      const q = store.getQuestions('dissolved');
      expect(q).toHaveLength(1);
      expect(q[0].dissolvedByRearrangement).toBe('rearrangement-42');
    });

    it('persists questions across save/load', () => {
      store.addQuestion({
        id: 'q1', text: 'Persisted?', sourceInput: 1,
        relatedConcepts: ['a'], status: 'open',
      });
      store.save();
      const loaded = new TopologyStore(TEST_DIR);
      expect(loaded.getQuestions()).toHaveLength(1);
      expect(loaded.getQuestions()[0].text).toBe('Persisted?');
    });
  });

  describe('reset', () => {
    it('clears all state including latent connections', () => {
      store.addConcepts([makeConcept('test', 1)]);
      store.addChain(makeChain('a', 'b'));
      store.addLatentConnection({
        fromConcept: 'x', toConcept: 'y', resonanceScore: 0.5,
        facetPairs: [], weight: 1.0, createdAtRun: 1, validated: false,
      });
      store.runCount = 10;
      store.reset();
      expect(store.concepts).toHaveLength(0);
      expect(store.chains).toHaveLength(0);
      expect(store.latentConnections).toHaveLength(0);
      expect(store.runCount).toBe(0);
    });
  });
});
