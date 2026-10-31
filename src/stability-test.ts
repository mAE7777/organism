import { resolve, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { Operations, type CrystallizationResult } from './operations.js';
import { CostTracker } from './cost.js';
import { IOLogger } from './io-logger.js';
import { EmbeddingResonance } from './resonance.js';
import type { Facet } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface StabilityInput {
  name: string;
  path: string;
  content: string;
  wordCount: number;
}

interface PairMetrics {
  pairLabel: string;
  exactNameJaccard: number;
  semanticNameJaccard: number;
  avgBestMatchSim: number;
  domainJSD: number;
  exactFacetJaccard: number;
  semanticFacetJaccard: number;
}

interface RunQuality {
  conceptCount: number;
  facetsPerConcept: number;
  domainCoverage: number;
  facetNontriviality: number;
  hasQuestions: boolean;
  score: number;
}

interface InputResult {
  name: string;
  wordCount: number;
  snapshots: CrystallizationResult[];
  pairMetrics: PairMetrics[];
  quality: RunQuality[];
  avgExactNameJaccard: number;
  avgSemanticNameJaccard: number;
  avgBestMatchSim: number;
  avgDomainJSD: number;
  avgExactFacetJaccard: number;
  avgSemanticFacetJaccard: number;
  avgQuality: number;
  domainDistributions: number[][];
  domainStdDevs: number[];
}

interface GlobalResult {
  avgExactNameJaccard: number;
  avgSemanticNameJaccard: number;
  avgBestMatchSim: number;
  avgDomainJSD: number;
  avgExactFacetJaccard: number;
  avgSemanticFacetJaccard: number;
  avgQuality: number;
}

type Verdict = 'STABLE' | 'ERGODIC' | 'UNSTABLE';

interface VerdictResult {
  verdict: Verdict;
  reason: string;
}

interface StabilityResult {
  timestamp: string;
  inputCount: number;
  runsPerInput: number;
  totalCost: number;
  verdict: VerdictResult;
  global: GlobalResult;
  inputs: InputResult[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DOMAINS = ['physical', 'abstract', 'social', 'temporal', 'process', 'structural', 'emotional'];

const TRIVIAL_WORDS = new Set([
  'general', 'basic', 'simple', 'common', 'standard', 'normal', 'typical', 'regular',
  'default', 'generic', 'overall', 'main', 'primary', 'core', 'fundamental',
]);

const STANDARD_INPUTS = [
  '01-security.md',
  '10-philosophy.md',
  '25-acoustic-architecture.md',
  '40-paradox-of-control.md',
  '50-utility-of-dogmatism.md',
];

const EMPTY_TOPOLOGY_CONTEXT = {
  topBridges: [] as string[],
  recentRearrangements: [] as string[],
  highUncertaintyRegions: [] as string[],
  currentIdentity: undefined,
};

// ─── Metric Functions ───────────────────────────────────────────────────────

function exactJaccard(setA: Set<string>, setB: Set<string>): number {
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

interface MatchResult {
  indexA: number;
  indexB: number;
  similarity: number;
}

function greedyMatch(
  matrixRows: number,
  matrixCols: number,
  simFn: (i: number, j: number) => number,
  threshold: number,
): MatchResult[] {
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const matches: MatchResult[] = [];

  while (usedA.size < matrixRows && usedB.size < matrixCols) {
    let bestSim = -1;
    let bestI = -1;
    let bestJ = -1;

    for (let i = 0; i < matrixRows; i++) {
      if (usedA.has(i)) continue;
      for (let j = 0; j < matrixCols; j++) {
        if (usedB.has(j)) continue;
        const sim = simFn(i, j);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestSim < threshold || bestI === -1) break;

    matches.push({ indexA: bestI, indexB: bestJ, similarity: bestSim });
    usedA.add(bestI);
    usedB.add(bestJ);
  }

  return matches;
}

function klDivergence(p: number[], q: number[]): number {
  let kl = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0 && q[i] > 0) {
      kl += p[i] * Math.log(p[i] / q[i]);
    }
  }
  return kl;
}

function jensenShannonDivergence(p: number[], q: number[]): number {
  const m = p.map((pi, i) => (pi + q[i]) / 2);
  return 0.5 * klDivergence(p, m) + 0.5 * klDivergence(q, m);
}

function domainDistribution(concepts: Array<{ facets: Facet[] }>): number[] {
  const counts = new Array(DOMAINS.length).fill(1); // Laplace smoothing
  for (const c of concepts) {
    for (const f of c.facets) {
      const idx = DOMAINS.indexOf(f.domain.toLowerCase());
      if (idx >= 0) counts[idx]++;
    }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map(c => c / total);
}

function facetSetJaccard(a: Facet[], b: Facet[]): number {
  const setA = new Set(a.map(f => `${f.domain.toLowerCase()}:${f.attribute.toLowerCase()}`));
  const setB = new Set(b.map(f => `${f.domain.toLowerCase()}:${f.attribute.toLowerCase()}`));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

function computeRunQuality(result: CrystallizationResult): RunQuality {
  const conceptCount = result.concepts.length;
  const totalFacets = result.concepts.reduce((sum, c) => sum + c.facets.length, 0);
  const facetsPerConcept = conceptCount > 0 ? totalFacets / conceptCount : 0;

  const usedDomains = new Set<string>();
  for (const c of result.concepts) {
    for (const f of c.facets) {
      usedDomains.add(f.domain.toLowerCase());
    }
  }
  const domainCoverage = usedDomains.size;

  // Nontriviality: attribute has ≥2 words and isn't in trivial set
  let nontrivialCount = 0;
  for (const c of result.concepts) {
    for (const f of c.facets) {
      const words = f.attribute.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean);
      const isTrivial = words.length === 1 && TRIVIAL_WORDS.has(words[0]);
      if (!isTrivial) nontrivialCount++;
    }
  }
  const facetNontriviality = totalFacets > 0 ? nontrivialCount / totalFacets : 0;

  const hasQuestions = (result.questions?.length ?? 0) > 0;

  // Q1: 3-8 concepts
  const q1 = conceptCount >= 3 && conceptCount <= 8 ? 1 : 0;
  // Q2: 5-10 facets/concept
  const q2 = facetsPerConcept >= 5 && facetsPerConcept <= 10 ? 1 : 0;
  // Q3: ≥4 domains
  const q3 = domainCoverage >= 4 ? 1 : 0;
  // Q4: ≥80% nontrivial
  const q4 = facetNontriviality >= 0.8 ? 1 : 0;
  // Q5: has questions
  const q5 = hasQuestions ? 1 : 0;

  const score = (q1 + q2 + q3 + q4 + q5) / 5;

  return { conceptCount, facetsPerConcept, domainCoverage, facetNontriviality, hasQuestions, score };
}

async function computePairMetrics(
  snapA: CrystallizationResult,
  snapB: CrystallizationResult,
  resonance: EmbeddingResonance,
  pairLabel: string,
): Promise<PairMetrics> {
  // M1: Exact Name Jaccard
  const namesA = new Set(snapA.concepts.map(c => c.name.toLowerCase()));
  const namesB = new Set(snapB.concepts.map(c => c.name.toLowerCase()));
  const exactNameJaccard = exactJaccard(namesA, namesB);

  // M2: Semantic Name Jaccard
  const nameListA = snapA.concepts.map(c => c.name);
  const nameListB = snapB.concepts.map(c => c.name);

  const embA = await Promise.all(nameListA.map(n => resonance.embed(n)));
  const embB = await Promise.all(nameListB.map(n => resonance.embed(n)));

  // Build similarity matrix
  const simMatrix: number[][] = [];
  for (let i = 0; i < embA.length; i++) {
    simMatrix[i] = [];
    for (let j = 0; j < embB.length; j++) {
      simMatrix[i][j] = EmbeddingResonance.cosineSimilarity(embA[i], embB[j]);
    }
  }

  const nameMatches = greedyMatch(
    embA.length, embB.length,
    (i, j) => simMatrix[i][j],
    0.55,
  );
  const semanticNameJaccard = nameListA.length + nameListB.length - nameMatches.length === 0
    ? 1
    : nameMatches.length / (nameListA.length + nameListB.length - nameMatches.length);

  // Avg best match similarity
  let totalBestSim = 0;
  for (let i = 0; i < embA.length; i++) {
    let best = 0;
    for (let j = 0; j < embB.length; j++) {
      if (simMatrix[i][j] > best) best = simMatrix[i][j];
    }
    totalBestSim += best;
  }
  const avgBestMatchSim = embA.length > 0 ? totalBestSim / embA.length : 0;

  // M3: Domain Distribution JSD
  const distA = domainDistribution(snapA.concepts);
  const distB = domainDistribution(snapB.concepts);
  const jsd = jensenShannonDivergence(distA, distB);
  const domainJSD = jsd / Math.LN2; // normalize to [0, 1]

  // M4a: Exact Facet Jaccard
  const allFacetsA = snapA.concepts.flatMap(c => c.facets);
  const allFacetsB = snapB.concepts.flatMap(c => c.facets);
  const exactFacetJaccard = facetSetJaccard(allFacetsA, allFacetsB);

  // M4b: Semantic Facet Jaccard
  const facetTextsA = allFacetsA.map(f => `${f.domain} ${f.attribute}`);
  const facetTextsB = allFacetsB.map(f => `${f.domain} ${f.attribute}`);

  const facetEmbA = await Promise.all(facetTextsA.map(t => resonance.embed(t)));
  const facetEmbB = await Promise.all(facetTextsB.map(t => resonance.embed(t)));

  const facetMatches = greedyMatch(
    facetEmbA.length, facetEmbB.length,
    (i, j) => EmbeddingResonance.cosineSimilarity(facetEmbA[i], facetEmbB[j]),
    0.50,
  );
  const semanticFacetJaccard = facetTextsA.length + facetTextsB.length - facetMatches.length === 0
    ? 1
    : facetMatches.length / (facetTextsA.length + facetTextsB.length - facetMatches.length);

  return {
    pairLabel,
    exactNameJaccard,
    semanticNameJaccard,
    avgBestMatchSim,
    domainJSD,
    exactFacetJaccard,
    semanticFacetJaccard,
  };
}

// ─── Verdict ────────────────────────────────────────────────────────────────

function determineVerdict(global: GlobalResult): VerdictResult {
  const semanticStable = global.avgSemanticNameJaccard > 0.60 && global.avgSemanticFacetJaccard > 0.55;
  const domainStable = global.avgDomainJSD < 0.15;
  const highQuality = global.avgQuality > 0.80;

  if (semanticStable && domainStable) {
    return {
      verdict: 'STABLE',
      reason: 'Semantic overlap and domain distributions are consistent across runs. Decomposition is stable, so later experiments can build on a single run.',
    };
  }

  if (!semanticStable && highQuality) {
    return {
      verdict: 'ERGODIC',
      reason: `Decomposition produces different but high-quality results each time (average quality ${global.avgQuality.toFixed(2)}). Treat one run as one sample, and combine several runs (union or intersection) before drawing conclusions from them.`,
    };
  }

  return {
    verdict: 'UNSTABLE',
    reason: `Decomposition is neither stable nor consistently high quality (semantic name Jaccard ${global.avgSemanticNameJaccard.toFixed(2)}, quality ${global.avgQuality.toFixed(2)}). Fix the decompose prompt before building on its output.`,
  };
}

// ─── Report Generation ──────────────────────────────────────────────────────

function statusLabel(value: number, threshold: number, invert = false): string {
  if (invert) return value < threshold ? 'PASS' : 'FAIL';
  return value > threshold ? 'PASS' : 'FAIL';
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function generateReport(result: StabilityResult): string {
  const { global, verdict, inputs } = result;

  const lines: string[] = [];
  lines.push('# Decomposition Stability Report');
  lines.push('');
  lines.push(`Date: ${result.timestamp}`);
  lines.push(`Inputs: ${result.inputCount}`);
  lines.push(`Runs per input: ${result.runsPerInput}`);
  lines.push(`Total cost: $${result.totalCost.toFixed(4)}`);
  lines.push('');

  lines.push(`## Verdict: ${verdict.verdict}`);
  lines.push(verdict.reason);
  lines.push('');

  lines.push('## Global Results');
  lines.push('');
  lines.push('| Metric | Score | Threshold | Status |');
  lines.push('|--------|-------|-----------|--------|');
  lines.push(`| M1: Exact Name Jaccard | ${fmt(global.avgExactNameJaccard)} | >0.60 | ${statusLabel(global.avgExactNameJaccard, 0.60)} |`);
  lines.push(`| M2: Semantic Name Jaccard | ${fmt(global.avgSemanticNameJaccard)} | >0.60 | ${statusLabel(global.avgSemanticNameJaccard, 0.60)} |`);
  lines.push(`| M2b: Avg Best-Match Similarity | ${fmt(global.avgBestMatchSim)} | >0.70 | info |`);
  lines.push(`| M3: Domain Distribution JSD | ${fmt(global.avgDomainJSD)} | <0.10 | ${statusLabel(global.avgDomainJSD, 0.10, true)} |`);
  lines.push(`| M4a: Exact Facet Jaccard | ${fmt(global.avgExactFacetJaccard)} | >0.40 | ${statusLabel(global.avgExactFacetJaccard, 0.40)} |`);
  lines.push(`| M4b: Semantic Facet Jaccard | ${fmt(global.avgSemanticFacetJaccard)} | >0.55 | ${statusLabel(global.avgSemanticFacetJaccard, 0.55)} |`);
  lines.push(`| M5: Per-Run Quality | ${fmt(global.avgQuality)} | >0.80 | ${statusLabel(global.avgQuality, 0.80)} |`);
  lines.push('');

  // Per-input detail
  lines.push('## Per-Input Detail');
  lines.push('');

  for (const input of inputs) {
    lines.push(`### ${input.name} (${input.wordCount} words)`);
    const conceptCounts = input.snapshots.map(s => s.concepts.length).join(', ');
    const facetCounts = input.snapshots.map(s => s.concepts.reduce((sum, c) => sum + c.facets.length, 0)).join(', ');
    lines.push(`Concepts per run: ${conceptCounts}`);
    lines.push(`Facets per run: ${facetCounts}`);
    lines.push('');

    lines.push('| Pair | M1 | M2 | M4a | M4b | M3 (JSD) |');
    lines.push('|------|-----|-----|------|------|----------|');
    for (const pm of input.pairMetrics) {
      lines.push(`| ${pm.pairLabel} | ${fmt(pm.exactNameJaccard)} | ${fmt(pm.semanticNameJaccard)} | ${fmt(pm.exactFacetJaccard)} | ${fmt(pm.semanticFacetJaccard)} | ${fmt(pm.domainJSD)} |`);
    }
    lines.push(`Quality per run: ${input.quality.map((q, i) => `Q${i}=${fmt(q.score)}`).join(', ')}`);
    lines.push('');

    // Domain distribution mean ± std
    const domainStats = DOMAINS.map((d, di) => {
      const vals = input.domainDistributions.map(dd => dd[di]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length);
      return `${d}: ${fmt(mean)} +/- ${fmt(std)}`;
    });
    lines.push(`Domain distribution (mean +/- std across ${result.runsPerInput} runs):`);
    lines.push(`  ${domainStats.join(' | ')}`);
    lines.push('');
  }

  // Raw concept names
  lines.push('## Raw Concept Names');
  lines.push('');
  for (const input of inputs) {
    lines.push(`### ${input.name}`);
    for (let r = 0; r < input.snapshots.length; r++) {
      const names = input.snapshots[r].concepts.map(c => c.name).join(', ');
      lines.push(`Run ${r}: ${names}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Main Orchestration ─────────────────────────────────────────────────────

export interface StabilityTestOptions {
  runsPerInput?: number;
}

export async function runStabilityTest(options: StabilityTestOptions = {}): Promise<void> {
  const runsPerInput = options.runsPerInput ?? 3;

  const rootDir = resolve(import.meta.dirname, '..');
  const resultsDir = join(rootDir, 'results-stability');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  console.log('=== Decomposition Stability Test ===');
  console.log(`Runs per input: ${runsPerInput}`);
  console.log('');

  // Initialize dependencies
  const client = new Anthropic();
  const costTracker = new CostTracker(resultsDir, 2.0);
  const ioLogger = new IOLogger(resultsDir);
  const ops = new Operations(client, costTracker, ioLogger);
  const resonance = new EmbeddingResonance();
  await resonance.init();

  // Load inputs
  const inputs: StabilityInput[] = [];

  for (const filename of STANDARD_INPUTS) {
    const filepath = join(rootDir, 'inputs', filename);
    const content = readFileSync(filepath, 'utf-8');
    inputs.push({
      name: filename.replace('.md', ''),
      path: filepath,
      content,
      wordCount: content.split(/\s+/).filter(Boolean).length,
    });
  }

  console.log(`Loaded ${inputs.length} inputs`);
  for (const input of inputs) {
    console.log(`  ${input.name} (${input.wordCount} words)`);
  }
  console.log('');

  // Run decompositions
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const inputResults: InputResult[] = [];
  const rawDecompositions: Array<{ input: string; run: number; result: CrystallizationResult }> = [];
  let totalCalls = 0;
  const totalExpected = inputs.length * runsPerInput;

  for (const input of inputs) {
    console.log(`--- ${input.name} ---`);
    const snapshots: CrystallizationResult[] = [];

    for (let run = 0; run < runsPerInput; run++) {
      totalCalls++;
      console.log(`  Run ${run + 1}/${runsPerInput} (${totalCalls}/${totalExpected} total)...`);

      try {
        costTracker.checkBudget();
        const result = await ops.decomposeCrystallize(input.content, EMPTY_TOPOLOGY_CONTEXT);
        snapshots.push(result);
        rawDecompositions.push({ input: input.name, run, result });

        const conceptNames = result.concepts.map(c => c.name).join(', ');
        const facetCount = result.concepts.reduce((sum, c) => sum + c.facets.length, 0);
        console.log(`    ${result.concepts.length} concepts, ${facetCount} facets: ${conceptNames}`);
      } catch (err: any) {
        console.error(`    FAILED: ${err.message}`);
        // Push a marker for failed run
        snapshots.push({ concepts: [], questions: [] });
        rawDecompositions.push({ input: input.name, run, result: { concepts: [], questions: [] } });
      }

      // Delay between calls (not after last)
      if (run < runsPerInput - 1 || inputs.indexOf(input) < inputs.length - 1) {
        if (totalCalls < totalExpected) {
          await new Promise(r => setTimeout(r, 15000));
        }
      }
    }

    // Filter out failed runs for metric computation
    const validSnapshots = snapshots.filter(s => s.concepts.length > 0);
    const validIndices = snapshots.map((s, i) => s.concepts.length > 0 ? i : -1).filter(i => i >= 0);

    if (validSnapshots.length < 2) {
      console.log(`  Skipping metrics: only ${validSnapshots.length} valid runs`);
      inputResults.push({
        name: input.name,
        wordCount: input.wordCount,
        snapshots,
        pairMetrics: [],
        quality: snapshots.map(s => computeRunQuality(s)),
        avgExactNameJaccard: 0,
        avgSemanticNameJaccard: 0,
        avgBestMatchSim: 0,
        avgDomainJSD: 1,
        avgExactFacetJaccard: 0,
        avgSemanticFacetJaccard: 0,
        avgQuality: snapshots.map(s => computeRunQuality(s)).reduce((sum, q) => sum + q.score, 0) / snapshots.length,
        domainDistributions: snapshots.map(s => domainDistribution(s.concepts)),
        domainStdDevs: new Array(DOMAINS.length).fill(0),
      });
      continue;
    }

    // Compute pairwise metrics for all valid pairs
    console.log('  Computing metrics...');
    const pairs: [number, number][] = [];
    for (let i = 0; i < validIndices.length; i++) {
      for (let j = i + 1; j < validIndices.length; j++) {
        pairs.push([validIndices[i], validIndices[j]]);
      }
    }

    const pairMetrics: PairMetrics[] = [];
    for (const [a, b] of pairs) {
      const pm = await computePairMetrics(
        snapshots[a], snapshots[b], resonance,
        `${a}\u2194${b}`,
      );
      pairMetrics.push(pm);
    }

    const quality = snapshots.map(s => computeRunQuality(s));
    const domainDists = snapshots.map(s => domainDistribution(s.concepts));

    // Domain std devs
    const domainStdDevs = DOMAINS.map((_, di) => {
      const vals = domainDists.map(dd => dd[di]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return Math.sqrt(vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length);
    });

    const inputResult: InputResult = {
      name: input.name,
      wordCount: input.wordCount,
      snapshots,
      pairMetrics,
      quality,
      avgExactNameJaccard: avg(pairMetrics.map(p => p.exactNameJaccard)),
      avgSemanticNameJaccard: avg(pairMetrics.map(p => p.semanticNameJaccard)),
      avgBestMatchSim: avg(pairMetrics.map(p => p.avgBestMatchSim)),
      avgDomainJSD: avg(pairMetrics.map(p => p.domainJSD)),
      avgExactFacetJaccard: avg(pairMetrics.map(p => p.exactFacetJaccard)),
      avgSemanticFacetJaccard: avg(pairMetrics.map(p => p.semanticFacetJaccard)),
      avgQuality: avg(quality.map(q => q.score)),
      domainDistributions: domainDists,
      domainStdDevs,
    };
    inputResults.push(inputResult);

    console.log(`  M1=${fmt(inputResult.avgExactNameJaccard)} M2=${fmt(inputResult.avgSemanticNameJaccard)} M3=${fmt(inputResult.avgDomainJSD)} M4b=${fmt(inputResult.avgSemanticFacetJaccard)} Q=${fmt(inputResult.avgQuality)}`);
    console.log(`  Cost so far: $${costTracker.totalCost.toFixed(4)}`);
    console.log('');
  }

  // Compute global results
  const global: GlobalResult = {
    avgExactNameJaccard: avg(inputResults.map(i => i.avgExactNameJaccard)),
    avgSemanticNameJaccard: avg(inputResults.map(i => i.avgSemanticNameJaccard)),
    avgBestMatchSim: avg(inputResults.map(i => i.avgBestMatchSim)),
    avgDomainJSD: avg(inputResults.map(i => i.avgDomainJSD)),
    avgExactFacetJaccard: avg(inputResults.map(i => i.avgExactFacetJaccard)),
    avgSemanticFacetJaccard: avg(inputResults.map(i => i.avgSemanticFacetJaccard)),
    avgQuality: avg(inputResults.map(i => i.avgQuality)),
  };

  const verdict = determineVerdict(global);

  console.log('=== RESULTS ===');
  console.log(`Verdict: ${verdict.verdict}`);
  console.log(verdict.reason);
  console.log('');
  console.log(`M1 (Exact Name):     ${fmt(global.avgExactNameJaccard)}`);
  console.log(`M2 (Semantic Name):  ${fmt(global.avgSemanticNameJaccard)}`);
  console.log(`M2b (Avg Best Match): ${fmt(global.avgBestMatchSim)}`);
  console.log(`M3 (Domain JSD):     ${fmt(global.avgDomainJSD)}`);
  console.log(`M4a (Exact Facet):   ${fmt(global.avgExactFacetJaccard)}`);
  console.log(`M4b (Semantic Facet): ${fmt(global.avgSemanticFacetJaccard)}`);
  console.log(`M5 (Quality):        ${fmt(global.avgQuality)}`);
  console.log(`Total cost: $${costTracker.totalCost.toFixed(4)}`);

  // Self-verification checks
  console.log('');
  console.log('Self-verification:');
  let verifyPass = true;
  for (const input of inputResults) {
    for (const pm of input.pairMetrics) {
      if (pm.semanticNameJaccard < pm.exactNameJaccard - 0.05) {
        console.log(`  WARN: ${input.name} ${pm.pairLabel}: semantic (${fmt(pm.semanticNameJaccard)}) < exact (${fmt(pm.exactNameJaccard)}) - 0.05`);
        verifyPass = false;
      }
    }
  }
  if (verifyPass) {
    console.log('  All checks passed (semantic >= exact - 0.05 for all pairs)');
  }

  // Build result object (strip snapshots from serialization to keep file sizes reasonable)
  const resultObj: StabilityResult = {
    timestamp: new Date().toISOString(),
    inputCount: inputs.length,
    runsPerInput,
    totalCost: costTracker.totalCost,
    verdict,
    global,
    inputs: inputResults.map(ir => ({
      ...ir,
      snapshots: ir.snapshots, // keep for report but raw-decompositions.json has full detail
    })),
  };

  // Save outputs
  writeFileSync(
    join(resultsDir, 'stability-results.json'),
    JSON.stringify(resultObj, null, 2),
  );

  writeFileSync(
    join(resultsDir, 'raw-decompositions.json'),
    JSON.stringify(rawDecompositions, null, 2),
  );

  const report = generateReport(resultObj);
  writeFileSync(join(resultsDir, 'stability-report.md'), report);

  console.log('');
  console.log(`Results saved to ${resultsDir}/`);
  console.log('  stability-results.json  (structured data)');
  console.log('  stability-report.md     (human-readable report)');
  console.log('  raw-decompositions.json (all decomposition outputs)');
  console.log('  io-log.jsonl            (API call log)');
}

// Direct execution support
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const runs = parseInt(args.find(a => a.startsWith('--runs='))?.split('=')[1] ?? '3', 10);
  runStabilityTest({ runsPerInput: runs }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
