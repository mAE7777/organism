import type {
  TopologyState, PathScore, RearrangementScore, Contradiction,
  NetworkMetrics, TopologyQuestion, Facet,
} from './types.js';
import { giniCoefficient, computeBetweennessCentrality, computeNetworkMetrics } from './graph-metrics.js';
import type { Operations, DecomposeResult } from './operations.js';

// Layer 1 (Structural) — Tests A, G

export function testA_hubGravity(topology: TopologyState): { gini: number; pass: boolean } {
  const centrality = computeBetweennessCentrality(topology);
  const values = Object.values(centrality);
  const gini = giniCoefficient(values);
  return { gini, pass: gini < 0.5 };
}

export function testG_networkTransition(topology: TopologyState): { metrics: NetworkMetrics; pass: boolean } {
  const metrics = computeNetworkMetrics(topology);
  return { metrics, pass: metrics.top3PathShare < 0.40 };
}

// Layer 2 (Semantic) — Tests B, F, I

export function testB_semanticEmergence(pathScores: PathScore[]): { avgComposite: number; pass: boolean } {
  if (pathScores.length === 0) return { avgComposite: 0, pass: false };
  const avg = pathScores.reduce((s, p) => s + p.compositeScore, 0) / pathScores.length;
  return { avgComposite: avg, pass: avg > 3.0 };
}

export function testF_contradictions(contradictions: Contradiction[]): { count: number; pass: boolean } {
  return { count: contradictions.length, pass: contradictions.length > 0 };
}

export function testI_rearrangementQuality(scores: RearrangementScore[]): { avgGenuine: number; pass: boolean } {
  if (scores.length === 0) return { avgGenuine: 0, pass: false };
  const avg = scores.reduce((s, r) => s + r.genuine, 0) / scores.length;
  return { avgGenuine: avg, pass: avg > 3.0 };
}

// Layer 3 (Cognitive) — Tests D, K

export interface DriftResult {
  jaccardRun1: number;
  jaccardRun25: number;
  d1Facets: Facet[];
  d2Facets: Facet[];
  d3Facets: Facet[];
  identityEffect: boolean;
  pass: boolean;
}

