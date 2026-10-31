import type { Chain, TopologyState } from './types.js';

export interface TransitivePath {
  from: string;
  to: string;
  hops: string[];
  weight: number;
  sourceInputsSpanned: number[];
  depth: number;
  chainIds: string[];
}

type AdjEntry = { target: string; weight: number; chainId: string };

function buildAdjacencyList(chains: Chain[]): Map<string, AdjEntry[]> {
  const adj = new Map<string, AdjEntry[]>();
  for (const chain of chains) {
    const from = chain.fromConcept.toLowerCase();
    const to = chain.toConcept.toLowerCase();
    if (!adj.has(from)) adj.set(from, []);
    if (!adj.has(to)) adj.set(to, []);
    adj.get(from)!.push({ target: to, weight: chain.weight, chainId: chain.id });
    adj.get(to)!.push({ target: from, weight: chain.weight, chainId: chain.id });
  }
  return adj;
}

function buildDirectPairSet(chains: Chain[]): Set<string> {
  const pairs = new Set<string>();
  for (const chain of chains) {
    const a = chain.fromConcept.toLowerCase();
    const b = chain.toConcept.toLowerCase();
    pairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return pairs;
}

export function findPaths(
  from: string,
  to: string,
  topology: TopologyState,
  maxDepth = 5,
): TransitivePath[] {
  const adj = buildAdjacencyList(topology.chains);
  const conceptMap = new Map(topology.concepts.map((c) => [c.name.toLowerCase(), c]));
  const fromL = from.toLowerCase();
  const toL = to.toLowerCase();
  const results: TransitivePath[] = [];

  if (fromL === toL) return [];
  if (!adj.has(fromL) || !adj.has(toL)) return [];

  // DFS with depth limit: memory-efficient (no queue)
  const path: string[] = [fromL];
  const chainIds: string[] = [];
  const visited = new Set<string>([fromL]);

  function dfs(node: string, weight: number, depth: number): void {
    if (depth > maxDepth) return;
    if (results.length >= 20) return; // cap results

    const neighbors = adj.get(node) ?? [];
    for (const { target, weight: edgeWeight, chainId } of neighbors) {
      if (visited.has(target)) continue;

      const newWeight = weight * edgeWeight;
      path.push(target);
      chainIds.push(chainId);
      visited.add(target);

      if (target === toL && path.length > 2) {
        const inputs = new Set<number>();
        for (const n of path) {
          const concept = conceptMap.get(n);
          if (concept) inputs.add(concept.sourceInput);
        }
        results.push({
          from,
          to,
          hops: path.slice(1, -1),
          weight: newWeight,
          sourceInputsSpanned: [...inputs].sort((a, b) => a - b),
          depth: path.length - 1,
          chainIds: [...chainIds],
        });
      } else if (target !== toL) {
        dfs(target, newWeight, depth + 1);
      }

      path.pop();
      chainIds.pop();
      visited.delete(target);
    }
  }

  dfs(fromL, 1.0, 1);
  return results.sort((a, b) => b.weight - a.weight);
}

export function discoverEmergentPaths(
  topology: TopologyState,
  minWeight = 0.1,
  minSourceInputs = 3,
  maxDepth = 3,
): TransitivePath[] {
  const adj = buildAdjacencyList(topology.chains);
  const directPairs = buildDirectPairSet(topology.chains);
  const conceptMap = new Map(topology.concepts.map((c) => [c.name.toLowerCase(), c]));

  // Only start from high-degree concepts (hubs) to avoid combinatorial explosion
  const degrees = new Map<string, number>();
  for (const [node, entries] of adj) {
    degrees.set(node, entries.length);
  }
  const sortedConcepts = [...degrees.entries()].sort((a, b) => b[1] - a[1]);
  const hubConcepts = sortedConcepts.slice(0, Math.min(50, sortedConcepts.length)).map(([name]) => name);

  const results: TransitivePath[] = [];
  const seen = new Set<string>();

  for (const startName of hubConcepts) {
    if (results.length >= 200) break; // global cap

    // DFS from this hub, maxDepth limited
    const path: string[] = [startName];
    const chainIdPath: string[] = [];
    const visited = new Set<string>([startName]);
    let pathCount = 0;

    function dfs(node: string, weight: number, depth: number): void {
      if (depth > maxDepth || pathCount > 50) return;

      const neighbors = adj.get(node) ?? [];
      for (const { target, weight: edgeWeight, chainId } of neighbors) {
        if (visited.has(target)) continue;
        if (pathCount > 50) return;

        const newWeight = weight * edgeWeight;
        if (newWeight < minWeight) continue;

        path.push(target);
        chainIdPath.push(chainId);
        visited.add(target);

        // Check if this is an emergent endpoint
        if (path.length > 2) {
          const pairKey = startName < target ? `${startName}|${target}` : `${target}|${startName}`;
          if (!directPairs.has(pairKey)) {
            const inputs = new Set<number>();
            for (const n of path) {
              const concept = conceptMap.get(n);
              if (concept) inputs.add(concept.sourceInput);
            }

            if (inputs.size >= minSourceInputs) {
              const hops = path.slice(1, -1).join(',');
              const key = `${pairKey}|${hops}`;
              if (!seen.has(key)) {
                seen.add(key);
                pathCount++;
                results.push({
                  from: startName,
                  to: target,
                  hops: [...path.slice(1, -1)],
                  weight: newWeight,
                  sourceInputsSpanned: [...inputs].sort((a, b) => a - b),
                  depth: path.length - 1,
                  chainIds: [...chainIdPath],
                });
              }
            }
          }
        }

        if (depth + 1 <= maxDepth) {
          dfs(target, newWeight, depth + 1);
        }

        path.pop();
        chainIdPath.pop();
        visited.delete(target);
      }
    }

    dfs(startName, 1.0, 1);
  }

  return results.sort((a, b) => b.weight - a.weight);
}
