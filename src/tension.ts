/**
 * tension.ts: structural tension report over a saved topology.
 *
 * Two cited computations over a saved concept topology. Both run in code over
 * the whole graph and the whole run history. Neither asks a model to judge text.
 *
 *   A. Forman-Ricci curvature over the concept graph.
 *      Locates edges and concepts under structural tension (bridges /
 *      bottlenecks show the most-negative curvature).
 *      Ref: R. Sreejith, K. Mohanraj, J. Jost, E. Saucan, A. Samal,
 *      "Forman curvature for complex networks", J. Stat. Mech. (2016) 063206.
 *      (Discrete Forman-Ricci curvature for weighted graphs.)
 *
 *   B. Critical-slowing-down early-warning signals over the run history.
 *      Detects, across the sequence of runs, whether a metric series is
 *      approaching a structural (bifurcation-type) transition: rising variance
 *      AND rising lag-1 autocorrelation are the signature of critical slowing
 *      down.
 *      Refs: M. Scheffer et al., "Early-warning signals for critical
 *      transitions", Nature 461 (2009) 53-59;
 *      V. Dakos et al., "Methods for detecting early warnings of critical
 *      transitions in time series", PLoS ONE 7(7) (2012) e41010.
 *
 * The analysis functions only read saved state. Run from the command line, the
 * module also writes tension-report.json into the topology folder it read.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Concept, Chain, TopologyState, TopologySignal } from './types.js';
import { giniCoefficient, computeBetweennessCentrality } from './graph-metrics.js';

// ---------------------------------------------------------------------------
// A. Forman-Ricci curvature
// ---------------------------------------------------------------------------

export interface CurvatureEdge {
  from: string;
  to: string;
  weight: number;
  curvature: number;
}

export interface ConceptTension {
  concept: string;
  tension: number; // mean curvature of incident edges (more negative = more tension)
  degree: number;
}

export interface CurvatureDistribution {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  fracNegative: number;
}

export interface FormanRicciResult {
  edges: CurvatureEdge[]; // ascending by curvature (most negative first)
  conceptTension: ConceptTension[]; // ascending by tension (most tension first)
  distribution: CurvatureDistribution;
}

export interface FormanRicciOptions {
  /** Node weight scheme. 'unit' => w_node = 1 (combinatorial); 'strength' => sum of incident edge weights. */
  nodeWeight?: 'unit' | 'strength';
}

interface WeightedEdge {
  u: string;
  v: string;
  key: string;
  w: number;
}

/**
 * Compute per-edge Forman-Ricci curvature over the concept graph. Chains are
 * treated as weighted undirected edges; multiple chains between the same pair
 * of concepts are aggregated (their weights summed).
 *
 * Weighted Forman-Ricci curvature (Sreejith et al. 2016), for edge e=(u,v):
 *
 *   F(e) = w_e * ( w_u/w_e + w_v/w_e
 *                  - sum_{e_u ~ u, e_u != e} w_u / sqrt(w_e * w_{e_u})
 *                  - sum_{e_v ~ v, e_v != e} w_v / sqrt(w_e * w_{e_v}) )
 *
 * where w_e is the edge weight and w_u, w_v are node weights. With unit node
 * weights and unit edge weights this reduces to the combinatorial Forman
 * curvature F(e) = 4 - deg(u) - deg(v): highly connected endpoints (hubs /
 * bridges spanning otherwise separate regions) give large negative curvature.
 */
