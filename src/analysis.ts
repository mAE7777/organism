import type { Concept, Facet, LatentConnection, BridgeConcept, FacetPair, TopologyState, ChainHistory } from './types.js';

export function computeResonance(facetA: Facet, facetB: Facet): number {
  let domainMatch = 0;
  if (facetA.domain.toLowerCase() === facetB.domain.toLowerCase()) {
    domainMatch = 1.0;
  }

  let attributeSimilarity = 0;
  const attrALower = facetA.attribute.toLowerCase();
  const attrBLower = facetB.attribute.toLowerCase();
  if (attrALower === attrBLower) {
    attributeSimilarity = 1.0;
  } else if (
    attrALower.includes(attrBLower) ||
    attrBLower.includes(attrALower)
  ) {
    attributeSimilarity = 0.7;
  } else {
    // word-overlap Jaccard
    const wordsA = new Set(facetA.attribute.toLowerCase().split(/[\s-]+/));
    const wordsB = new Set(facetB.attribute.toLowerCase().split(/[\s-]+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    if (union > 0) {
      attributeSimilarity = Math.min(0.5, intersection / union);
    }
  }

  return domainMatch * attributeSimilarity * facetA.salience * facetB.salience;
}

export function findResonantPairs(
  newConcept: Concept,
  existingConcepts: Concept[],
  threshold = 0.5,
): LatentConnection[] {
  const results: LatentConnection[] = [];

  for (const existing of existingConcepts) {
    if (existing.name.toLowerCase() === newConcept.name.toLowerCase()) continue;

    let bestScore = 0;
    const matchingPairs: FacetPair[] = [];

    for (const fA of newConcept.facets) {
      for (const fB of existing.facets) {
        const score = computeResonance(fA, fB);
        if (score >= threshold) {
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

  return results;
}

export function computeBridgeScores(topology: TopologyState): BridgeConcept[] {
  const results: BridgeConcept[] = [];

  for (const concept of topology.concepts) {
    const conceptLower = concept.name.toLowerCase();

    // find all chains through this concept (as endpoint or intermediate)
    const chainsThrough = topology.chains.filter((c) => {
      if (c.fromConcept.toLowerCase() === conceptLower) return true;
      if (c.toConcept.toLowerCase() === conceptLower) return true;
      return c.steps.some(
        (s) => s.fromConcept.toLowerCase() === conceptLower || s.toConcept.toLowerCase() === conceptLower
      );
    });

    if (chainsThrough.length === 0) continue;

    // unique source inputs connected through this concept
    const sourceInputs = new Set<number>();
    for (const chain of chainsThrough) {
      const from = topology.concepts.find(
        (c) => c.name.toLowerCase() === chain.fromConcept.toLowerCase() || c.id === chain.fromConcept
      );
      const to = topology.concepts.find(
        (c) => c.name.toLowerCase() === chain.toConcept.toLowerCase() || c.id === chain.toConcept
      );
      if (from) sourceInputs.add(from.sourceInput);
      if (to) sourceInputs.add(to.sourceInput);
    }

    // unique domains crossed
    const domains = new Set<string>();
    for (const chain of chainsThrough) {
      for (const d of chain.domainsCrossed) {
        domains.add(d);
      }
    }
    // also count concept's own domains
    for (const f of concept.facets) {
      domains.add(f.domain);
    }

    const avgWeight = chainsThrough.reduce((s, c) => s + c.weight, 0) / chainsThrough.length;

    // Age-based maturity discount: new concepts start at 30% score, reaching 100% after 5 runs
    const conceptAge = Math.max(0, topology.runCount - concept.sourceInput);
    const maturityFactor = Math.min(1.0, conceptAge / 3);
    const bridgeScore = sourceInputs.size * domains.size * avgWeight * (0.3 + 0.7 * maturityFactor);

    results.push({
      conceptId: concept.id,
      bridgeScore,
      uniqueSourceInputs: sourceInputs.size,
      uniqueDomains: domains.size,
      chainsThrough: chainsThrough.length,
      discoveredAtRun: topology.runCount,
    });
  }

  return results.sort((a, b) => b.bridgeScore - a.bridgeScore);
}

export interface RearrangementEvent {
  endpoints: [string, string];
  fromRun: number;
  toRun: number;
  oldIntermediates: string[];
  newIntermediates: string[];
  domainShift: boolean;
}

export function detectRearrangements(histories: ChainHistory[]): RearrangementEvent[] {
  const events: RearrangementEvent[] = [];

  for (const history of histories) {
    if (history.versions.length < 2) continue;

    for (let i = 1; i < history.versions.length; i++) {
      const prev = history.versions[i - 1];
      const curr = history.versions[i];

      const prevKey = prev.intermediates.join('|');
      const currKey = curr.intermediates.join('|');

      if (prevKey !== currKey) {
        // detect domain shift: check if intermediates come from different domains
        const domainShift = prev.intermediates.some((p) => !curr.intermediates.includes(p));

        events.push({
          endpoints: history.endpoints,
          fromRun: prev.run,
          toRun: curr.run,
          oldIntermediates: prev.intermediates,
          newIntermediates: curr.intermediates,
          domainShift,
        });
      }
    }
  }

  return events;
}