function facetSetJaccard(a: Facet[], b: Facet[]): number {
  const setA = new Set(a.map(f => `${f.domain.toLowerCase()}:${f.attribute.toLowerCase()}`));
  const setB = new Set(b.map(f => `${f.domain.toLowerCase()}:${f.attribute.toLowerCase()}`));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

export async function testD_decomposeDrift(
  inputText: string,
  ops: Operations,
  identityContext?: string,
): Promise<{ facets: Facet[]; concepts: string[] }> {
  const result = await ops.decompose(inputText, identityContext);
  const allFacets = result.concepts.flatMap(c => c.facets);
  return { facets: allFacets, concepts: result.concepts.map(c => c.name) };
}

export function testD_compareDrift(
  d1Facets: Facet[],
  d2Facets: Facet[],
  d3Facets: Facet[],
): DriftResult {
  const jaccardD1D2 = facetSetJaccard(d1Facets, d2Facets);
  const jaccardD2D3 = facetSetJaccard(d2Facets, d3Facets);

  // D2 vs D3: if significantly different, identity loop works
  const identityEffect = Math.abs(jaccardD2D3 - 1.0) > 0.15;

  return {
    jaccardRun1: jaccardD1D2,
    jaccardRun25: jaccardD2D3,
    d1Facets,
    d2Facets,
    d3Facets,
    identityEffect,
    pass: jaccardD1D2 < 0.5,
  };
}

export function testK_autopoietic(
  withSignal: DecomposeResult,
  withoutSignal: DecomposeResult,
): { jaccardDiff: number; pass: boolean } {
  const withFacets = withSignal.concepts.flatMap(c => c.facets);
  const withoutFacets = withoutSignal.concepts.flatMap(c => c.facets);
  const jaccard = facetSetJaccard(withFacets, withoutFacets);
  const diff = 1 - jaccard; // higher diff = more influence from signal
  return { jaccardDiff: diff, pass: diff > 0.15 };
}

// Meta — Tests C, E, H, J

export function testC_resolutionGrowth(history: number[]): { trend: 'increasing' | 'flat' | 'decreasing'; pass: boolean } {
  if (history.length < 3) return { trend: 'flat', pass: false };

  // Simple linear regression slope
  const n = history.length;
  const xMean = (n - 1) / 2;
  const yMean = history.reduce((s, v) => s + v, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (history[i] - yMean);
    denominator += (i - xMean) * (i - xMean);
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;

  const trend = slope > 0.01 ? 'increasing' : slope < -0.01 ? 'decreasing' : 'flat';
  return { trend, pass: trend === 'increasing' };
}

export function testE_questionLifecycle(questions: TopologyQuestion[]): { resolutionRate: number; pass: boolean } {
  if (questions.length === 0) return { resolutionRate: 0, pass: false };
  const resolved = questions.filter(q => q.status === 'addressed' || q.status === 'dissolved').length;
  const rate = resolved / questions.length;
  return { resolutionRate: rate, pass: rate > 0.10 };
}

export function testH_humanValidation(): { protocol: string } {
  return {
    protocol: `Human Validation Protocol (Test H):
1. Read the TopologySignal for run 50
2. For each bridge concept: rate 1-5 whether the bridge is meaningful
3. For each emergent path (top 5): rate 1-5 whether the connection makes sense
4. For the delta section: rate 1-5 whether the changes reflect genuine learning
5. Overall: rate 1-5 whether the topology "understands" the input corpus
6. Average all scores. Pass if average > 3.5`,
  };
}

export function testJ_scaleSimulation(): { protocol: string } {
  return {
    protocol: `Scale Simulation Protocol (Test J):
1. Select 5 queries from L2_QUERIES list
2. For each query:
   a. Get TopologySignal for current state
   b. Generate answer using queryWithDirectives (signal + LM)
   c. Generate answer using flat baseline
   d. Have Haiku judge both (blind, randomized order)
3. Topology must win 3/5 for pass
4. Record: query, signal used, topology answer, baseline answer, judge result`,
  };
}

// All results

export interface AllTestResults {
  A: { gini: number; pass: boolean };
  B: { avgComposite: number; pass: boolean };
  C: { trend: string; pass: boolean };
  D: DriftResult | null;
  E: { resolutionRate: number; pass: boolean };
  F: { count: number; pass: boolean };
  G: { metrics: NetworkMetrics; pass: boolean };
  H: { protocol: string };
  I: { avgGenuine: number; pass: boolean };
  J: { protocol: string };
  K: { jaccardDiff: number; pass: boolean } | null;
  summary: {
    mustPass: { B: boolean; G: boolean; D: boolean };
    shouldPass: { A: boolean; C: boolean; E: boolean; I: boolean };
    niceToHave: { F: boolean; H: boolean; K: boolean };
    overallVerdict: string;
  };
}

export function computeVerdict(results: AllTestResults): string {
  const mustPassAll = results.summary.mustPass.B && results.summary.mustPass.G && results.summary.mustPass.D;
  const shouldPassCount = Object.values(results.summary.shouldPass).filter(Boolean).length;

  if (mustPassAll && shouldPassCount >= 3) {
    return 'THESIS SUPPORTED — L3 demonstrates sense-making infrastructure';
  } else if (mustPassAll) {
    return 'PARTIAL — must-pass tests pass but should-pass criteria incomplete';
  } else {
    const failed = [];
    if (!results.summary.mustPass.B) failed.push('B (semantic emergence)');
    if (!results.summary.mustPass.G) failed.push('G (network shape)');
    if (!results.summary.mustPass.D) failed.push('D (decompose drift)');
    return `THESIS NOT VALIDATED — failed: ${failed.join(', ')}`;
  }
}