export function formanRicci(
  concepts: Concept[],
  chains: Chain[],
  options: FormanRicciOptions = {},
): FormanRicciResult {
  const nodeWeightScheme = options.nodeWeight ?? 'unit';

  // Aggregate chains into weighted undirected edges keyed by the unordered pair.
  const edgeMap = new Map<string, WeightedEdge>();
  const nodes = new Set<string>();
  for (const c of concepts) nodes.add(c.name.toLowerCase());

  for (const ch of chains) {
    const a = ch.fromConcept.toLowerCase();
    const b = ch.toConcept.toLowerCase();
    if (a === b) continue; // no self-loops
    nodes.add(a);
    nodes.add(b);
    const [u, v] = a < b ? [a, b] : [b, a];
    const key = `${u}|${v}`;
    // Weight: aggregate (sum) the chain weights of parallel chains. Guard
    // against zero/negative weights so the sqrt terms stay well-defined.
    const w = Math.max(1e-9, ch.weight);
    const existing = edgeMap.get(key);
    if (existing) existing.w += w;
    else edgeMap.set(key, { u, v, key, w });
  }

  const edges = [...edgeMap.values()];

  // Incidence: node -> list of incident edges.
  const incident = new Map<string, WeightedEdge[]>();
  for (const n of nodes) incident.set(n, []);
  for (const e of edges) {
    incident.get(e.u)!.push(e);
    incident.get(e.v)!.push(e);
  }

  // Node weights.
  const nodeWeight = new Map<string, number>();
  for (const n of nodes) {
    if (nodeWeightScheme === 'strength') {
      const s = (incident.get(n) ?? []).reduce((acc, e) => acc + e.w, 0);
      nodeWeight.set(n, Math.max(1e-9, s));
    } else {
      nodeWeight.set(n, 1);
    }
  }

  // Per-edge curvature.
  const curvatureEdges: CurvatureEdge[] = edges.map((e) => {
    const we = e.w;
    const wu = nodeWeight.get(e.u)!;
    const wv = nodeWeight.get(e.v)!;

    let sumU = 0;
    for (const eu of incident.get(e.u)!) {
      if (eu.key === e.key) continue;
      sumU += wu / Math.sqrt(we * eu.w);
    }
    let sumV = 0;
    for (const ev of incident.get(e.v)!) {
      if (ev.key === e.key) continue;
      sumV += wv / Math.sqrt(we * ev.w);
    }

    const curvature = we * (wu / we + wv / we - sumU - sumV);
    return { from: e.u, to: e.v, weight: we, curvature };
  });

  curvatureEdges.sort((a, b) => a.curvature - b.curvature);

  // Per-concept tension: mean curvature of incident edges.
  const conceptTension: ConceptTension[] = [];
  for (const n of nodes) {
    const inc = incident.get(n) ?? [];
    if (inc.length === 0) continue; // isolated concept: no tension defined
    const curvByKey = new Map(curvatureEdges.map((ce) => [`${ce.from}|${ce.to}`, ce.curvature]));
    let sum = 0;
    for (const e of inc) sum += curvByKey.get(e.key) ?? 0;
    conceptTension.push({ concept: n, tension: sum / inc.length, degree: inc.length });
  }
  conceptTension.sort((a, b) => a.tension - b.tension);

  // Distribution summary.
  const vals = curvatureEdges.map((e) => e.curvature);
  const distribution: CurvatureDistribution = {
    count: vals.length,
    min: vals.length ? vals[0] : 0,
    max: vals.length ? vals[vals.length - 1] : 0,
    mean: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0,
    median: median(vals),
    fracNegative: vals.length ? vals.filter((v) => v < 0).length / vals.length : 0,
  };

  return { edges: curvatureEdges, conceptTension, distribution };
}

// ---------------------------------------------------------------------------
// B. Critical-slowing-down early-warning signals
// ---------------------------------------------------------------------------

export interface MetricWarning {
  metric: string;
  available: boolean;
  note?: string;
  n?: number;
  window?: number;
  nWindows?: number;
  tauVariance?: number;
  tauAutocorr?: number;
  pVariance?: number; // one-sided surrogate p-value for a rising trend
  pAutocorr?: number;
  varianceRisingSignificant?: boolean;
  autocorrRisingSignificant?: boolean;
}

export interface EarlyWarningResult {
  perMetric: MetricWarning[];
  compositeProximity: number; // in [0,1]: fraction of indicators with significantly-positive tau
  indicatorsTotal: number;
  indicatorsSignificant: number;
  caveat: string;
}

export interface EarlyWarningOptions {
  /** Rolling window length. Default: half the series length (Dakos et al. 2012 convention). */
  window?: number;
  /** Detrend each series (least-squares linear) before computing rolling stats. Default true. */
  detrend?: boolean;
  /** One-sided significance level for a rising trend. Default 0.05. */
  alpha?: number;
  /**
   * Number of permutation surrogates used to assess the significance of each
   * indicator's trend. Default 1000. Overlapping rolling windows make the
   * indicator series strongly autocorrelated, so the analytic Kendall z-test is
   * invalid (it flags even white noise). Dakos et al. 2012 therefore assess the
   * trend against a null built from surrogate series; here each surrogate is a
   * random reshuffle of the detrended residuals (a stationary null with the same
   * marginal distribution but no temporal ordering).
   */
  surrogates?: number;
  /** Fixed PRNG seed so the surrogate test is fully deterministic. */
  seed?: number;
}

