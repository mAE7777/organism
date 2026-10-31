import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { TopologyStore } from './topology.js';
import { MetadataStore } from './metadata.js';
import { Operations } from './operations.js';
import { IdentityEngine } from './identity.js';
import { findResonantPairs, computeBridgeScores, detectRearrangements } from './analysis.js';
import { findPaths, discoverEmergentPaths, type TransitivePath } from './traversal.js';
import { StructuralPruner } from './pruner.js';
import { EmbeddingResonance } from './resonance.js';
import { findArticulationPoints } from './graph-metrics.js';
import { emitSignal } from './signals.js';
import { giniCoefficient, computeBetweennessCentrality, computeNetworkMetrics } from './graph-metrics.js';
import type {
  Chain, Concept, ComparisonResult, FacetPair, TopologyState, LatentConnection,
  TopologySignal, PrunerResult, NetworkMetrics, TopologyQuestion, SignalQueryContext,
} from './types.js';

export interface L2ProcessResult {
  newConcepts: number;
  newChains: number;
  pruned: number;
  latentPruned: number;
  newLatentConnections: number;
  bridgesDetected: number;
  identityShift: boolean;
  comparison: ComparisonResult;
}

export interface L3ProcessResult extends L2ProcessResult {
  signal: TopologySignal;
  prunerResult: PrunerResult;
}

export interface L2QueryResult {
  answer: string;
  pathsUsed: { direct: number; transitive: number; latent: number };
}

export class Circuit {
  private topology: TopologyStore;
  private metadata: MetadataStore;
  private ops: Operations;
  private identity: IdentityEngine;
  private traceDir: string;
  private resonance: EmbeddingResonance | null;
  private useL3: boolean;
  private lastSignal: TopologySignal | null = null;

