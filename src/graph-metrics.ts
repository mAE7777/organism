import type { TopologyState, NetworkMetrics, HealthCheckResult } from './types.js';

type AdjList = Map<string, string[]>;

function buildAdjacency(topology: TopologyState): AdjList {
  const adj: AdjList = new Map();
  for (const concept of topology.concepts) {
    const name = concept.name.toLowerCase();
    if (!adj.has(name)) adj.set(name, []);
  }
  for (const chain of topology.chains) {
    const from = chain.fromConcept.toLowerCase();
    const to = chain.toConcept.toLowerCase();
    if (!adj.has(from)) adj.set(from, []);
    if (!adj.has(to)) adj.set(to, []);
    if (!adj.get(from)!.includes(to)) adj.get(from)!.push(to);
    if (!adj.get(to)!.includes(from)) adj.get(to)!.push(from);
  }
  return adj;
}

export function computeBetweennessCentrality(topology: TopologyState): Record<string, number> {
  const adj = buildAdjacency(topology);
  const nodes = [...adj.keys()];
  const centrality: Record<string, number> = {};
  for (const n of nodes) centrality[n] = 0;

  // Brandes algorithm
  for (const s of nodes) {
    const stack: string[] = [];
    const pred: Record<string, string[]> = {};
    const sigma: Record<string, number> = {};
    const dist: Record<string, number> = {};
    const delta: Record<string, number> = {};

    for (const n of nodes) {
      pred[n] = [];
      sigma[n] = 0;
      dist[n] = -1;
      delta[n] = 0;
    }
    sigma[s] = 1;
    dist[s] = 0;

    const queue: string[] = [s];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++];
      stack.push(v);
      for (const w of adj.get(v) ?? []) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          pred[w].push(v);
        }
      }
    }

    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred[w]) {
        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      }
      if (w !== s) {
        centrality[w] += delta[w];
      }
    }
  }

  // Normalize for undirected graph (each path counted twice)
  for (const n of nodes) {
    centrality[n] /= 2;
  }

  return centrality;
}

export function findArticulationPoints(topology: TopologyState): string[] {
  const adj = buildAdjacency(topology);
  const nodes = [...adj.keys()];
  if (nodes.length === 0) return [];

  const visited = new Set<string>();
  const disc: Record<string, number> = {};
  const low: Record<string, number> = {};
  const parent: Record<string, string | null> = {};
  const ap = new Set<string>();
  let timer = 0;

  function dfs(u: string): void {
    visited.add(u);
    disc[u] = low[u] = timer++;
    let children = 0;

    for (const v of adj.get(u) ?? []) {
      if (!visited.has(v)) {
        children++;
        parent[v] = u;
        dfs(v);
        low[u] = Math.min(low[u], low[v]);

        if (parent[u] === null && children > 1) ap.add(u);
        if (parent[u] !== null && low[v] >= disc[u]) ap.add(u);
      } else if (v !== parent[u]) {
        low[u] = Math.min(low[u], disc[v]);
      }
    }
  }

  for (const node of nodes) {
    if (!visited.has(node)) {
      parent[node] = null;
      dfs(node);
    }
  }

  return [...ap];
}

export function giniCoefficient(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return 0;

  let sumDiffs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumDiffs += Math.abs(sorted[i] - sorted[j]);
    }
  }
  return sumDiffs / (2 * n * n * mean);
}

export function computeClusteringCoefficient(topology: TopologyState): number {
  const adj = buildAdjacency(topology);
  const nodes = [...adj.keys()];
  if (nodes.length === 0) return 0;

  let totalCoeff = 0;
  let countable = 0;

  for (const node of nodes) {
    const neighbors = adj.get(node) ?? [];
    const k = neighbors.length;
    if (k < 2) continue;

    let triangles = 0;
    for (let i = 0; i < neighbors.length; i++) {
      for (let j = i + 1; j < neighbors.length; j++) {
        const neighborsOfI = adj.get(neighbors[i]) ?? [];
        if (neighborsOfI.includes(neighbors[j])) {
          triangles++;
        }
      }
    }

    const possibleTriangles = (k * (k - 1)) / 2;
    totalCoeff += triangles / possibleTriangles;
    countable++;
  }

  return countable > 0 ? totalCoeff / countable : 0;
}

export function computeDiameter(topology: TopologyState): number {
  const adj = buildAdjacency(topology);
  const nodes = [...adj.keys()];
  if (nodes.length <= 1) return 0;

  // Sample if too many nodes
  const sampleNodes = nodes.length > 300
    ? nodes.filter((_, i) => i % Math.ceil(nodes.length / 100) === 0)
    : nodes;

  let maxDist = 0;
  let hasDisconnected = false;

  for (const start of sampleNodes) {
    const dist = bfs(adj, start);
    for (const [, d] of dist) {
      if (d === Infinity) {
        hasDisconnected = true;
      } else if (d > maxDist) {
        maxDist = d;
      }
    }
  }

  return hasDisconnected ? Infinity : maxDist;
}