const CSD_CAVEAT =
  'Critical slowing down (rising variance + rising lag-1 autocorrelation) detects ' +
  'GRADUAL, bifurcation-type transitions where the system loses resilience as it ' +
  'approaches a tipping point. It does NOT anticipate abrupt shocks, externally ' +
  'imposed jumps, or noise-induced transitions far from the bifurcation. Significance ' +
  'is assessed against reshuffled-residual surrogates (not the analytic z-test, which ' +
  'is invalid for overlapping windows). A high proximity score is evidence of ' +
  'approach, not a dated prediction.';

/**
 * Early-warning signals for critical transitions. For each time-ordered metric
 * series it computes, over a rolling window, (1) the variance and (2) the lag-1
 * autocorrelation, then measures the monotonic trend of each indicator across
 * the run sequence with the Kendall rank correlation (tau). Simultaneously
 * rising variance and rising autocorrelation is the critical-slowing-down
 * signature of an approaching transition (Scheffer et al. 2009; Dakos et al.
 * 2012). The composite proximity score is the fraction of indicators whose
 * upward trend is statistically significant.
 */
export function earlyWarning(
  series: Record<string, number[]>,
  options: EarlyWarningOptions = {},
): EarlyWarningResult {
  const detrend = options.detrend ?? true;
  const alpha = options.alpha ?? 0.05;
  const nSurrogates = options.surrogates ?? 1000;

  const perMetric: MetricWarning[] = [];
  let indicatorsTotal = 0;
  let indicatorsSignificant = 0;

  // Compute the two CSD indicator trend statistics (Kendall tau of rolling
  // variance and of rolling lag-1 autocorrelation) for a given working series.
  const trendStats = (work: number[], window: number, n: number) => {
    const varSeries: number[] = [];
    const acSeries: number[] = [];
    for (let start = 0; start + window <= n; start++) {
      const w = work.slice(start, start + window);
      varSeries.push(sampleVariance(w));
      acSeries.push(lag1Autocorr(w));
    }
    return { tauVar: kendallTauTrend(varSeries).tau, tauAc: kendallTauTrend(acSeries).tau };
  };

  let metricIndex = 0;
  for (const [metric, rawSeries] of Object.entries(series)) {
    metricIndex++;
    const n = rawSeries.length;
    // Need enough points for a rolling window with several placements.
    if (n < 8) {
      perMetric.push({ metric, available: false, n, note: 'series too short (<8 runs)' });
      continue;
    }
    if (isConstant(rawSeries)) {
      perMetric.push({ metric, available: false, n, note: 'series is constant (no variability)' });
      continue;
    }

    const requested = options.window ?? Math.floor(n / 2);
    // Keep the window large enough to estimate autocorrelation and small enough
    // to leave >= 5 window placements for a meaningful trend test.
    const window = clamp(requested, 4, Math.max(4, n - 4));
    const nWindows = n - window + 1;
    if (nWindows < 5) {
      perMetric.push({ metric, available: false, n, window, note: 'too few rolling windows (<5)' });
      continue;
    }

    const work = detrend ? linearDetrend(rawSeries) : rawSeries.slice();
    const observed = trendStats(work, window, n);

    // Surrogate null: reshuffle the (detrended) residuals to destroy any
    // temporal ordering while preserving the marginal distribution, then
    // recompute the same indicator trends. p = fraction of surrogates whose
    // trend is >= the observed one (one-sided, rising). Deterministic PRNG.
    const rng = mulberry32(((options.seed ?? 0x9e3779b9) ^ (metricIndex * 0x85ebca6b)) >>> 0);
    let geVar = 0;
    let geAc = 0;
    for (let s = 0; s < nSurrogates; s++) {
      const surr = shuffle(work, rng);
      const st = trendStats(surr, window, n);
      if (st.tauVar >= observed.tauVar) geVar++;
      if (st.tauAc >= observed.tauAc) geAc++;
    }
    const pVar = (geVar + 1) / (nSurrogates + 1);
    const pAc = (geAc + 1) / (nSurrogates + 1);

    const varSig = observed.tauVar > 0 && pVar < alpha;
    const acSig = observed.tauAc > 0 && pAc < alpha;

    indicatorsTotal += 2;
    if (varSig) indicatorsSignificant++;
    if (acSig) indicatorsSignificant++;

    perMetric.push({
      metric,
      available: true,
      n,
      window,
      nWindows,
      tauVariance: observed.tauVar,
      tauAutocorr: observed.tauAc,
      pVariance: pVar,
      pAutocorr: pAc,
      varianceRisingSignificant: varSig,
      autocorrRisingSignificant: acSig,
    });
  }

  const compositeProximity = indicatorsTotal > 0 ? indicatorsSignificant / indicatorsTotal : 0;

  return {
    perMetric,
    compositeProximity,
    indicatorsTotal,
    indicatorsSignificant,
    caveat: CSD_CAVEAT,
  };
}

