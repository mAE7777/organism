import { TopologyStore } from './topology.js';
import { computeBetweennessCentrality, findArticulationPoints } from './graph-metrics.js';
import type { PrunerResult } from './types.js';

export interface PruneOptions {
  hubDecayRate?: number;
  bridgeDecayRate?: number;
  normalDecayRate?: number;
  threshold?: number;
  latentDecayRate?: number;
  latentThreshold?: number;
  centralityTopPercent?: number;
}

export class StructuralPruner {
  private topology: TopologyStore;

  constructor(topology: TopologyStore) {
    this.topology = topology;
  }

  prune(options: PruneOptions = {}): PrunerResult {
    const {
      hubDecayRate = 0.15,
      bridgeDecayRate = 0.025,
      normalDecayRate = 0.05,
      threshold = 0.3,
      latentDecayRate = 0.10,
      latentThreshold = 0.2,
      centralityTopPercent = 0.10,
    } = options;

    const state = this.topology.snapshot();
    if (state.chains.length === 0 && state.latentConnections.length === 0) {
      return { hubsPenalized: [], bridgesProtected: [], redundantPathsMerged: 0, orphansArchived: [] };
    }

    // 1. Compute centrality
    const centrality = computeBetweennessCentrality(state);
    const centralityValues = Object.entries(centrality).sort((a, b) => b[1] - a[1]);
    const topCount = Math.max(1, Math.ceil(centralityValues.length * centralityTopPercent));
    const highCentralityNodes = new Set(centralityValues.slice(0, topCount).map(([n]) => n));

    // 2. Find articulation points (true bridges)
    const articulationPoints = new Set(findArticulationPoints(state));

    // 3. Classify: hubs = high centrality AND NOT articulation points
    const hubs = new Set<string>();
    const bridges = new Set<string>();
    for (const node of highCentralityNodes) {
      if (articulationPoints.has(node)) {
        bridges.add(node);
      } else {
        hubs.add(node);
      }
    }

    // 4. Apply differential decay to chains
    // Validation status modifiers: validated resists decay (0.5x), shallow/challenged decay faster (1.5x)
    for (const chain of this.topology.chains) {
      const from = chain.fromConcept.toLowerCase();
      const to = chain.toConcept.toLowerCase();
      const involvedInHub = hubs.has(from) || hubs.has(to);
      const involvedInBridge = bridges.has(from) || bridges.has(to);

      let rate: number;
      if (involvedInHub) {
        rate = hubDecayRate;
      } else if (involvedInBridge) {
        rate = bridgeDecayRate;
      } else {
        rate = normalDecayRate;
      }

      // Validation status adjusts decay rate
      const vs = chain.validationStatus;
      if (vs === 'validated') {
        rate *= 0.5; // validated chains resist decay
      } else if (vs === 'shallow' || vs === 'challenged') {
        rate *= 1.5; // shallow/challenged chains decay faster
      }

      chain.weight *= (1 - rate);
    }

    // 5. Prune chains below threshold
    const chainsBefore = this.topology.chains.length;
    const chainsToKeep = this.topology.chains.filter(c => c.weight >= threshold);
    const prunedChainCount = chainsBefore - chainsToKeep.length;
    if (prunedChainCount > 0) {
      // Use applyDecay with rate=0 and threshold to prune, or just replace
      // Since we already applied decay above, we just prune by threshold
      this.topology.applyDecay(0, threshold);
    }

    // 6. Apply latent decay
    for (const lc of this.topology.latentConnections) {
      lc.weight *= (1 - latentDecayRate);
    }
    this.topology.applyLatentDecay(0, latentThreshold);

    // 7. Find and merge redundant paths (3+ chains same endpoints)
    const endpointGroups = new Map<string, typeof state.chains>();
    for (const chain of this.topology.chains) {
      const key = [chain.fromConcept.toLowerCase(), chain.toConcept.toLowerCase()].sort().join('|');
      if (!endpointGroups.has(key)) endpointGroups.set(key, []);
      endpointGroups.get(key)!.push(chain);
    }

    let redundantMerged = 0;
    for (const [, group] of endpointGroups) {
      if (group.length >= 3) {
        group.sort((a, b) => b.weight - a.weight);
        const toArchive = group.slice(1);
        for (const chain of toArchive) {
          chain.weight = 0; // mark for removal
        }
        redundantMerged += toArchive.length;
      }
    }
    if (redundantMerged > 0) {
      this.topology.applyDecay(0, 0.001); // remove weight=0 chains
    }

    // 8. Find orphans (concepts with 0 chains above threshold)
    const connectedConcepts = new Set<string>();
    for (const chain of this.topology.chains) {
      connectedConcepts.add(chain.fromConcept.toLowerCase());
      connectedConcepts.add(chain.toConcept.toLowerCase());
    }

    const orphans: string[] = [];
    for (const concept of this.topology.concepts) {
      if (!connectedConcepts.has(concept.name.toLowerCase())) {
        orphans.push(concept.name);
      }
    }

    return {
      hubsPenalized: [...hubs],
      bridgesProtected: [...bridges],
      redundantPathsMerged: redundantMerged,
      orphansArchived: orphans,
    };
  }
}