export function sampleAvgPathLength(topology: TopologyState, sampleSize = 100): number {
  const adj = buildAdjacency(topology);
  const nodes = [...adj.keys()];
  if (nodes.length <= 1) return 0;

  let totalDist = 0;
  let count = 0;

  const pairs = Math.min(sampleSize, nodes.length * (nodes.length - 1) / 2);
  for (let i = 0; i < pairs; i++) {
    const a = nodes[Math.floor(Math.random() * nodes.length)];
    const b = nodes[Math.floor(Math.random() * nodes.length)];
    if (a === b) continue;

    const dist = bfs(adj, a);
    const d = dist.get(b);
    if (d !== undefined && d !== Infinity) {
      totalDist += d;
      count++;
    }
  }

  return count > 0 ? totalDist / count : 0;
}

function bfs(adj: AdjList, start: string): Map<string, number> {
  const dist = new Map<string, number>();
  for (const node of adj.keys()) dist.set(node, Infinity);
  dist.set(start, 0);

  const queue: string[] = [start];
  let qi = 0;
  while (qi < queue.length) {
    const current = queue[qi++];
    const currentDist = dist.get(current)!;
    for (const neighbor of adj.get(current) ?? []) {
      if (dist.get(neighbor) === Infinity) {
        dist.set(neighbor, currentDist + 1);
        queue.push(neighbor);
      }
    }
  }
  return dist;
}

export function computeNetworkMetrics(topology: TopologyState): NetworkMetrics {
  const centrality = computeBetweennessCentrality(topology);
  const values = Object.values(centrality);
  const sorted = [...values].sort((a, b) => b - a);
  const total = sorted.reduce((s, v) => s + v, 0);
  const top3 = sorted.slice(0, 3).reduce((s, v) => s + v, 0);
  const top3Share = total > 0 ? top3 / total : 0;

  return {
    top3PathShare: top3Share,
    diameter: computeDiameter(topology),
    clusteringCoeff: computeClusteringCoefficient(topology),
    articulationPoints: findArticulationPoints(topology),
    avgPathLength: sampleAvgPathLength(topology),
  };
}

/**
 * Pure-code health check: detect structural pathologies without LM calls.
 */
export function topologyHealthCheck(
  topology: TopologyState,
  previousBridges?: string[],
): HealthCheckResult {
  const centrality = computeBetweennessCentrality(topology);
  const values = Object.values(centrality);
  const hgi = giniCoefficient(values);

  // Stale regions: find connected subgraphs where all chains have weight < 0.5
  const adj = buildAdjacency(topology);
  const conceptNames = [...new Set(topology.concepts.map(c => c.name.toLowerCase()))];
  const visited = new Set<string>();
  const staleRegions: Array<{ concepts: string[]; avgWeight: number }> = [];

  for (const name of conceptNames) {
    if (visited.has(name)) continue;
    // BFS to find connected component
    const component: string[] = [];
    const queue = [name];
    visited.add(name);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      component.push(curr);
      for (const neighbor of adj.get(curr) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    // Check if all chains in this component are stale
    const componentSet = new Set(component);
    const componentChains = topology.chains.filter(
      c => componentSet.has(c.fromConcept.toLowerCase()) && componentSet.has(c.toConcept.toLowerCase())
    );
    if (componentChains.length > 0) {
      const avgWeight = componentChains.reduce((s, c) => s + c.weight, 0) / componentChains.length;
      if (avgWeight < 0.5) {
        staleRegions.push({ concepts: component, avgWeight });
      }
    }
  }

  // Orphans: concepts with no chains at all
  const conceptsWithChains = new Set<string>();
  for (const chain of topology.chains) {
    conceptsWithChains.add(chain.fromConcept.toLowerCase());
    conceptsWithChains.add(chain.toConcept.toLowerCase());
  }
  const orphanCount = topology.concepts.filter(c => !conceptsWithChains.has(c.name.toLowerCase())).length;

  // Bridge stability
  const currentBridges = computeBetweennessCentrality(topology);
  const sortedBridges = Object.entries(currentBridges)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name);

  const prevSet = new Set(previousBridges ?? []);
  const currSet = new Set(sortedBridges);

  const bridgeStability = {
    stable: sortedBridges.filter(b => prevSet.has(b)),
    newBridges: sortedBridges.filter(b => !prevSet.has(b)),
    lostBridges: (previousBridges ?? []).filter(b => !currSet.has(b)),
  };

  // Warnings
  const warnings: string[] = [];
  if (hgi > 0.7) warnings.push(`High hub gravity (Gini=${hgi.toFixed(3)}) — star graph risk`);
  if (staleRegions.length > 0) warnings.push(`${staleRegions.length} stale region(s) with avg weight < 0.5`);
  if (orphanCount > topology.concepts.length * 0.3) warnings.push(`${orphanCount} orphan concepts (>${Math.round(topology.concepts.length * 0.3)} threshold)`);
  if (bridgeStability.lostBridges.length >= 3) warnings.push(`${bridgeStability.lostBridges.length} top bridges lost since last check`);

  return { hubGravityIndex: hgi, staleRegions, orphanCount, bridgeStability, warnings };
}