// ---------------------------------------------------------------------------
// C. tensionReport: load a saved topology, compute both layers, report.
// ---------------------------------------------------------------------------

export interface TensionReport {
  topologyDir: string;
  generatedAt: string;
  graph: {
    conceptCount: number;
    chainCount: number;
    edgeCount: number;
    runCount: number;
  };
  curvature: {
    distribution: CurvatureDistribution;
    topTensionEdges: Array<CurvatureEdge & { fromName: string; toName: string }>;
    topTensionConcepts: Array<ConceptTension & { name: string; betweenness: number }>;
  };
  earlyWarning: EarlyWarningResult & {
    seriesUsed: Record<string, number[]>;
    skippedMetrics: Array<{ metric: string; reason: string }>;
  };
}

/** Metrics that are only defined on a full graph snapshot, so they cannot be
 * computed per run from the saved signal history. */
const NOT_AVAILABLE_PER_RUN: Array<{ metric: string; reason: string }> = [
  {
    metric: 'meanCurvature',
    reason: 'Forman-Ricci curvature needs the full concept+chain graph at each run; ' +
      'the run history stores only emitted signals, not per-run graph snapshots.',
  },
  {
    metric: 'algebraicConnectivity',
    reason: 'The Fiedler value needs the full Laplacian spectrum at each run; ' +
      'per-run graph snapshots are not stored and no eigensolver is bundled.',
  },
];

/**
 * Assemble the time-ordered per-run metric series from a saved run history.
 * Every value is derived from the emitted TopologySignal for that run.
 */
export function assembleSeries(signals: TopologySignal[]): Record<string, number[]> {
  const ordered = [...signals].sort((a, b) => (a.runNumber ?? 0) - (b.runNumber ?? 0));

  const meanChainWeight: number[] = []; // proxy: mean weight of emitted emergent paths
  const bridgeHGI: number[] = []; // Gini of bridge scores = hub-gravity concentration
  const bridgeCount: number[] = []; // number of reported bridges (capped at 10 upstream)
  const meanBridgeScore: number[] = [];
  const density: number[] = []; // chains / concepts
  const facetCount: number[] = [];
  const openQuestions: number[] = [];
  const bridgeTurnover: number[] = []; // new + lost bridges this run

  for (const s of ordered) {
    const bridges = s.bridges ?? [];
    const scores = bridges.map((b) => b.score);
    const paths = s.emergentPaths ?? [];
    meanChainWeight.push(paths.length ? paths.reduce((a, p) => a + (p.weight ?? 0), 0) / paths.length : 0);
    bridgeHGI.push(giniCoefficient(scores));
    bridgeCount.push(bridges.length);
    meanBridgeScore.push(scores.length ? scores.reduce((a, v) => a + v, 0) / scores.length : 0);
    density.push(s.uncertaintyProfile?.density ?? 0);
    facetCount.push(s.uncertaintyProfile?.facetCount ?? 0);
    openQuestions.push((s.openQuestions ?? []).length);
    const d = s.delta;
    bridgeTurnover.push((d?.newBridges?.length ?? 0) + (d?.lostBridges?.length ?? 0));
  }

  return {
    meanChainWeight,
    bridgeHGI,
    bridgeCount,
    meanBridgeScore,
    density,
    facetCount,
    openQuestions,
    bridgeTurnover,
  };
}