  constructor(
    topology: TopologyStore,
    ops: Operations,
    traceDir: string,
    metadata?: MetadataStore,
    identity?: IdentityEngine,
    resonance?: EmbeddingResonance,
  ) {
    this.topology = topology;
    this.ops = ops;
    this.traceDir = traceDir;
    this.metadata = metadata ?? new MetadataStore(traceDir);
    this.identity = identity ?? (null as any);
    this.resonance = resonance ?? null;
    this.useL3 = !!resonance;
    if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });
  }

  async processInput(text: string, runNumber: number): Promise<L2ProcessResult | L3ProcessResult> {
    if (this.useL3) {
      return this.processInputL3(text, runNumber);
    }
    return this.processInputL2(text, runNumber);
  }

  private async processInputL2(text: string, runNumber: number): Promise<L2ProcessResult> {
    const previousSnapshot = this.topology.snapshot();

    const latestIdentity = this.metadata.getLatestIdentity();
    const identityContext = latestIdentity && this.identity
      ? this.identity.formatForDecompose(latestIdentity)
      : undefined;

    const decomposed = await this.ops.decompose(text, identityContext);
    const concepts: Concept[] = decomposed.concepts.map((c, i) => ({
      id: `r${runNumber}-c${i}`,
      name: c.name,
      facets: c.facets,
      sourceInput: runNumber,
    }));
    this.topology.addConcepts(concepts);

    let newChainCount = 0;
    newChainCount = await this.connectConcepts(concepts, runNumber);

    let newLatentCount = 0;
    for (const concept of concepts) {
      const resonant = findResonantPairs(concept, this.topology.concepts, 0.5);
      for (const lc of resonant) {
        this.topology.addLatentConnection(lc);
        newLatentCount++;
      }
    }

    const bridges = computeBridgeScores(this.topology.snapshot());
    this.metadata.updateBridgeConcepts(bridges);

    const pruned = this.topology.applyDecay(0.05, 0.3);
    const latentPruned = this.topology.applyLatentDecay(0.10, 0.2);

    this.topology.runCount = runNumber;
    const currentSnapshot = this.topology.snapshot();
    const comparison = await this.ops.compare(previousSnapshot, currentSnapshot);

    let identityShift = false;
    if (this.identity) {
      const rearrangements = detectRearrangements(this.metadata.chainHistories);
      const snapshot = await this.identity.generateSnapshot(
        currentSnapshot, bridges, latestIdentity, rearrangements,
        { chains: pruned, latent: latentPruned }, runNumber,
      );
      this.metadata.addIdentitySnapshot(snapshot);
      identityShift = latestIdentity ? snapshot.description !== latestIdentity.description : true;
    }

    this.topology.save();
    this.saveTrace(runNumber, {
      concepts: concepts.length, newChains: newChainCount,
      newLatentConnections: newLatentCount, bridgesDetected: bridges.length,
      pruned, latentPruned, identityShift, comparison,
    });

    return {
      newConcepts: concepts.length, newChains: newChainCount,
      pruned, latentPruned, newLatentConnections: newLatentCount,
      bridgesDetected: bridges.length, identityShift, comparison,
    };
  }

  private async processInputL3(text: string, runNumber: number): Promise<L3ProcessResult> {
    const previousSnapshot = this.topology.snapshot();

    const latestIdentity = this.metadata.getLatestIdentity();
    const bridges = this.metadata.getBridgeConcepts();
    const rearrangements = detectRearrangements(this.metadata.chainHistories);

    // 1. Crystallization decompose (two-phase)
    const topBridgeNames = bridges.slice(0, 5).map(b => {
      const concept = this.topology.concepts.find(c => c.id === b.conceptId);
      return concept?.name ?? b.conceptId;
    });

    const crystallized = await this.ops.decomposeCrystallize(text, {
      topBridges: topBridgeNames,
      recentRearrangements: rearrangements.slice(0, 3).map(r =>
        `${r.endpoints.join('↔')}: ${r.oldIntermediates.join(',')} → ${r.newIntermediates.join(',')}`
      ),
      highUncertaintyRegions: [],
      currentIdentity: latestIdentity && this.identity
        ? this.identity.formatForDecompose(latestIdentity)
        : undefined,
    });

    const concepts: Concept[] = crystallized.concepts.map((c, i) => ({
      id: `r${runNumber}-c${i}`,
      name: c.name,
      facets: c.facets,
      sourceInput: runNumber,
    }));
    this.topology.addConcepts(concepts);

    // Store questions
    for (const q of crystallized.questions) {
      this.topology.addQuestion({
        id: `q-r${runNumber}-${Math.random().toString(36).slice(2, 8)}`,
        text: q.text,
        sourceInput: runNumber,
        relatedConcepts: q.relatedConcepts,
        status: 'open',
      });
    }

    // Check if new concepts address open questions via embedding similarity
    if (this.resonance) {
      try {
        const openQuestions = this.topology.getQuestions('open');
        for (const q of openQuestions) {
          for (const concept of concepts) {
            const qEmb = await this.resonance.embed(q.text);
            const cEmb = await this.resonance.embed(
              `${concept.name} ${concept.facets.map(f => f.attribute).join(' ')}`
            );
            const similarity = EmbeddingResonance.cosineSimilarity(qEmb, cEmb);
            if (similarity > 0.55) {
              this.topology.markQuestionAddressed(q.id, runNumber);
              break;
            }
          }
        }
      } catch (err: any) {
        console.log(`  Warning: question resolution embedding failed: ${err.message?.slice(0, 80) ?? err}`);
      }
    }

    // 2. Connect
    const newChainCount = await this.connectConcepts(concepts, runNumber);

    // 3. Embedding resonance scan
    let newLatentCount = 0;
    if (this.resonance) {
      try {
        for (const concept of concepts) {
          const resonant = await this.resonance.findResonantPairs(
            concept, this.topology.concepts,
          );
          for (const lc of resonant) {
            this.topology.addLatentConnection(lc);
            newLatentCount++;
          }
        }
      } catch (err: any) {
        console.log(`  Warning: resonance scan embedding failed: ${err.message?.slice(0, 80) ?? err}`);
      }
    }

    // 4. Bridge detection
    const newBridges = computeBridgeScores(this.topology.snapshot());
    this.metadata.updateBridgeConcepts(newBridges);

    // 5. Structural pruning (replaces flat decay)
    const pruner = new StructuralPruner(this.topology);
    const prunerResult = pruner.prune();

    // Count pruned for backward compat
    const afterPrune = this.topology.snapshot();
    const pruned = previousSnapshot.chains.length - afterPrune.chains.length + newChainCount;
    const latentPruned = previousSnapshot.latentConnections.length - afterPrune.latentConnections.length + newLatentCount;

    // 6. Compare
    this.topology.runCount = runNumber;
    const currentSnapshot = this.topology.snapshot();
    const comparison = await this.ops.compare(previousSnapshot, currentSnapshot);

    // 7. Identity update
    let identityShift = false;
    if (this.identity) {
      const snapshot = await this.identity.generateSnapshot(
        currentSnapshot, newBridges, latestIdentity, rearrangements,
        { chains: Math.max(0, pruned), latent: Math.max(0, latentPruned) }, runNumber,
      );
      this.metadata.addIdentitySnapshot(snapshot);
      identityShift = latestIdentity ? snapshot.description !== latestIdentity.description : true;
    }

    // 8. Emit signal
    const articulationPoints = findArticulationPoints(currentSnapshot);
    const emergentPaths = discoverEmergentPaths(currentSnapshot, 0.1, 2, 5);
    const newRearrangements = detectRearrangements(this.metadata.chainHistories);

    const signal = emitSignal(
      currentSnapshot, this.lastSignal,
      newBridges, articulationPoints, prunerResult,
      newRearrangements, emergentPaths, runNumber,
    );
    this.lastSignal = signal;
    this.metadata.addSignal(signal);

    // 9. Save
    this.topology.save();
    this.saveTrace(runNumber, {
      concepts: concepts.length, newChains: newChainCount,
      newLatentConnections: newLatentCount, bridgesDetected: newBridges.length,
      pruned: Math.max(0, pruned), latentPruned: Math.max(0, latentPruned),
      identityShift, comparison, signal,
    });

    return {
      newConcepts: concepts.length, newChains: newChainCount,
      pruned: Math.max(0, pruned), latentPruned: Math.max(0, latentPruned),
      newLatentConnections: newLatentCount, bridgesDetected: newBridges.length,
      identityShift, comparison, signal, prunerResult,
    };
  }

  private async connectConcepts(concepts: Concept[], runNumber: number): Promise<number> {
    let newChainCount = 0;
    const chainsAddedThisRun = new Map<string, number>();

    // Pre-compute total degree for soft cap
    const totalDegree = new Map<string, number>();
    for (const chain of this.topology.chains) {
      const f = chain.fromConcept.toLowerCase();
      const t = chain.toConcept.toLowerCase();
      totalDegree.set(f, (totalDegree.get(f) ?? 0) + 1);
      totalDegree.set(t, (totalDegree.get(t) ?? 0) + 1);
    }

    for (const concept of concepts) {
      // Step 1: Find target concepts (embedding pre-filter if available, else string overlap)
      let targetConcepts: Concept[] = [];
      let embeddingFailed = false;
      if (this.resonance && this.topology.concepts.length > 5) {
        try {
          const conceptText = `${concept.name} ${concept.facets.slice(0, 3).map(f => f.attribute).join(' ')}`;
          const conceptEmb = await this.resonance.embed(conceptText);
          const scored: Array<{ concept: Concept; similarity: number }> = [];
          for (const existing of this.topology.concepts) {
            if (existing.name.toLowerCase() === concept.name.toLowerCase()) continue;
            if ((chainsAddedThisRun.get(existing.name.toLowerCase()) ?? 0) >= 3) continue;
            const existingText = `${existing.name} ${existing.facets.slice(0, 3).map(f => f.attribute).join(' ')}`;
            const existingEmb = await this.resonance.embed(existingText);
            const sim = EmbeddingResonance.cosineSimilarity(conceptEmb, existingEmb);
            scored.push({ concept: existing, similarity: sim });
          }
          targetConcepts = scored.sort((a, b) => b.similarity - a.similarity).slice(0, 5).map(s => s.concept);
        } catch (err: any) {
          console.log(`  Warning: embedding pre-filter failed, falling back to string matching: ${err.message?.slice(0, 80) ?? err}`);
          embeddingFailed = true;
          targetConcepts = [];
        }
      }
      if (!this.resonance || this.topology.concepts.length <= 5 || embeddingFailed) {
        // Fallback: string-matching for small topologies or no resonance
        const allPairs: Array<{ concept: Concept; score: number }> = [];
        for (const facet of concept.facets) {
          const overlaps = this.topology.findOverlaps(facet, concept.name);
          for (const overlap of overlaps) {
            const existing = allPairs.find(p => p.concept.name === overlap.concept.name);
            if (existing) {
              existing.score = Math.max(existing.score, overlap.score);
            } else {
              allPairs.push({ concept: overlap.concept, score: overlap.score });
            }
          }
        }
        targetConcepts = allPairs.sort((a, b) => b.score - a.score).slice(0, 5).map(p => p.concept);
      }

      // Step 2: Pick best facet pair from each target
      const allPairs: FacetPair[] = [];
      for (const target of targetConcepts) {
        let bestPair: FacetPair | null = null;
        let bestScore = 0;
        for (const fA of concept.facets) {
          for (const fB of target.facets) {
            let score = 0;
            if (fA.domain.toLowerCase() === fB.domain.toLowerCase()) score += 1;
            if (fA.attribute.toLowerCase() === fB.attribute.toLowerCase()) score += 1;
            else if (fA.attribute.toLowerCase().includes(fB.attribute.toLowerCase()) ||
                     fB.attribute.toLowerCase().includes(fA.attribute.toLowerCase())) score += 0.5;
            if (score > bestScore) {
              bestScore = score;
              bestPair = {
                facetA: { concept: concept.name, facet: fA },
                facetB: { concept: target.name, facet: fB },
              };
            }
          }
        }
        if (bestPair) allPairs.push(bestPair);
      }

      if (allPairs.length === 0) continue;

      // Step 3: One Sonnet batch (max 5 pairs)
      const pairs = allPairs.slice(0, 5);
      const topologyContext = this.formatTopologyContext();
      const results = await this.ops.connect(pairs, topologyContext);

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (!result) continue;
        const pair = pairs[j];
        const targetKey = pair.facetB.concept.toLowerCase();

        // Degree cap enforcement
        const degree = totalDegree.get(targetKey) ?? 0;
        const minConfidence = degree > 15 ? 0.8 : 0.6;
        if (result.confidence <= minConfidence) continue;
        if ((chainsAddedThisRun.get(targetKey) ?? 0) >= 3) continue;

        const chain: Chain = {
          id: `r${runNumber}-chain-${newChainCount}`,
          fromConcept: pair.facetA.concept,
          toConcept: pair.facetB.concept,
          steps: result.chain,
          depth: result.chain.length,
          domainsCrossed: result.domainsCrossed,
          confidence: result.confidence,
          weight: 1.0,
          createdAtRun: runNumber,
          lastTraversedRun: runNumber,
        };
        this.topology.addChain(chain);
        newChainCount++;
        chainsAddedThisRun.set(targetKey, (chainsAddedThisRun.get(targetKey) ?? 0) + 1);
        totalDegree.set(targetKey, (totalDegree.get(targetKey) ?? 0) + 1);

        const intermediates = result.chain.slice(0, -1).map(s => s.toConcept);
        this.metadata.recordChainVersion(
          [pair.facetA.concept, pair.facetB.concept],
          runNumber, intermediates, result.confidence,
        );
      }
    }
    return newChainCount;
  }

  async query(question: string): Promise<L2QueryResult> {
    const state = this.topology.snapshot();
    const relevantConcepts = this.findRelevantConcepts(question, state.concepts);
    const relevantNames = relevantConcepts.map((c) => c.name);

    const transitivePaths: TransitivePath[] = [];
    for (let i = 0; i < relevantNames.length; i++) {
      for (let j = i + 1; j < relevantNames.length; j++) {
        const paths = findPaths(relevantNames[i], relevantNames[j], state, 5);
        transitivePaths.push(...paths);
      }
    }

    const relevantLatent = state.latentConnections.filter((lc) => {
      const fromRelevant = relevantNames.some((n) => n.toLowerCase() === lc.fromConcept.toLowerCase());
      const toRelevant = relevantNames.some((n) => n.toLowerCase() === lc.toConcept.toLowerCase());
      return fromRelevant || toRelevant;
    });

    const relevantChains = state.chains.filter((c) => {
      const fromRelevant = relevantNames.some((n) => n.toLowerCase() === c.fromConcept.toLowerCase());
      const toRelevant = relevantNames.some((n) => n.toLowerCase() === c.toConcept.toLowerCase());
      return fromRelevant || toRelevant;
    });

    const currentRun = state.runCount;
    for (const chain of relevantChains) {
      this.topology.markTraversed(chain.id, currentRun);
    }
    for (const path of transitivePaths) {
      for (const chainId of path.chainIds) {
        this.topology.markTraversed(chainId, currentRun);
      }
    }
    this.topology.save();

    // Use signal-driven query if L3 mode and signal is available
    let answer: string;
    const signal = this.metadata.getAllSignals().at(-1) ?? this.lastSignal ?? null;
    if (this.useL3 && signal) {
      const context = this.buildSignalContext(question, relevantConcepts, state, signal);
      answer = await this.ops.queryWithSignal(question, context);
    } else {
      answer = await this.ops.queryWithTopology(question, state);
    }

    return {
      answer,
      pathsUsed: {
        direct: relevantChains.length,
        transitive: transitivePaths.length,
        latent: relevantLatent.length,
      },
    };
  }

  emitCurrentSignal(): TopologySignal | null {
    const state = this.topology.snapshot();
    const bridges = computeBridgeScores(state);
    const articulationPoints = findArticulationPoints(state);
    const emergentPaths = discoverEmergentPaths(state, 0.1, 2, 5);
    const rearrangements = detectRearrangements(this.metadata.chainHistories);

    const emptyPrunerResult: PrunerResult = {
      hubsPenalized: [], bridgesProtected: [],
      redundantPathsMerged: 0, orphansArchived: [],
    };

    return emitSignal(
      state, this.lastSignal, bridges, articulationPoints,
      emptyPrunerResult, rearrangements, emergentPaths, state.runCount,
    );
  }

  getMetrics(): Record<string, any> {
    const base = this.topology.getMetrics();
    if (!this.useL3) return base;

    const state = this.topology.snapshot();
    const centrality = computeBetweennessCentrality(state);
    const values = Object.values(centrality);
    const networkMetrics = computeNetworkMetrics(state);

    return {
      ...base,
      hubGravityIndex: giniCoefficient(values),
      articulationPointCount: networkMetrics.articulationPoints.length,
      networkMetrics,
    };
  }

  getState(): TopologyState {
    return this.topology.snapshot();
  }

  getLastCompletedRun(): number {
    return this.topology.runCount;
  }

  getLastSignal(): TopologySignal | null {
    return this.lastSignal;
  }

  private findRelevantConcepts(question: string, concepts: Concept[]): Concept[] {
    const questionWords = new Set(
      question.toLowerCase().split(/[\s,?.!]+/).filter((w) => w.length > 2)
    );

    const scored = concepts.map((concept) => {
      let score = 0;
      const nameWords = concept.name.toLowerCase().split(/[\s-]+/);
      for (const nw of nameWords) {
        if (questionWords.has(nw)) score += 3;
        for (const qw of questionWords) {
          if (nw.includes(qw) || qw.includes(nw)) score += 1;
        }
      }
      for (const facet of concept.facets) {
        const attrWords = facet.attribute.toLowerCase().split(/[\s-]+/);
        for (const aw of attrWords) {
          if (questionWords.has(aw)) score += 2 * facet.salience;
          for (const qw of questionWords) {
            if (aw.includes(qw) || qw.includes(aw)) score += 0.5 * facet.salience;
          }
        }
      }
      return { concept, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((s) => s.concept);
  }

  private formatTopologyContext(): string {
    const state = this.topology.snapshot();
    if (state.concepts.length === 0) return 'Empty topology.';

    const concepts = state.concepts
      .map((c) => `${c.name}: ${c.facets.map((f) => `${f.domain}:${f.attribute}`).join(', ')}`)
      .join('\n');

    const chains = state.chains
      .slice(0, 20)
      .map((c) => `${c.fromConcept} → ${c.toConcept} (${c.domainsCrossed.join(',')})`)
      .join('\n');

    return `Concepts:\n${concepts}\n\nExisting chains:\n${chains || 'None yet.'}`;
  }

  buildSignalContext(
    question: string,
    relevantConcepts: Concept[],
    state: TopologyState,
    signal: TopologySignal | null,
  ): SignalQueryContext {
    const bridges = (signal?.bridges ?? []).slice(0, 5).map(b => ({
      name: b.concept,
      structuralClaim: b.structuralClaim ?? '',
      domains: b.domains ?? [],
      sourceCount: b.sourceCount ?? 0,
    }));

    const emergentPaths = (signal?.emergentPaths ?? []).slice(0, 5);

    const contradictions = (signal?.contradictions ?? []).map(c => ({
      description: `${c.conceptA} vs ${c.conceptB}: ${c.tension}`,
    }));

    return {
      inputCount: state.runCount,
      domainCount: new Set(state.concepts.flatMap(c => c.facets.map(f => f.domain))).size,
      bridges,
      emergentPaths,
      contradictions,
    };
  }

  private saveTrace(runNumber: number, data: unknown): void {
    writeFileSync(
      join(this.traceDir, `run-${String(runNumber).padStart(2, '0')}.json`),
      JSON.stringify(data, null, 2)
    );
  }
}
