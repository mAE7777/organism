import { resolve, join } from 'path';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { TopologyStore } from './topology.js';
import { MetadataStore } from './metadata.js';
import { Operations } from './operations.js';
import { CostTracker } from './cost.js';
import { Circuit, type L3ProcessResult } from './circuit.js';
import { IdentityEngine } from './identity.js';
import { EmbeddingResonance } from './resonance.js';
import { computeBridgeScores } from './analysis.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed;
  // Simple seeded PRNG (mulberry32)
  function next(): number {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // Fisher-Yates shuffle
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function loadInputs(): Array<{ name: string; content: string }> {
  const inputDir = join(ROOT_DIR, 'inputs');
  const files = readdirSync(inputDir).filter(f => f.endsWith('.md')).sort();
  return files.map(f => ({
    name: f.replace('.md', ''),
    content: readFileSync(join(inputDir, f), 'utf-8'),
  }));
}

function computeJaccardOverlap(bridgesA: string[], bridgesB: string[]): number {
  const setA = new Set(bridgesA.map(b => b.toLowerCase()));
  const setB = new Set(bridgesB.map(b => b.toLowerCase()));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const countArg = args.indexOf('--count');
  const count = countArg !== -1 && args[countArg + 1] ? parseInt(args[countArg + 1], 10) : 10;
  const seedArg = args.indexOf('--seed');
  const seed = seedArg !== -1 && args[seedArg + 1] ? parseInt(args[seedArg + 1], 10) : 42;

  const allInputs = loadInputs();
  const inputs = allInputs.slice(0, count);
  const shuffled = seededShuffle(inputs, seed);

  console.log(`Order sensitivity test: ${count} inputs, seed ${seed}`);
  console.log(`Original order: ${inputs.map(i => i.name).join(', ')}`);
  console.log(`Shuffled order: ${shuffled.map(i => i.name).join(', ')}`);

  const dataDir = `topology-l3-pilot-shuffled-${count}`;
  const topoDir = join(ROOT_DIR, dataDir);
  const resultsDir = join(ROOT_DIR, `results-l3-order-test-${count}`);
  const traceDir = join(resultsDir, 'traces');

  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  const client = new Anthropic();
  const costTracker = new CostTracker(resultsDir, 25.0);
  const ops = new Operations(client, costTracker);
  const topology = new TopologyStore(topoDir);
  const metadata = new MetadataStore(topoDir);
  const identity = new IdentityEngine(client, costTracker);
  const resonance = new EmbeddingResonance();

  console.log('Initializing embedding model...');
  await resonance.init();

  topology.reset();
  metadata.reset();

  const circuit = new Circuit(topology, ops, traceDir, metadata, identity, resonance);

  console.log(`\nProcessing ${count} shuffled inputs...\n`);

  for (let i = 0; i < shuffled.length; i++) {
    const runNumber = i + 1;
    console.log(`  Input ${runNumber}/${count}: ${shuffled[i].name}`);

    try {
      const result = await circuit.processInput(shuffled[i].content, runNumber) as L3ProcessResult;
      console.log(`    Concepts: ${result.newConcepts}, Chains: ${result.newChains}`);
    } catch (err: any) {
      console.log(`    FAILED: ${err.message?.slice(0, 100) ?? err}`);
    }

    console.log(`    Cost: $${costTracker.totalCost.toFixed(4)}`);

    if (i + 1 < shuffled.length) {
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  // Compare with original topology
  const shuffledState = topology.snapshot();
  const shuffledBridges = computeBridgeScores(shuffledState);
  const shuffledBridgeNames = shuffledBridges.slice(0, 10).map(b => {
    const c = shuffledState.concepts.find(c => c.id === b.conceptId);
    return c?.name ?? b.conceptId;
  });

  // Load original trace at same run count
  const origTracePath = join(ROOT_DIR, 'results-l3', 'traces', `run-${String(count).padStart(2, '0')}.json`);
  let originalBridgeNames: string[] = [];
  if (existsSync(origTracePath)) {
    // Load original topology at run N
    const origTopo = new TopologyStore(join(ROOT_DIR, 'topology-l3'));
    const origState = origTopo.snapshot();
    const origBridges = computeBridgeScores({
      ...origState,
      // We have the full topology, but bridges depend on all concepts/chains
      // Just compute from current state — this gives bridges at run 50 not run N
      // For a proper comparison, we'd need snapshots at each run
    });
    originalBridgeNames = origBridges.slice(0, 10).map(b => {
      const c = origState.concepts.find(c => c.id === b.conceptId);
      return c?.name ?? b.conceptId;
    });
  }

  const overlap = computeJaccardOverlap(shuffledBridgeNames, originalBridgeNames);

  console.log(`\n=== Results ===`);
  console.log(`Shuffled top bridges: ${shuffledBridgeNames.join(', ')}`);
  console.log(`Original top bridges: ${originalBridgeNames.join(', ') || '(not available)'}`);
  console.log(`Jaccard overlap: ${(overlap * 100).toFixed(1)}%`);
  console.log(`\nDecision:`);
  if (originalBridgeNames.length === 0) {
    console.log(`  Cannot compare — original trace at run ${count} not found.`);
    console.log(`  Compare manually with full 50-run topology.`);
  } else if (overlap > 0.7) {
    console.log(`  CONVERGENCE — bridges overlap > 70%. Order doesn't matter much.`);
  } else if (overlap < 0.5) {
    console.log(`  PATH-DEPENDENT — bridges overlap < 50%. Order significantly affects results.`);
    console.log(`  Consider Phase 2b structural fix.`);
  } else {
    console.log(`  INCONCLUSIVE — overlap ${(overlap * 100).toFixed(1)}% is between 50-70%.`);
    console.log(`  Consider running full 50-input test for clearer signal.`);
  }

  // Save results
  const results = {
    count,
    seed,
    originalOrder: inputs.map(i => i.name),
    shuffledOrder: shuffled.map(i => i.name),
    shuffledBridges: shuffledBridgeNames,
    originalBridges: originalBridgeNames,
    jaccardOverlap: overlap,
    cost: costTracker.totalCost,
    shuffledMetrics: {
      concepts: shuffledState.concepts.length,
      chains: shuffledState.chains.length,
    },
  };

  writeFileSync(join(resultsDir, 'order-test-results.json'), JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${resultsDir}/order-test-results.json`);
  console.log(`Total cost: $${costTracker.totalCost.toFixed(4)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