export function tensionReport(topologyDir: string): TensionReport {
  const state: TopologyState = JSON.parse(readFileSync(join(topologyDir, 'state.json'), 'utf-8'));
  const concepts = state.concepts ?? [];
  const chains = state.chains ?? [];

  // A. curvature field on the final graph.
  const ricci = formanRicci(concepts, chains);
  const betweenness = computeBetweennessCentrality({
    concepts,
    chains,
    latentConnections: [],
    runCount: state.runCount ?? 0,
  });
  const nameByLower = new Map(concepts.map((c) => [c.name.toLowerCase(), c.name]));
  const displayName = (lower: string) => nameByLower.get(lower) ?? lower;

  const topTensionEdges = ricci.edges.slice(0, 10).map((e) => ({
    ...e,
    fromName: displayName(e.from),
    toName: displayName(e.to),
  }));
  const topTensionConcepts = ricci.conceptTension.slice(0, 10).map((c) => ({
    ...c,
    name: displayName(c.concept),
    betweenness: betweenness[c.concept] ?? 0,
  }));

  // B. CSD trajectory over the run history.
  let signals: TopologySignal[] = [];
  try {
    const history = JSON.parse(readFileSync(join(topologyDir, 'history.json'), 'utf-8'));
    signals = Array.isArray(history?.signals) ? history.signals : [];
  } catch {
    signals = [];
  }
  const series = assembleSeries(signals);
  const ew = earlyWarning(series);

  return {
    topologyDir,
    generatedAt: new Date().toISOString(),
    graph: {
      conceptCount: concepts.length,
      chainCount: chains.length,
      edgeCount: ricci.edges.length,
      runCount: state.runCount ?? signals.length,
    },
    curvature: {
      distribution: ricci.distribution,
      topTensionEdges,
      topTensionConcepts,
    },
    earlyWarning: {
      ...ew,
      seriesUsed: series,
      skippedMetrics: NOT_AVAILABLE_PER_RUN,
    },
  };
}

// ---------------------------------------------------------------------------
// Small numeric helpers (deterministic, dependency-free).
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function isConstant(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i] !== values[0]) return false;
  return true;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function sampleVariance(w: number[]): number {
  const n = w.length;
  if (n < 2) return 0;
  const mean = w.reduce((s, v) => s + v, 0) / n;
  let acc = 0;
  for (const v of w) acc += (v - mean) * (v - mean);
  return acc / (n - 1);
}

function lag1Autocorr(w: number[]): number {
  const n = w.length;
  if (n < 2) return 0;
  const mean = w.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) den += (w[i] - mean) * (w[i] - mean);
  for (let i = 0; i < n - 1; i++) num += (w[i] - mean) * (w[i + 1] - mean);
  if (den === 0) return 0;
  return num / den;
}

/** Least-squares linear detrend: subtract the fitted line, return residuals. */
function linearDetrend(y: number[]): number[] {
  const n = y.length;
  const xMean = (n - 1) / 2;
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - xMean) * (y[i] - yMean);
    sxx += (i - xMean) * (i - xMean);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = yMean - slope * xMean;
  return y.map((v, i) => v - (intercept + slope * i));
}

/**
 * Kendall rank correlation (tau-b) of a series against its own time index
 * (x = 0,1,2,... has no ties), plus the normal-approximation z-statistic with
 * the standard tie correction for ties in y. Positive tau = rising trend.
 */
export function kendallTauTrend(y: number[]): { tau: number; z: number; n: number } {
  const n = y.length;
  if (n < 3) return { tau: 0, z: 0, n };

  let S = 0; // concordant - discordant (x always increasing, so sign = sign(y_j - y_i))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      S += Math.sign(y[j] - y[i]);
    }
  }

  // Tie groups in y (for tau-b denominator and variance correction).
  const counts = new Map<number, number>();
  for (const v of y) counts.set(v, (counts.get(v) ?? 0) + 1);
  let n1 = 0; // sum t(t-1)/2 over y-tie groups
  let tieTerm = 0; // sum t(t-1)(2t+5)
  for (const t of counts.values()) {
    if (t > 1) {
      n1 += (t * (t - 1)) / 2;
      tieTerm += t * (t - 1) * (2 * t + 5);
    }
  }
  const n0 = (n * (n - 1)) / 2;
  // x has no ties (n2 = 0), so tau-b denominator is sqrt((n0 - n1) * n0).
  const denom = Math.sqrt((n0 - n1) * n0);
  const tau = denom === 0 ? 0 : S / denom;

  // Variance of S under the null (Kendall), with y-tie correction; x untied.
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  const z = varS <= 0 ? 0 : S / Math.sqrt(varS);

  return { tau, z, n };
}

