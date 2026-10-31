import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { TopologyStore } from './topology.js';
import { MetadataStore } from './metadata.js';
import { Operations } from './operations.js';
import { CostTracker } from './cost.js';
import { evaluatePathSemantic, evaluateRearrangement, findContradictions } from './evaluator.js';
import { discoverEmergentPaths } from './traversal.js';
import { detectRearrangements } from './analysis.js';
import { computeNetworkMetrics, giniCoefficient, computeBetweennessCentrality } from './graph-metrics.js';
import {
  testA_hubGravity, testB_semanticEmergence, testC_resolutionGrowth,
  testD_decomposeDrift, testD_compareDrift,
  testE_questionLifecycle, testF_contradictions, testG_networkTransition,
  testH_humanValidation, testI_rearrangementQuality, testJ_scaleSimulation,
  testK_autopoietic, computeVerdict,
  type AllTestResults,
} from './test-suite.js';
import { EnrichedBaseline } from './baseline.js';
import { Judge } from './judge.js';
import type { Circuit } from './circuit.js';
import type { PathScore, RearrangementScore, Contradiction, NetworkMetrics, TopologyQuestion, Facet } from './types.js';

export interface PerInputMetrics {
  run: number;
  hgi: number;
  resolution: number;
  networkMetrics: NetworkMetrics;
}

export interface PeriodicResults {
  run: number;
  semanticScores: PathScore[];
  contradictions: Contradiction[];
  questionStats: { total: number; addressed: number; dissolved: number };
}

export interface DriftCheckpoint {
  run: number;
  facets: Facet[];
  concepts: string[];
}

export class TestRunner {
  private topology: TopologyStore;
  private metadata: MetadataStore;
  private ops: Operations;
  private client: Anthropic;
  private costTracker: CostTracker;
  private dataPath: string;

  private resolutionHistory: number[] = [];
  private allPathScores: PathScore[] = [];
  private allRearrangementScores: RearrangementScore[] = [];
  private allContradictions: Contradiction[] = [];
  private driftCheckpoints: DriftCheckpoint[] = [];

  constructor(
    topology: TopologyStore,
    metadata: MetadataStore,
    ops: Operations,
    client: Anthropic,
    costTracker: CostTracker,
    dataDir?: string,
  ) {
    this.topology = topology;
    this.metadata = metadata;
    this.ops = ops;
    this.client = client;
    this.costTracker = costTracker;
    this.dataPath = dataDir ? join(dataDir, 'test-data.json') : '';
    this.loadPersistedData();
  }

