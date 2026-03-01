import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Concept, Chain, Facet, TopologyState, LatentConnection, TopologyQuestion, ChainValidationStatus } from './types.js';

export class TopologyStore {
  private state: TopologyState;
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'state.json');
    if (existsSync(this.filePath)) {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      this.state = {
        concepts: raw.concepts ?? [],
        chains: raw.chains ?? [],
        latentConnections: raw.latentConnections ?? [],
        runCount: raw.runCount ?? 0,
        questions: raw.questions ?? [],
      };
    } else {
      this.state = { concepts: [], chains: [], latentConnections: [], runCount: 0, questions: [] };
    }
  }

  get concepts(): Concept[] {
    return this.state.concepts;
  }

  get chains(): Chain[] {
    return this.state.chains;
  }

  get latentConnections(): LatentConnection[] {
    return this.state.latentConnections;
  }

  get runCount(): number {
    return this.state.runCount;
  }

  set runCount(n: number) {
    this.state.runCount = n;
  }

  addConcepts(newConcepts: Concept[]): void {
    for (const nc of newConcepts) {
      const existing = this.state.concepts.find(
        (c) => c.name.toLowerCase() === nc.name.toLowerCase()
      );
      if (existing) {
        for (const facet of nc.facets) {
          const hasFacet = existing.facets.some(
            (f) => f.domain.toLowerCase() === facet.domain.toLowerCase() &&
                   f.attribute.toLowerCase() === facet.attribute.toLowerCase()
          );
          if (!hasFacet) {
            existing.facets.push(facet);
          }
        }
      } else {
        this.state.concepts.push(nc);
      }
    }
  }

  addChain(chain: Chain): void {
    const fromLower = chain.fromConcept.toLowerCase();
    const toLower = chain.toConcept.toLowerCase();
    const existing = this.state.chains.find(
      (c) =>
        (c.fromConcept.toLowerCase() === fromLower && c.toConcept.toLowerCase() === toLower) ||
        (c.fromConcept.toLowerCase() === toLower && c.toConcept.toLowerCase() === fromLower)
    );
    if (existing) {
      if (chain.confidence > existing.confidence) {
        Object.assign(existing, chain);
      }
      const runSpan = Math.max(0, (chain.lastTraversedRun ?? 0) - (existing.createdAtRun ?? 0));
      const resilienceBonus = Math.min(0.1, 0.05 + runSpan * 0.001);
      existing.weight = Math.min(1.0, existing.weight + resilienceBonus);
      existing.lastTraversedRun = chain.lastTraversedRun;
    } else {
      this.state.chains.push(chain);
    }
  }

  addLatentConnection(lc: LatentConnection): void {
    const key = [lc.fromConcept.toLowerCase(), lc.toConcept.toLowerCase()].sort().join('|');
    const existing = this.state.latentConnections.find((c) => {
      const existingKey = [c.fromConcept.toLowerCase(), c.toConcept.toLowerCase()].sort().join('|');
      return existingKey === key;
    });
    if (existing) {
      // merge facet pairs, keep higher resonance score
      for (const fp of lc.facetPairs) {
        const hasPair = existing.facetPairs.some(
          (ep) =>
            ep.facetA.concept.toLowerCase() === fp.facetA.concept.toLowerCase() &&
            ep.facetA.facet.attribute.toLowerCase() === fp.facetA.facet.attribute.toLowerCase() &&
            ep.facetB.concept.toLowerCase() === fp.facetB.concept.toLowerCase() &&
            ep.facetB.facet.attribute.toLowerCase() === fp.facetB.facet.attribute.toLowerCase()
        );
        if (!hasPair) {
          existing.facetPairs.push(fp);
        }
      }
      if (lc.resonanceScore > existing.resonanceScore) {
        existing.resonanceScore = lc.resonanceScore;
      }
    } else {
      this.state.latentConnections.push(lc);
    }
  }

  applyDecay(rate: number, threshold = 0.3): number {
    let pruned = 0;

    for (const chain of this.state.chains) {
      chain.weight *= (1 - rate);
    }

    const before = this.state.chains.length;
    this.state.chains = this.state.chains.filter((c) => c.weight >= threshold);
    pruned = before - this.state.chains.length;

    return pruned;
  }

  applyLatentDecay(rate: number, threshold = 0.2): number {
    for (const lc of this.state.latentConnections) {
      lc.weight *= (1 - rate);
    }

    const before = this.state.latentConnections.length;
    this.state.latentConnections = this.state.latentConnections.filter((c) => c.weight >= threshold);
    return before - this.state.latentConnections.length;
  }

  markTraversed(chainId: string, run: number): void {
    const chain = this.state.chains.find((c) => c.id === chainId);
    if (chain) {
      chain.weight = 1.0;
      chain.lastTraversedRun = run;
    }
  }

  findChainsThrough(conceptName: string): Chain[] {
    const lower = conceptName.toLowerCase();
    return this.state.chains.filter((c) => {
      if (c.fromConcept.toLowerCase() === lower || c.toConcept.toLowerCase() === lower) return true;
      return c.steps.some(
        (s) => s.fromConcept.toLowerCase() === lower || s.toConcept.toLowerCase() === lower
      );
    });
  }

  findOverlaps(facet: Facet, excludeConcept?: string): Array<{ concept: Concept; facet: Facet; score: number }> {
    const results: Array<{ concept: Concept; facet: Facet; score: number }> = [];

    for (const concept of this.state.concepts) {
      if (excludeConcept && concept.name.toLowerCase() === excludeConcept.toLowerCase()) continue;

      for (const f of concept.facets) {
        let score = 0;
        if (f.domain.toLowerCase() === facet.domain.toLowerCase()) score += 1.0;
        if (f.attribute.toLowerCase() === facet.attribute.toLowerCase()) score += 1.0;
        else if (
          f.attribute.toLowerCase().includes(facet.attribute.toLowerCase()) ||
          facet.attribute.toLowerCase().includes(f.attribute.toLowerCase())
        ) {
          score += 0.5;
        }

        if (score > 0) {
          results.push({ concept, facet: f, score });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  snapshot(): TopologyState {
    return JSON.parse(JSON.stringify(this.state));
  }

  getMetrics(): {
    conceptCount: number;
    chainCount: number;
    avgDepth: number;
    crossInputChainCount: number;
    avgWeight: number;
    latentConnectionCount: number;
  } {
    const chains = this.state.chains;
    const avgDepth = chains.length > 0 ? chains.reduce((s, c) => s + c.depth, 0) / chains.length : 0;
    const avgWeight = chains.length > 0 ? chains.reduce((s, c) => s + c.weight, 0) / chains.length : 0;

    let crossInputCount = 0;
    for (const chain of chains) {
      const fromConcept = this.state.concepts.find((c) => c.id === chain.fromConcept || c.name === chain.fromConcept);
      const toConcept = this.state.concepts.find((c) => c.id === chain.toConcept || c.name === chain.toConcept);
      if (fromConcept && toConcept && fromConcept.sourceInput !== toConcept.sourceInput) {
        crossInputCount++;
      }
    }

    return {
      conceptCount: this.state.concepts.length,
      chainCount: chains.length,
      avgDepth,
      crossInputChainCount: crossInputCount,
      avgWeight,
      latentConnectionCount: this.state.latentConnections.length,
    };
  }

  addQuestion(q: TopologyQuestion): void {
    if (!this.state.questions) this.state.questions = [];
    this.state.questions.push(q);
  }

  getQuestions(status?: string): TopologyQuestion[] {
    const questions = this.state.questions ?? [];
    if (!status) return questions;
    return questions.filter(q => q.status === status);
  }

  markQuestionAddressed(questionId: string, addressedByInput: number): void {
    const q = (this.state.questions ?? []).find(q => q.id === questionId);
    if (q) {
      q.status = 'addressed';
      q.addressedByInput = addressedByInput;
    }
  }

  adjustChainWeight(chainId: string, delta: number): void {
    const chain = this.state.chains.find(c => c.id === chainId);
    if (chain) {
      chain.weight = Math.max(0, Math.min(1.0, chain.weight + delta));
    }
  }

  setChainValidation(chainId: string, status: ChainValidationStatus): void {
    const chain = this.state.chains.find(c => c.id === chainId);
    if (chain) {
      chain.validationStatus = status;
    }
  }

  dissolveQuestion(questionId: string, rearrangementId: string): void {
    const q = (this.state.questions ?? []).find(q => q.id === questionId);
    if (q) {
      q.status = 'dissolved';
      q.dissolvedByRearrangement = rearrangementId;
    }
  }

  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  reset(): void {
    this.state = { concepts: [], chains: [], latentConnections: [], runCount: 0, questions: [] };
    this.save();
  }
}