/** Deterministic PRNG (mulberry32) for the surrogate significance test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle returning a new array (input untouched). */
function shuffle(arr: number[], rng: () => number): number[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI: npx tsx src/tension.ts <topologyDir>
// ---------------------------------------------------------------------------

function fmt(x: number, d = 3): string {
  return Number.isFinite(x) ? x.toFixed(d) : String(x);
}

export function printReport(report: TensionReport): void {
  const L: string[] = [];
  L.push('='.repeat(72));
  L.push('  STRUCTURAL TENSION LAYER');
  L.push(`  topology: ${report.topologyDir}`);
  L.push(`  generated: ${report.generatedAt}`);
  L.push('='.repeat(72));
  L.push('');
  L.push(`Graph: ${report.graph.conceptCount} concepts, ${report.graph.chainCount} chains ` +
    `-> ${report.graph.edgeCount} undirected edges, ${report.graph.runCount} runs`);
  L.push('');

  // A. curvature
  const d = report.curvature.distribution;
  L.push('--- A. FORMAN-RICCI CURVATURE (Sreejith et al. 2016) ---');
  L.push(`  distribution: min=${fmt(d.min)}  median=${fmt(d.median)}  mean=${fmt(d.mean)}  ` +
    `max=${fmt(d.max)}  fracNegative=${fmt(d.fracNegative)}  (n=${d.count} edges)`);
  L.push('  most-negative curvature = bridges / bottlenecks under structural tension');
  L.push('');
  L.push('  Top-10 tension EDGES (most negative curvature):');
  report.curvature.topTensionEdges.forEach((e, i) => {
    L.push(`   ${String(i + 1).padStart(2)}. ${fmt(e.curvature, 2).padStart(9)}  ` +
      `[w=${fmt(e.weight, 2)}]  ${e.fromName}  <->  ${e.toName}`);
  });
  L.push('');
  L.push('  Top-10 tension CONCEPTS (most negative mean incident curvature):');
  report.curvature.topTensionConcepts.forEach((c, i) => {
    L.push(`   ${String(i + 1).padStart(2)}. ${fmt(c.tension, 2).padStart(9)}  ` +
      `[deg=${String(c.degree).padStart(3)}, betweenness=${fmt(c.betweenness, 1)}]  ${c.name}`);
  });
  L.push('');

  // B. early warning
  L.push('--- B. CRITICAL-SLOWING-DOWN EARLY WARNING (Scheffer 2009; Dakos 2012) ---');
  L.push('  per-metric Kendall-tau trend of rolling variance and lag-1 autocorrelation');
  L.push('  (rising BOTH = approaching a bifurcation-type transition)');
  L.push('');
  L.push('   metric            n  win   tau(var) p(var)   tau(ac)  p(ac)    sig');
  for (const m of report.earlyWarning.perMetric) {
    if (!m.available) {
      L.push(`   ${m.metric.padEnd(16)}  ${String(m.n ?? '-').padStart(2)}   --   unavailable: ${m.note}`);
      continue;
    }
    const sig = `${m.varianceRisingSignificant ? 'V' : '-'}${m.autocorrRisingSignificant ? 'A' : '-'}`;
    L.push(`   ${m.metric.padEnd(16)}  ${String(m.n).padStart(2)}  ${String(m.window).padStart(3)}   ` +
      `${fmt(m.tauVariance!, 3).padStart(7)} ${fmt(m.pVariance!, 3).padStart(6)}  ` +
      `${fmt(m.tauAutocorr!, 3).padStart(7)} ${fmt(m.pAutocorr!, 3).padStart(6)}   ${sig}`);
  }
  L.push('');
  for (const s of report.earlyWarning.skippedMetrics) {
    L.push(`   (${s.metric} not available per-run: ${s.reason})`);
  }
  L.push('');
  L.push(`  COMPOSITE PROXIMITY-TO-TRANSITION: ${fmt(report.earlyWarning.compositeProximity, 3)}  ` +
    `(${report.earlyWarning.indicatorsSignificant}/${report.earlyWarning.indicatorsTotal} indicators rising significantly)`);
  L.push('');
  L.push('  Caveat: ' + report.earlyWarning.caveat);
  L.push('='.repeat(72));

  console.log(L.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: npx tsx src/tension.ts <topologyDir>');
    process.exit(1);
  }
  const report = tensionReport(dir);
  printReport(report);
  const outPath = join(dir, 'tension-report.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written: ${outPath}`);
}
