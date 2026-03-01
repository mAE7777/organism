import type { Facet, Concept, LatentConnection, FacetPair } from './types.js';

export class EmbeddingResonance {
  private pipeline: any = null;
  private cache = new Map<string, number[]>();

  async init(): Promise<void> {
    if (this.pipeline) return;
    // Dynamic import to avoid top-level loading
    const { pipeline } = await import('@xenova/transformers');
    this.pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }

  async embed(text: string): Promise<number[]> {
    if (this.cache.has(text)) return this.cache.get(text)!;
    if (!this.pipeline) await this.init();

    const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data as Float32Array);
    this.cache.set(text, embedding);
    return embedding;
  }

  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  async computeResonance(facetA: Facet, facetB: Facet): Promise<{ cosine: number; score: number }> {
    const textA = `${facetA.domain} ${facetA.attribute}`;
    const textB = `${facetB.domain} ${facetB.attribute}`;

    const [embA, embB] = await Promise.all([this.embed(textA), this.embed(textB)]);
    const cosine = EmbeddingResonance.cosineSimilarity(embA, embB);

    // Domain penalty: same domain = 0.5, different = 1.0
    const domainPenalty = facetA.domain.toLowerCase() === facetB.domain.toLowerCase() ? 0.5 : 1.0;
    const score = cosine * domainPenalty * facetA.salience * facetB.salience;

    return { cosine, score };
  }

  async findResonantPairs(
    newConcept: Concept,
    existingConcepts: Concept[],
    threshold = 0.45,
  ): Promise<LatentConnection[]> {
    const results: LatentConnection[] = [];

    for (const existing of existingConcepts) {
      if (existing.name.toLowerCase() === newConcept.name.toLowerCase()) continue;

      let bestScore = 0;
      const matchingPairs: FacetPair[] = [];

      for (const fA of newConcept.facets) {
        for (const fB of existing.facets) {
          const { cosine, score } = await this.computeResonance(fA, fB);
          // Threshold on raw cosine (reachable), rank by penalized score
          if (cosine >= threshold) {
            matchingPairs.push({
              facetA: { concept: newConcept.name, facet: fA },
              facetB: { concept: existing.name, facet: fB },
            });
            if (score > bestScore) bestScore = score;
          }
        }
      }

      if (matchingPairs.length > 0) {
        results.push({
          fromConcept: newConcept.name,
          toConcept: existing.name,
          resonanceScore: bestScore,
          facetPairs: matchingPairs,
          weight: 1.0,
          createdAtRun: newConcept.sourceInput,
          validated: false,
        });
      }
    }

    return results.sort((a, b) => b.resonanceScore - a.resonanceScore);
  }
}
