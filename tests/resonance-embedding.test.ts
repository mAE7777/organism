import { describe, it, expect } from 'vitest';
import { EmbeddingResonance } from '../src/resonance.js';
import type { Concept, Facet } from '../src/types.js';

function makeFacet(domain: string, attribute: string, salience = 0.9): Facet {
  return { domain, attribute, salience };
}

function makeConcept(name: string, sourceInput: number, facets: Facet[]): Concept {
  return { id: `c-${name}`, name, facets, sourceInput };
}

describe('EmbeddingResonance.cosineSimilarity (static, no model)', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [0.1, 0.2, 0.3, 0.4];
    expect(EmbeddingResonance.cosineSimilarity(v, v)).toBeCloseTo(1.0, 4);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(EmbeddingResonance.cosineSimilarity(a, b)).toBeCloseTo(0, 4);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(EmbeddingResonance.cosineSimilarity(a, b)).toBeCloseTo(-1, 4);
  });

  it('returns 0 for empty vectors', () => {
    expect(EmbeddingResonance.cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(EmbeddingResonance.cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

// Full embedding tests require model download — mark as integration tests
describe.skipIf(process.env.SKIP_EMBEDDING_TESTS !== undefined)('EmbeddingResonance (with model)', () => {
  let resonance: EmbeddingResonance;

  it('semantically similar texts have high cosine', async () => {
    resonance = new EmbeddingResonance();
    await resonance.init();

    const embA = await resonance.embed('security layering defense');
    const embB = await resonance.embed('defense depth protection layers');
    const similarity = EmbeddingResonance.cosineSimilarity(embA, embB);
    expect(similarity).toBeGreaterThan(0.5);
  }, 60000);

  it('unrelated texts have low cosine', async () => {
    resonance = new EmbeddingResonance();
    await resonance.init();

    const embA = await resonance.embed('security layering defense');
    const embB = await resonance.embed('chocolate cake recipe baking');
    const similarity = EmbeddingResonance.cosineSimilarity(embA, embB);
    expect(similarity).toBeLessThan(0.3);
  }, 60000);

  it('domain penalty: same-domain pair scores lower', async () => {
    resonance = new EmbeddingResonance();
    await resonance.init();

    // Use identical text so cosine is ~1.0, then domain penalty is the only differentiator
    const sameDomainA = makeFacet('structural', 'security layering defense', 0.9);
    const sameDomainB = makeFacet('structural', 'security layering defense', 0.9);
    const crossDomainA = makeFacet('structural', 'security layering defense', 0.9);
    const crossDomainB = makeFacet('process', 'security layering defense', 0.9);

    const sameResult = await resonance.computeResonance(sameDomainA, sameDomainB);
    const crossResult = await resonance.computeResonance(crossDomainA, crossDomainB);

    // Both return {cosine, score}. Cosine should be similar, score differs by domain penalty.
    // Same domain has 0.5 penalty, cross domain has 1.0
    expect(crossResult.score).toBeGreaterThan(sameResult.score);
    // Cosine should be roughly the same since text is identical
    expect(sameResult.cosine).toBeCloseTo(crossResult.cosine, 1);
  }, 60000);

  it('findResonantPairs returns sorted by score', async () => {
    resonance = new EmbeddingResonance();
    await resonance.init();

    const newConcept = makeConcept('defense', 1, [
      makeFacet('structural', 'layered protection', 0.9),
    ]);
    const existing = [
      makeConcept('onion', 2, [makeFacet('physical', 'layered structure', 0.8)]),
      makeConcept('speed', 3, [makeFacet('temporal', 'fast racing velocity', 0.7)]),
    ];

    const pairs = await resonance.findResonantPairs(newConcept, existing, 0.01);
    // Should find onion more resonant than speed
    if (pairs.length >= 2) {
      expect(pairs[0].resonanceScore).toBeGreaterThanOrEqual(pairs[1].resonanceScore);
    }
  }, 60000);
});