  private loadPersistedData(): void {
    if (!this.dataPath || !existsSync(this.dataPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.dataPath, 'utf-8'));
      this.resolutionHistory = raw.resolutionHistory ?? [];
      this.allPathScores = raw.allPathScores ?? [];
      this.allRearrangementScores = raw.allRearrangementScores ?? [];
      this.allContradictions = raw.allContradictions ?? [];
      this.driftCheckpoints = raw.driftCheckpoints ?? [];
    } catch { /* corrupted file, start fresh */ }
  }

  saveData(): void {
    if (!this.dataPath) return;
    writeFileSync(this.dataPath, JSON.stringify({
      resolutionHistory: this.resolutionHistory,
      allPathScores: this.allPathScores,
      allRearrangementScores: this.allRearrangementScores,
      allContradictions: this.allContradictions,
      driftCheckpoints: this.driftCheckpoints,
    }, null, 2));
  }

  runPerInput(run: number): PerInputMetrics {
    const state = this.topology.snapshot();
    const centrality = computeBetweennessCentrality(state);
    const values = Object.values(centrality);
    const hgi = giniCoefficient(values);

    const concepts = state.concepts.length;
    const chains = state.chains.length;
    const resolution = concepts > 0 ? chains / concepts : 0;
    this.resolutionHistory.push(resolution);

    const networkMetrics = computeNetworkMetrics(state);

    return { run, hgi, resolution, networkMetrics };
  }

  async runPeriodic(run: number): Promise<PeriodicResults> {
    const state = this.topology.snapshot();

    // Evaluate emergent paths
    const emergentPaths = discoverEmergentPaths(state, 0.1, 2, 5);
    const pathsToEval = emergentPaths.slice(0, 10);
    const semanticScores: PathScore[] = [];
    for (const path of pathsToEval) {
      try {
        const score = await evaluatePathSemantic(path, state, this.client, this.costTracker);
        semanticScores.push(score);
        this.allPathScores.push(score);
      } catch { /* budget exhaustion */ }
    }

    // Self-critique feedback: feed semantic scores back into chain weights
    // Validated paths get weight bonus; shallow paths get extra decay
    for (const score of semanticScores) {
      const [from, to] = score.pathId.split('→').map(s => s.toLowerCase().trim());
      const relatedChains = this.topology.snapshot().chains.filter(c => {
        const cf = c.fromConcept.toLowerCase();
        const ct = c.toConcept.toLowerCase();
        return cf === from || ct === to || cf === to || ct === from;
      });
      for (const chain of relatedChains) {
        if (score.isShallow) {
          // Shallow: extra 10% decay + mark as shallow
          this.topology.adjustChainWeight(chain.id, -0.10);
          this.topology.setChainValidation(chain.id, 'shallow');
        } else if (score.compositeScore >= 3.5) {
          // Validated: 5% weight bonus + mark as validated
          this.topology.adjustChainWeight(chain.id, 0.05);
          this.topology.setChainValidation(chain.id, 'validated');
        }
      }
    }

    // Find contradictions
    let contradictions: Contradiction[] = [];
    try {
      contradictions = await findContradictions(state, this.client, this.costTracker);
      this.allContradictions.push(...contradictions);
    } catch { /* budget */ }

    // Mark chains involved in contradictions as 'challenged'
    for (const c of contradictions) {
      const cALower = c.conceptA.toLowerCase();
      const cBLower = c.conceptB.toLowerCase();
      const challengedChains = this.topology.snapshot().chains.filter(
        ch => (ch.fromConcept.toLowerCase() === cALower && ch.toConcept.toLowerCase() === cBLower) ||
              (ch.fromConcept.toLowerCase() === cBLower && ch.toConcept.toLowerCase() === cALower)
      );
      for (const ch of challengedChains) {
        this.topology.setChainValidation(ch.id, 'challenged');
      }
    }

    if (semanticScores.length > 0 || contradictions.length > 0) {
      this.topology.save();
    }

    // Question stats
    const questions = this.topology.getQuestions();
    const questionStats = {
      total: questions.length,
      addressed: questions.filter(q => q.status === 'addressed').length,
      dissolved: questions.filter(q => q.status === 'dissolved').length,
    };

    return { run, semanticScores, contradictions, questionStats };
  }

  async runDriftTest(inputText: string, run: number, identityContext?: string): Promise<DriftCheckpoint> {
    const result = await testD_decomposeDrift(inputText, this.ops, identityContext);
    const checkpoint = { run, facets: result.facets, concepts: result.concepts };
    this.driftCheckpoints.push(checkpoint);
    return checkpoint;
  }

  async runFinalSuite(): Promise<AllTestResults> {
    const state = this.topology.snapshot();
    const questions = this.topology.getQuestions();

    // Evaluate remaining rearrangements
    const rearrangements = detectRearrangements(this.metadata.chainHistories);
    for (const event of rearrangements.slice(0, 30)) {
      try {
        const score = await evaluateRearrangement(event, this.client, this.costTracker);
        this.allRearrangementScores.push(score);
      } catch { /* budget */ }
    }

    // Tests
    const A = testA_hubGravity(state);
    const B = testB_semanticEmergence(this.allPathScores);
    const C = testC_resolutionGrowth(this.resolutionHistory);

    // Test D
    let D = null;
    if (this.driftCheckpoints.length >= 2) {
      const d1 = this.driftCheckpoints.find(c => c.run === 1);
      const d2 = this.driftCheckpoints.find(c => c.run === 25) ?? this.driftCheckpoints[this.driftCheckpoints.length - 1];
      // D3: decompose with no identity (already captured at run 25 if implemented)
      const d3 = this.driftCheckpoints.find(c => c.run === -25); // sentinel for no-identity variant
      D = testD_compareDrift(
        d1?.facets ?? [],
        d2?.facets ?? [],
        d3?.facets ?? d2?.facets ?? [],
      );
    }

    const E = testE_questionLifecycle(questions);
    const F = testF_contradictions(this.allContradictions);
    const G = testG_networkTransition(state);
    const H = testH_humanValidation();
    const I = testI_rearrangementQuality(this.allRearrangementScores);
    const J = testJ_scaleSimulation();

    // K needs a separate decompose run with and without the signal, so it is not computed here
    const K = null;

    const results: AllTestResults = {
      A, B, C, D, E, F, G, H, I, J, K,
      summary: {
        mustPass: { B: B.pass, G: G.pass, D: D?.pass ?? false },
        shouldPass: { A: A.pass, C: C.pass, E: E.pass, I: I.pass },
        niceToHave: { F: F.pass, H: false, K: (K as { pass: boolean } | null)?.pass ?? false },
        overallVerdict: '',
      },
    };
    results.summary.overallVerdict = computeVerdict(results);

    return results;
  }

  generateReport(results: AllTestResults): string {
    let report = `# Level 3 Test Report\n\n`;
    report += `## Test Results\n\n`;
    report += `| Layer | Test | Result | Detail |\n|---|---|---|---|\n`;

    // L1 Structural
    report += `| L1 | A: Hub Gravity | **${results.A.pass ? 'PASS' : 'FAIL'}** | Gini = ${results.A.gini.toFixed(3)} (need < 0.5) |\n`;
    report += `| L1 | G: Network Shape | **${results.G.pass ? 'PASS' : 'FAIL'}** | top3PathShare = ${(results.G.metrics.top3PathShare * 100).toFixed(1)}% (need < 40%) |\n`;

    // L2 Semantic
    report += `| L2 | B: Semantic Emergence | **${results.B.pass ? 'PASS' : 'FAIL'}** | avgComposite = ${results.B.avgComposite.toFixed(2)} (need > 3.0) |\n`;
    report += `| L2 | F: Contradictions | **${results.F.pass ? 'PASS' : 'FAIL'}** | ${results.F.count} found |\n`;
    report += `| L2 | I: Rearrangement Quality | **${results.I.pass ? 'PASS' : 'FAIL'}** | avgGenuine = ${results.I.avgGenuine.toFixed(2)} (need > 3.0) |\n`;

    // L3 Cognitive
    if (results.D) {
      report += `| L3 | D: Decompose Drift | **${results.D.pass ? 'PASS' : 'FAIL'}** | Jaccard(1→25) = ${results.D.jaccardRun1.toFixed(3)} (need < 0.5), identity effect = ${results.D.identityEffect} |\n`;
    }
    report += `| L3 | K: Autopoietic | **${results.K?.pass ? 'PASS' : 'N/A'}** | ${results.K ? `jaccardDiff = ${results.K.jaccardDiff.toFixed(3)}` : 'not run'} |\n`;

    // Meta
    report += `| Meta | C: Resolution Growth | **${results.C.pass ? 'PASS' : 'FAIL'}** | trend = ${results.C.trend} |\n`;
    report += `| Meta | E: Question Lifecycle | **${results.E.pass ? 'PASS' : 'FAIL'}** | resolutionRate = ${(results.E.resolutionRate * 100).toFixed(1)}% (need > 10%) |\n`;
    report += `| Meta | H: Human Validation | **manual** | See protocol |\n`;
    report += `| Meta | J: Scale Simulation | **manual** | See protocol |\n`;

    report += `\n## Verdict\n\n**${results.summary.overallVerdict}**\n\n`;

    report += `### Must-Pass\n`;
    report += `- B (Semantic Emergence > 3.0): ${results.summary.mustPass.B ? 'PASS' : 'FAIL'}\n`;
    report += `- G (top3PathShare < 40%): ${results.summary.mustPass.G ? 'PASS' : 'FAIL'}\n`;
    report += `- D (Jaccard < 0.5): ${results.summary.mustPass.D ? 'PASS' : 'FAIL'}\n`;

    report += `\n### Should-Pass\n`;
    report += `- A (Gini < 0.5): ${results.summary.shouldPass.A ? 'PASS' : 'FAIL'}\n`;
    report += `- C (Resolution increasing): ${results.summary.shouldPass.C ? 'PASS' : 'FAIL'}\n`;
    report += `- E (Question resolution > 10%): ${results.summary.shouldPass.E ? 'PASS' : 'FAIL'}\n`;
    report += `- I (Rearrangement genuine > 3.0): ${results.summary.shouldPass.I ? 'PASS' : 'FAIL'}\n`;

    report += `\n### Nice-to-Have\n`;
    report += `- F (Contradictions found): ${results.summary.niceToHave.F ? 'PASS' : 'FAIL'}\n`;
    report += `- K (Autopoietic loop): ${results.summary.niceToHave.K ? 'PASS' : 'N/A'}\n`;

    // Network metrics
    report += `\n## Network Metrics\n\n`;
    report += `- Diameter: ${results.G.metrics.diameter}\n`;
    report += `- Clustering coefficient: ${results.G.metrics.clusteringCoeff.toFixed(3)}\n`;
    report += `- Articulation points: ${results.G.metrics.articulationPoints.length}\n`;
    report += `- Avg path length: ${results.G.metrics.avgPathLength.toFixed(2)}\n`;

    // Protocols for manual tests
    report += `\n## Manual Test Protocols\n\n`;
    report += `### Test H\n${results.H.protocol}\n\n`;
    report += `### Test J\n${results.J.protocol}\n`;

    return report;
  }

  async runScaleTest(
    circuit: Circuit,
    baselineDir: string,
    inputs: Array<{ content: string }>,
    queries: string[],
  ): Promise<{ wins: number; losses: number; ties: number; details: any[] }> {
    const enrichedOps = new Operations(this.client, this.costTracker);
    const enriched = new EnrichedBaseline(baselineDir, enrichedOps);
    enriched.reset();

    console.log(`  Processing ${inputs.length} inputs through enriched baseline...`);
    for (let i = 0; i < inputs.length; i++) {
      await enriched.processInput(inputs[i].content, i + 1);
      if ((i + 1) % 10 === 0) console.log(`    ${i + 1}/${inputs.length}`);
    }

    const judge = new Judge(this.client, this.costTracker);
    let wins = 0, losses = 0, ties = 0;
    const details: any[] = [];

    console.log(`  Running ${queries.length} blind comparisons...`);
    for (const query of queries.slice(0, 5)) {
      const topoResult = await circuit.query(query);
      const baselineAnswer = await enriched.query(query);
      const judgeResult = await judge.blindCompare(query, topoResult.answer, baselineAnswer);

      details.push({ query, judgeResult });
      if (judgeResult.winner === 'A') wins++;
      else if (judgeResult.winner === 'B') losses++;
      else ties++;

      console.log(`    "${query.slice(0, 50)}..." → ${judgeResult.winner === 'A' ? 'TOPOLOGY' : judgeResult.winner === 'B' ? 'BASELINE' : 'TIE'}`);
    }

    return { wins, losses, ties, details };
  }
}
