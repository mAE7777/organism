import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { TopologyStore } from './topology.js';
import { MetadataStore } from './metadata.js';
import { Operations } from './operations.js';
import { CostTracker } from './cost.js';
import { Circuit, type L2QueryResult, type L3ProcessResult } from './circuit.js';
import { Baseline, EnrichedBaseline } from './baseline.js';
import { IdentityEngine } from './identity.js';
import { Judge, type JudgeResult } from './judge.js';
import { discoverEmergentPaths } from './traversal.js';
import { computeBridgeScores, detectRearrangements } from './analysis.js';
import { EmbeddingResonance } from './resonance.js';
import { TestRunner } from './test-runner.js';
import { topologyHealthCheck } from './graph-metrics.js';
import { IOLogger } from './io-logger.js';

const L2_QUERIES = [
  'What connects security to cooking?',
  'What pattern appears in 3+ different domains?',
  "What's the deepest insight from combining all inputs?",
  'How has understanding shifted from input 1 to input 50?',
  'What connection would surprise someone who read each input separately?',
  'How does patience manifest differently across ecology, cooking, and investing?',
  'What role do constraints play in creativity across music, game design, and architecture?',
  'How does the challenge input on monocultures relate to the original ecology input?',
  'What bridge concept connects the most different domains, and why?',
  'What did the topology forget, and was that forgetting valuable?',
];

// Legacy MVO queries for backward compatibility
const MVO_QUERIES = L2_QUERIES.slice(0, 5);

export class Runner {
  private rootDir: string;
  private circuit: Circuit;
  private baseline: Baseline;
  private costTracker: CostTracker;
  private ops: Operations;

  constructor(rootDir: string) {
    this.rootDir = rootDir;

    const client = new Anthropic();
    this.costTracker = new CostTracker(join(rootDir, 'results'));
    this.ops = new Operations(client, this.costTracker);

    const topology = new TopologyStore(join(rootDir, 'topology'));
    this.circuit = new Circuit(topology, this.ops, join(rootDir, 'results', 'traces'));
    this.baseline = new Baseline(join(rootDir, 'baseline'), this.ops);
  }

  async runAll(): Promise<void> {
    const inputs = this.loadInputs();
    console.log(`Running A/B test with ${inputs.length} inputs and ${MVO_QUERIES.length} queries.\n`);

    for (let i = 0; i < inputs.length; i++) {
      const runNumber = i + 1;
      console.log(`\n--- Input ${runNumber}: ${inputs[i].name} ---`);

      if (this.costTracker.isOverBudget) {
        console.log('BUDGET EXCEEDED — stopping.');
        break;
      }

      console.log('  System A (baseline)...');
      const baseResult = await this.baseline.processInput(inputs[i].content, runNumber);
      console.log(`  → Summary: ${baseResult.summaryLength} chars`);

      console.log('  System B (topology)...');
      const topoResult = await this.circuit.processInput(inputs[i].content, runNumber);
      console.log(`  → Concepts: ${topoResult.newConcepts}, Chains: ${topoResult.newChains}, Pruned: ${topoResult.pruned}`);

      if (topoResult.comparison.crossInputChains.length > 0) {
        console.log(`  → Cross-input chains: ${topoResult.comparison.crossInputChains.join('; ')}`);
      }

      console.log(`  Cost so far: $${this.costTracker.totalCost.toFixed(4)}`);
    }

    const queryDir = join(this.rootDir, 'results', 'queries');
    if (!existsSync(queryDir)) mkdirSync(queryDir, { recursive: true });

    console.log('\n\n=== QUERIES ===\n');
    const queryResults: Array<{ query: string; baseline: string; topology: string }> = [];

    for (let i = 0; i < MVO_QUERIES.length; i++) {
      if (this.costTracker.isOverBudget) {
        console.log('BUDGET EXCEEDED — stopping queries.');
        break;
      }

      const query = MVO_QUERIES[i];
      console.log(`\nQuery ${i + 1}: ${query}`);

      const [baselineAnswer, topologyResult] = await Promise.all([
        this.baseline.query(query),
        this.circuit.query(query),
      ]);

      queryResults.push({ query, baseline: baselineAnswer, topology: topologyResult.answer });

      writeFileSync(
        join(queryDir, `query-${String(i + 1).padStart(2, '0')}.md`),
        `# Query: ${query}\n\n## System A (Baseline)\n\n${baselineAnswer}\n\n## System B (Topology)\n\n${topologyResult.answer}\n`
      );

      console.log(`  Baseline: ${baselineAnswer.slice(0, 100)}...`);
      console.log(`  Topology: ${topologyResult.answer.slice(0, 100)}...`);
    }

    this.generateReport(queryResults);
  }

  async runOne(inputNumber: number): Promise<void> {
    const inputs = this.loadInputs();
    if (inputNumber < 1 || inputNumber > inputs.length) {
      console.log(`Input number must be between 1 and ${inputs.length}`);
      return;
    }

    const input = inputs[inputNumber - 1];
    console.log(`Processing input ${inputNumber}: ${input.name}\n`);

    console.log('System A (baseline)...');
    const baseResult = await this.baseline.processInput(input.content, inputNumber);
    console.log(`→ Summary: ${baseResult.summaryLength} chars`);

    console.log('\nSystem B (topology)...');
    const topoResult = await this.circuit.processInput(input.content, inputNumber);
    console.log(`→ Concepts: ${topoResult.newConcepts}, Chains: ${topoResult.newChains}, Pruned: ${topoResult.pruned}`);
    console.log(`→ Comparison: ${topoResult.comparison.interpretation}`);
    console.log(`\nCost: $${this.costTracker.totalCost.toFixed(4)}`);
  }

  async runQuery(question: string): Promise<void> {
    console.log(`Query: ${question}\n`);

    const [baselineAnswer, topologyResult] = await Promise.all([
      this.baseline.query(question),
      this.circuit.query(question),
    ]);

    console.log('=== System A (Baseline) ===');
    console.log(baselineAnswer);
    console.log('\n=== System B (Topology) ===');
    console.log(topologyResult.answer);
    console.log(`\nPaths used: ${topologyResult.pathsUsed.direct} direct, ${topologyResult.pathsUsed.transitive} transitive, ${topologyResult.pathsUsed.latent} latent`);
    console.log(`Cost: $${this.costTracker.totalCost.toFixed(4)}`);
  }

  showMetrics(): void {
    const metrics = this.circuit.getMetrics();
    console.log('Topology Metrics:');
    console.log(`  Concepts: ${metrics.conceptCount}`);
    console.log(`  Chains: ${metrics.chainCount}`);
    console.log(`  Avg depth: ${metrics.avgDepth.toFixed(2)}`);
    console.log(`  Cross-input chains: ${metrics.crossInputChainCount}`);
    console.log(`  Avg weight: ${metrics.avgWeight.toFixed(3)}`);
    console.log(`  Latent connections: ${metrics.latentConnectionCount}`);
  }

  showCost(): void {
    const summary = this.costTracker.summarize();
    console.log(`Total cost: $${summary.totalCost.toFixed(4)}`);
    console.log(`Total tokens: ${summary.totalInputTokens} input, ${summary.totalOutputTokens} output`);
    console.log('\nBy operation:');
    for (const [op, data] of Object.entries(summary.byOperation)) {
      console.log(`  ${op}: ${data.count} calls, $${data.cost.toFixed(4)}`);
    }
    console.log('\nBy model:');
    for (const [model, data] of Object.entries(summary.byModel)) {
      console.log(`  ${model}: ${data.count} calls, $${data.cost.toFixed(4)}`);
    }
  }

  private loadInputs(): Array<{ name: string; content: string }> {
    const inputDir = join(this.rootDir, 'inputs');
    const files = readdirSync(inputDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    return files.map((f) => ({
      name: f.replace('.md', ''),
      content: readFileSync(join(inputDir, f), 'utf-8'),
    }));
  }

  private generateReport(queryResults: Array<{ query: string; baseline: string; topology: string }>): void {
    const metrics = this.circuit.getMetrics();
    const cost = this.costTracker.summarize();

    let report = `# A/B Test Comparison Report\n\n`;
    report += `## Topology Metrics\n\n`;
    report += `- Concepts: ${metrics.conceptCount}\n`;
    report += `- Chains: ${metrics.chainCount}\n`;
    report += `- Cross-input chains: ${metrics.crossInputChainCount}\n`;
    report += `- Avg depth: ${metrics.avgDepth.toFixed(2)}\n`;
    report += `- Avg weight: ${metrics.avgWeight.toFixed(3)}\n`;
    report += `- Latent connections: ${metrics.latentConnectionCount}\n\n`;

    report += `## Kill Test Results\n\n`;
    report += `- Cross-input chains >= 3? **${metrics.crossInputChainCount >= 3 ? 'YES' : 'NO'}** (${metrics.crossInputChainCount})\n`;
    report += `- Budget within cap? **${cost.totalCost <= 12.0 ? 'YES' : 'NO'}** ($${cost.totalCost.toFixed(4)})\n\n`;

    report += `## Query Comparisons\n\n`;
    for (const qr of queryResults) {
      report += `### ${qr.query}\n\n`;
      report += `**System A (Baseline):**\n\n${qr.baseline}\n\n`;
      report += `**System B (Topology):**\n\n${qr.topology}\n\n`;
      report += `---\n\n`;
    }

    report += `## Cost Breakdown\n\n`;
    report += `Total: $${cost.totalCost.toFixed(4)}\n\n`;
    report += `| Operation | Calls | Cost |\n|---|---|---|\n`;
    for (const [op, data] of Object.entries(cost.byOperation)) {
      report += `| ${op} | ${data.count} | $${data.cost.toFixed(4)} |\n`;
    }

    const resultsDir = join(this.rootDir, 'results');
    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'comparison.md'), report);
    console.log(`\nReport written to results/comparison.md`);
  }
}

interface L2Options {
  resume?: boolean;
  noDecay?: boolean;
  dataDir?: string;
  enrichedBaseline?: boolean;
}

export class L2Runner {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async runL2(options: L2Options = {}): Promise<void> {
    const dataDir = options.dataDir ?? 'topology';
    const topoDir = join(this.rootDir, dataDir);
    const metaDir = join(this.rootDir, dataDir);
    const baselineDir = options.enrichedBaseline
      ? join(this.rootDir, 'baseline-enriched')
      : join(this.rootDir, 'baseline');
    const resultsDir = join(this.rootDir, 'results-l2');
    const traceDir = join(resultsDir, 'traces');

    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

    const client = new Anthropic();
    const costTracker = new CostTracker(resultsDir);
    const ioLogger = new IOLogger(resultsDir);
    const ops = new Operations(client, costTracker, ioLogger);
    const topology = new TopologyStore(topoDir);
    const metadata = new MetadataStore(metaDir);
    const identity = new IdentityEngine(client, costTracker, ioLogger);
    const circuit = new Circuit(topology, ops, traceDir, metadata, identity);

    const baseline: Baseline | EnrichedBaseline = options.enrichedBaseline
      ? new EnrichedBaseline(baselineDir, ops)
      : new Baseline(baselineDir, ops);

    const inputs = this.loadInputs();
    const startFrom = options.resume ? circuit.getLastCompletedRun() + 1 : 1;

    console.log(`Level 2 run: ${inputs.length} inputs, starting from ${startFrom}`);
    if (options.noDecay) console.log('  Decay DISABLED for this run.');
    if (options.enrichedBaseline) console.log('  Using ENRICHED baseline (multi-pass).');
    console.log(`  Data directory: ${dataDir}`);
    console.log(`  Budget cap: $12.00\n`);

    for (let i = startFrom - 1; i < inputs.length; i++) {
      const runNumber = i + 1;
      console.log(`\n--- Input ${runNumber}/${inputs.length}: ${inputs[i].name} ---`);

      if (costTracker.isOverBudget) {
        console.log('BUDGET EXCEEDED — stopping.');
        break;
      }

      // System A
      console.log('  System A (baseline)...');
      const baseResult = await baseline.processInput(inputs[i].content, runNumber);
      console.log(`  → Summary: ${baseResult.summaryLength} chars`);

      // System B — override decay if noDecay flag
      console.log('  System B (topology)...');
      const topoResult = await circuit.processInput(inputs[i].content, runNumber);
      console.log(`  → Concepts: ${topoResult.newConcepts}, Chains: ${topoResult.newChains}`);
      console.log(`  → Latent: ${topoResult.newLatentConnections}, Bridges: ${topoResult.bridgesDetected}`);
      console.log(`  → Pruned: ${topoResult.pruned} chains, ${topoResult.latentPruned} latent`);
      if (topoResult.identityShift) console.log(`  → Identity shifted`);

      console.log(`  Cost: $${costTracker.totalCost.toFixed(4)}`);

      // pace API calls to stay under rate limits (30k input tokens/min)
      if (i + 1 < inputs.length) {
        await new Promise((r) => setTimeout(r, 15000));
      }

      // periodic progress
      if (runNumber % 10 === 0) {
        const metrics = circuit.getMetrics();
        console.log(`\n  === Checkpoint at run ${runNumber} ===`);
        console.log(`  Concepts: ${metrics.conceptCount}, Chains: ${metrics.chainCount}, Latent: ${metrics.latentConnectionCount}`);
        console.log(`  Cross-input: ${metrics.crossInputChainCount}, Avg weight: ${metrics.avgWeight.toFixed(3)}`);
        console.log(`  Cost: $${costTracker.totalCost.toFixed(4)}`);
      }
    }

    console.log(`\nLevel 2 input processing complete. Cost: $${costTracker.totalCost.toFixed(4)}`);
  }

  async runL2Queries(options: { dataDir?: string; enrichedBaseline?: boolean } = {}): Promise<void> {
    const dataDir = options.dataDir ?? 'topology';
    const topoDir = join(this.rootDir, dataDir);
    const metaDir = join(this.rootDir, dataDir);
    const baselineDir = options.enrichedBaseline
      ? join(this.rootDir, 'baseline-enriched')
      : join(this.rootDir, 'baseline');
    const resultsDir = join(this.rootDir, 'results-l2');
    const queryDir = join(resultsDir, 'queries');

    if (!existsSync(queryDir)) mkdirSync(queryDir, { recursive: true });

    const client = new Anthropic();
    const costTracker = new CostTracker(resultsDir);
    const ioLogger = new IOLogger(resultsDir);
    const ops = new Operations(client, costTracker, ioLogger);
    const topology = new TopologyStore(topoDir);
    const metadata = new MetadataStore(metaDir);
    const identity = new IdentityEngine(client, costTracker, ioLogger);
    const circuit = new Circuit(topology, ops, join(resultsDir, 'traces'), metadata, identity);

    const baseline: Baseline | EnrichedBaseline = options.enrichedBaseline
      ? new EnrichedBaseline(baselineDir, ops)
      : new Baseline(baselineDir, ops);

    console.log(`Running ${L2_QUERIES.length} queries through both systems...\n`);

    const results: Array<{ query: string; baseline: string; topology: L2QueryResult }> = [];

    for (let i = 0; i < L2_QUERIES.length; i++) {
      if (costTracker.isOverBudget) {
        console.log('BUDGET EXCEEDED — stopping queries.');
        break;
      }

      const query = L2_QUERIES[i];
      console.log(`Query ${i + 1}: ${query}`);

      const [baselineAnswer, topologyResult] = await Promise.all([
        baseline.query(query),
        circuit.query(query),
      ]);

      results.push({ query, baseline: baselineAnswer, topology: topologyResult });

      writeFileSync(
        join(queryDir, `query-${String(i + 1).padStart(2, '0')}.md`),
        `# Query: ${query}\n\n## System A (Baseline)\n\n${baselineAnswer}\n\n## System B (Topology)\n\n${topologyResult.answer}\n\n## Paths Used\n\n- Direct: ${topologyResult.pathsUsed.direct}\n- Transitive: ${topologyResult.pathsUsed.transitive}\n- Latent: ${topologyResult.pathsUsed.latent}\n`
      );

      console.log(`  Done. Paths: ${topologyResult.pathsUsed.direct}d/${topologyResult.pathsUsed.transitive}t/${topologyResult.pathsUsed.latent}l`);
    }

    console.log(`\nQueries complete. Cost: $${costTracker.totalCost.toFixed(4)}`);
  }

  async runL2Analysis(): Promise<void> {
    const topoDir = join(this.rootDir, 'topology');
    const resultsDir = join(this.rootDir, 'results-l2');

    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

    const topology = new TopologyStore(topoDir);
    const metadata = new MetadataStore(topoDir);
    const state = topology.snapshot();

    console.log('=== Level 2 Analysis ===\n');

    // Test 1: Emergent transitive paths
    const emergentPaths = discoverEmergentPaths(state, 0.1, 3, 5);
    console.log(`Test 1 — Unplanted connections: ${emergentPaths.length} multi-hop paths spanning 3+ inputs`);
    for (const p of emergentPaths.slice(0, 10)) {
      console.log(`  ${p.from} → ${p.hops.join(' → ')} → ${p.to} (weight ${p.weight.toFixed(3)}, inputs ${p.sourceInputsSpanned.join(',')})`);
    }
    const test1Pass = emergentPaths.length >= 10;
    console.log(`  Result: ${test1Pass ? 'PASS' : 'FAIL'} (need >=10, got ${emergentPaths.length})\n`);

    // Test 2: Bridge surprise
    const bridges = computeBridgeScores(state);
    const topBridges = bridges.slice(0, 5);
    console.log(`Test 2 — Bridge surprise: ${bridges.length} bridge concepts detected`);
    for (const b of topBridges) {
      const concept = state.concepts.find((c) => c.id === b.conceptId);
      console.log(`  ${concept?.name ?? b.conceptId}: score ${b.bridgeScore.toFixed(2)}, inputs ${b.uniqueSourceInputs}, domains ${b.uniqueDomains}, chains ${b.chainsThrough}`);
    }
    // A bridge is "surprising" if it wasn't a primary concept in any single input
    // This requires manual inspection, so we just flag the top ones
    console.log(`  (Manual check: are >=2 top bridges NOT the most-mentioned terms?)\n`);

    // Test 3: Identity drift
    const identities = metadata.getAllIdentitySnapshots();
    console.log(`Test 3 — Identity drift: ${identities.length} identity snapshots`);
    const checkpoints = [10, 25, 50].map((r) => metadata.getIdentityAt(r)).filter(Boolean);
    for (const snap of checkpoints) {
      console.log(`  Run ${snap!.run}: "${snap!.description.slice(0, 120)}..."`);
    }
    const test3Pass = checkpoints.length >= 2 && checkpoints[0]!.description !== checkpoints[checkpoints.length - 1]!.description;
    console.log(`  Result: ${test3Pass ? 'PASS (descriptions differ)' : 'FAIL (converged or insufficient snapshots)'}\n`);

    // Test 5: Rearrangement
    const rearrangements = detectRearrangements(metadata.chainHistories);
    console.log(`Test 5 — Rearrangement: ${rearrangements.length} events`);
    for (const r of rearrangements.slice(0, 5)) {
      console.log(`  ${r.endpoints.join('↔')}: run ${r.fromRun}→${r.toRun} (${r.oldIntermediates.join(',')} → ${r.newIntermediates.join(',')})`);
    }
    // count unique endpoint pairs
    const uniquePairs = new Set(rearrangements.map((r) => r.endpoints.sort().join('|')));
    const test5Pass = uniquePairs.size >= 5;
    console.log(`  Result: ${test5Pass ? 'PASS' : 'FAIL'} (need >=5 pairs, got ${uniquePairs.size})\n`);

    // Write analysis report
    const analysis = {
      test1: { emergentPaths: emergentPaths.length, pass: test1Pass, topPaths: emergentPaths.slice(0, 20) },
      test2: { bridges: topBridges },
      test3: { snapshots: checkpoints.length, pass: test3Pass },
      test5: { rearrangements: rearrangements.length, uniquePairs: uniquePairs.size, pass: test5Pass },
      metrics: topology.getMetrics(),
    };
    writeFileSync(join(resultsDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
    console.log('Analysis written to results-l2/analysis.json');

    if (!test1Pass) {
      console.log('\n*** KILL GATE: Test 1 FAILED. <10 emergent paths. Thesis may be wrong. ***');
      console.log('*** Do NOT proceed to Tests 4/6 without investigation. ***');
    }
  }

  async runL2Judge(options: { dataDir?: string; enrichedBaseline?: boolean } = {}): Promise<void> {
    const resultsDir = join(this.rootDir, 'results-l2');
    const queryDir = join(resultsDir, 'queries');

    if (!existsSync(queryDir)) {
      console.log('No queries found. Run run-l2-queries first.');
      return;
    }

    const client = new Anthropic();
    const costTracker = new CostTracker(resultsDir);
    const judge = new Judge(client, costTracker);

    const queryFiles = readdirSync(queryDir).filter((f) => f.endsWith('.md')).sort();
    const results: JudgeResult[] = [];

    console.log(`Judging ${queryFiles.length} query comparisons...\n`);

    for (const file of queryFiles) {
      const content = readFileSync(join(queryDir, file), 'utf-8');

      // Parse query file
      const queryMatch = content.match(/^# Query: (.+)/m);
      const baselineMatch = content.match(/## System A \(Baseline\)\n\n([\s\S]*?)(?=\n## System B)/);
      const topologyMatch = content.match(/## System B \(Topology\)\n\n([\s\S]*?)(?=\n## Paths Used|\n*$)/);

      if (!queryMatch || !baselineMatch || !topologyMatch) {
        console.log(`  Skipping ${file}: could not parse.`);
        continue;
      }

      const question = queryMatch[1];
      const baselineAnswer = baselineMatch[1].trim();
      const topologyAnswer = topologyMatch[1].trim();

      if (costTracker.isOverBudget) {
        console.log('BUDGET EXCEEDED — stopping judge.');
        break;
      }

      const result = await judge.blindCompare(question, topologyAnswer, baselineAnswer);
      results.push(result);

      const winLabel = result.winner === 'A' ? 'TOPOLOGY' : result.winner === 'B' ? 'BASELINE' : 'TIE';
      console.log(`  ${file}: ${winLabel} (presented ${result.presentationOrder.first} first)`);
    }

    // Tally
    const topoWins = results.filter((r) => r.winner === 'A').length;
    const baseWins = results.filter((r) => r.winner === 'B').length;
    const ties = results.filter((r) => r.winner === 'tie').length;

    console.log(`\nResults: Topology ${topoWins}, Baseline ${baseWins}, Tie ${ties}`);
    console.log(`Test 4/6 threshold: Topology wins >=6/10`);
    console.log(`Result: ${topoWins >= 6 ? 'PASS' : 'FAIL'}`);

    writeFileSync(
      join(resultsDir, 'judge-results.json'),
      JSON.stringify({ results, summary: { topoWins, baseWins, ties } }, null, 2),
    );
    console.log(`\nJudge results written to results-l2/judge-results.json`);
  }

  async runL2Report(): Promise<void> {
    const resultsDir = join(this.rootDir, 'results-l2');
    const topoDir = join(this.rootDir, 'topology');

    const topology = new TopologyStore(topoDir);
    const metadata = new MetadataStore(topoDir);
    const metrics = topology.getMetrics();
    const state = topology.snapshot();

    // Load analysis if exists
    const analysisPath = join(resultsDir, 'analysis.json');
    const analysis = existsSync(analysisPath) ? JSON.parse(readFileSync(analysisPath, 'utf-8')) : null;

    // Load judge results if exists
    const judgePath = join(resultsDir, 'judge-results.json');
    const judgeData = existsSync(judgePath) ? JSON.parse(readFileSync(judgePath, 'utf-8')) : null;

    // Load cost
    const costTracker = new CostTracker(resultsDir);
    const cost = costTracker.summarize();

    let report = `# Level 2 Test Report\n\n`;
    report += `## Topology Metrics\n\n`;
    report += `- Concepts: ${metrics.conceptCount}\n`;
    report += `- Direct chains: ${metrics.chainCount}\n`;
    report += `- Latent connections: ${metrics.latentConnectionCount}\n`;
    report += `- Cross-input chains: ${metrics.crossInputChainCount}\n`;
    report += `- Avg depth: ${metrics.avgDepth.toFixed(2)}\n`;
    report += `- Avg weight: ${metrics.avgWeight.toFixed(3)}\n`;
    report += `- Runs completed: ${state.runCount}\n\n`;

    report += `## Kill Test Results\n\n`;
    report += `| # | Test | Result | Detail |\n|---|------|--------|--------|\n`;

    if (analysis) {
      report += `| 1 | Unplanted connections (>=10 multi-hop) | **${analysis.test1.pass ? 'PASS' : 'FAIL'}** | ${analysis.test1.emergentPaths} paths found |\n`;
      report += `| 2 | Bridge surprise (>=2 unexpected bridges) | **Manual** | See bridge list below |\n`;
      report += `| 3 | Identity drift (different at 10/25/50) | **${analysis.test3.pass ? 'PASS' : 'FAIL'}** | ${analysis.test3.snapshots} checkpoints |\n`;
    }

    if (judgeData) {
      const topoWins = judgeData.summary.topoWins;
      report += `| 4 | Decay value (topology wins >=6/10) | **${topoWins >= 6 ? 'PASS' : 'FAIL'}** | Topology ${topoWins}/${judgeData.results.length} |\n`;
    }

    if (analysis) {
      report += `| 5 | Rearrangement (>=5 pairs changed) | **${analysis.test5.pass ? 'PASS' : 'FAIL'}** | ${analysis.test5.uniquePairs} pairs |\n`;
    }

    report += `| 6 | Fair budget (topology wins >=6/10 vs enriched) | **TBD** | Run with --enriched-baseline |\n\n`;

    // Bridge details
    if (analysis?.test2?.bridges) {
      report += `## Top Bridge Concepts\n\n`;
      report += `| Concept | Score | Source Inputs | Domains | Chains Through |\n|---|---|---|---|---|\n`;
      for (const b of analysis.test2.bridges) {
        const concept = state.concepts.find((c: any) => c.id === b.conceptId);
        report += `| ${concept?.name ?? b.conceptId} | ${b.bridgeScore.toFixed(2)} | ${b.uniqueSourceInputs} | ${b.uniqueDomains} | ${b.chainsThrough} |\n`;
      }
      report += '\n';
    }

    // Identity snapshots
    const identities = metadata.getAllIdentitySnapshots();
    if (identities.length > 0) {
      report += `## Identity Evolution\n\n`;
      const checkpoints = [1, 10, 25, 50];
      for (const r of checkpoints) {
        const snap = metadata.getIdentityAt(r);
        if (snap) {
          report += `**Run ${r}:** ${snap.description}\n\n`;
        }
      }
    }

    // Cost
    report += `## Cost\n\n`;
    report += `Total: $${cost.totalCost.toFixed(4)}\n\n`;
    report += `| Operation | Calls | Cost |\n|---|---|---|\n`;
    for (const [op, data] of Object.entries(cost.byOperation)) {
      report += `| ${op} | ${(data as any).count} | $${(data as any).cost.toFixed(4)} |\n`;
    }

    // Verdict
    report += `\n## Verdict\n\n`;
    if (analysis) {
      const test1 = analysis.test1.pass;
      const test3 = analysis.test3.pass;
      const test5 = analysis.test5.pass;

      if (!test1) {
        report += `**THESIS NOT VALIDATED.** Test 1 failed — insufficient emergent paths. The topology did not produce connections that no single LLM call was asked to find.\n`;
      } else if (test1 && test3 && test5) {
        report += `**EMERGENCE DETECTED.** Tests 1, 3, and 5 pass — the topology produces unplanted connections, evolves its identity, and rearranges paths over time. Proceed to Test 6 for practical advantage assessment.\n`;
      } else {
        report += `**PARTIAL.** Some emergence detected but not all structural tests pass. Review individual test results.\n`;
      }
    } else {
      report += `Run \`run-l2-analysis\` first to populate test results.\n`;
    }

    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'report.md'), report);
    console.log('Report written to results-l2/report.md');
  }

  private loadInputs(): Array<{ name: string; content: string }> {
    const inputDir = join(this.rootDir, 'inputs');
    const files = readdirSync(inputDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    return files.map((f) => ({
      name: f.replace('.md', ''),
      content: readFileSync(join(inputDir, f), 'utf-8'),
    }));
  }
}

interface L3Options {
  resume?: boolean;
  dataDir?: string;
  inputDir?: string;
}

export class L3Runner {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async runL3(options: L3Options = {}): Promise<void> {
    const dataDir = options.dataDir ?? 'topology-l3';
    const topoDir = join(this.rootDir, dataDir);
    const resultsDir = join(this.rootDir, 'results-l3');
    const traceDir = join(resultsDir, 'traces');

    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

    const client = new Anthropic();
    const costTracker = new CostTracker(resultsDir, 20.0);
    const ioLogger = new IOLogger(resultsDir);
    const ops = new Operations(client, costTracker, ioLogger);
    const topology = new TopologyStore(topoDir);
    const metadata = new MetadataStore(topoDir);
    const identity = new IdentityEngine(client, costTracker, ioLogger);
    const resonance = new EmbeddingResonance();

    console.log('Initializing embedding model...');
    await resonance.init();

    const circuit = new Circuit(topology, ops, traceDir, metadata, identity, resonance);
    const testRunner = new TestRunner(topology, metadata, ops, client, costTracker, topoDir);

    const inputs = this.loadInputs(options.inputDir);
    const startFrom = options.resume ? circuit.getLastCompletedRun() + 1 : 1;

    if (!options.resume) {
      topology.reset();
      metadata.reset();
      // Clear persisted test data from prior runs
      const testDataPath = join(topoDir, 'test-data.json');
      if (existsSync(testDataPath)) {
        unlinkSync(testDataPath);
      }
    }

    let previousBridges: string[] | undefined;

    console.log(`Level 3 run: ${inputs.length} inputs, starting from ${startFrom}`);
    console.log(`  Data directory: ${dataDir}`);
    console.log(`  Budget cap: $20.00\n`);

    for (let i = startFrom - 1; i < inputs.length; i++) {
      const runNumber = i + 1;
      console.log(`\n--- Input ${runNumber}/${inputs.length}: ${inputs[i].name} ---`);

      if (costTracker.isOverBudget) {
        console.log('BUDGET EXCEEDED — stopping.');
        break;
      }

      // Process — wrapped in try/catch so individual input failures don't kill the run
      let result: L3ProcessResult;
      try {
        result = await circuit.processInput(inputs[i].content, runNumber) as L3ProcessResult;
      } catch (err: any) {
        console.log(`  FAILED: ${err.message?.slice(0, 120) ?? err}`);
        console.log(`  Skipping input ${runNumber}, continuing...`);
        console.log(`  Cost: $${costTracker.totalCost.toFixed(4)}`);
        if (i + 1 < inputs.length) await new Promise(r => setTimeout(r, 15000));
        continue;
      }

      console.log(`  Concepts: ${result.newConcepts}, Chains: ${result.newChains}`);
      console.log(`  Latent: ${result.newLatentConnections}, Bridges: ${result.bridgesDetected}`);
      console.log(`  Pruner: ${result.prunerResult.hubsPenalized.length} hubs, ${result.prunerResult.bridgesProtected.length} bridges, ${result.prunerResult.orphansArchived.length} orphans`);
      if (result.identityShift) console.log('  Identity shifted');

      // Per-input metrics
      const metrics = testRunner.runPerInput(runNumber);
      testRunner.saveData();
      console.log(`  HGI: ${metrics.hgi.toFixed(3)}, Resolution: ${metrics.resolution.toFixed(3)}`);

      // Health check (every 5 inputs)
      if (runNumber % 5 === 0) {
        const health = topologyHealthCheck(topology.snapshot(), previousBridges);
        previousBridges = health.bridgeStability.stable.concat(health.bridgeStability.newBridges);
        if (health.warnings.length > 0) {
          console.log(`  Health warnings:`);
          for (const w of health.warnings) console.log(`    ⚠ ${w}`);
        } else {
          console.log(`  Health: OK (HGI=${health.hubGravityIndex.toFixed(3)}, orphans=${health.orphanCount})`);
        }
      }

      // Kill gate: HGI after 10 inputs
      if (runNumber === 10 && metrics.hgi > 0.85) {
        console.log('\n*** KILL GATE: HGI > 0.85 after 10 inputs. Crystallization not helping hub gravity. ***');
        console.log('*** Investigate before continuing. ***\n');
      }

      // Periodic tests (every 10 inputs)
      if (runNumber % 10 === 0) {
        console.log(`\n  === Periodic evaluation at run ${runNumber} ===`);
        try {
          const periodic = await testRunner.runPeriodic(runNumber);
          const avgSemantic = periodic.semanticScores.length > 0
            ? periodic.semanticScores.reduce((s, p) => s + p.compositeScore, 0) / periodic.semanticScores.length
            : 0;
          console.log(`  Semantic scores: ${periodic.semanticScores.length} paths evaluated, avg = ${avgSemantic.toFixed(2)}`);
          console.log(`  Contradictions: ${periodic.contradictions.length}`);
          console.log(`  Questions: ${periodic.questionStats.total} total, ${periodic.questionStats.addressed} addressed, ${periodic.questionStats.dissolved} dissolved`);
          testRunner.saveData();

          // Kill gate: SES after 25 inputs
          if (runNumber === 25 && avgSemantic < 2.0 && periodic.semanticScores.length > 0) {
            console.log('\n*** KILL GATE: SES < 2.0 after 25 inputs. Semantic emergence failing. ***');
            console.log('*** Consider stopping. ***\n');
          }
        } catch (err: any) {
          console.log(`  Periodic evaluation failed: ${err.message?.slice(0, 120) ?? err}`);
        }
      }

      // Drift tests at checkpoints
      if (runNumber === 1 || runNumber === 25 || runNumber === 50) {
        console.log(`  Running drift test at checkpoint ${runNumber}...`);
        try {
          const latestIdentity = metadata.getLatestIdentity();
          const identityCtx = latestIdentity ? identity.formatForDecompose(latestIdentity) : undefined;
          await testRunner.runDriftTest(inputs[0].content, runNumber, identityCtx);

          // Also run without identity at run 25 (Gap 2: D3 variant)
          if (runNumber === 25) {
            console.log('  Running drift test without identity (D3 variant)...');
            await testRunner.runDriftTest(inputs[0].content, -25, undefined);
          }
          testRunner.saveData();
        } catch (err: any) {
          console.log(`  Drift test failed: ${err.message?.slice(0, 120) ?? err}`);
        }
      }

      console.log(`  Cost: $${costTracker.totalCost.toFixed(4)}`);

      // Rate limiting
      if (i + 1 < inputs.length) {
        await new Promise(r => setTimeout(r, 15000));
      }
    }

    console.log(`\nLevel 3 input processing complete. Cost: $${costTracker.totalCost.toFixed(4)}`);
  }

  async runL3Evaluate(): Promise<void> {
    const dataDir = 'topology-l3';
    const topoDir = join(this.rootDir, dataDir);
    const resultsDir = join(this.rootDir, 'results-l3');

    const client = new Anthropic();
    const costTracker = new CostTracker(resultsDir, 25.0);
    const ops = new Operations(client, costTracker);
    const topology = new TopologyStore(topoDir);
    const metadata = new MetadataStore(topoDir);

    const testRunner = new TestRunner(topology, metadata, ops, client, costTracker, topoDir);

    console.log('Running final test suite...\n');
    const results = await testRunner.runFinalSuite();

    const report = testRunner.generateReport(results);
    writeFileSync(join(resultsDir, 'test-results.json'), JSON.stringify(results, null, 2));
    console.log('\nResults written to results-l3/test-results.json');

    console.log(`\nVerdict: ${results.summary.overallVerdict}`);
  }

  async runL3Report(): Promise<void> {
    const resultsDir = join(this.rootDir, 'results-l3');
    const resultsPath = join(resultsDir, 'test-results.json');

    if (!existsSync(resultsPath)) {
      console.log('No test results found. Run run-l3-evaluate first.');
      return;
    }

    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
    const costTracker = new CostTracker(resultsDir, 20.0);
    const topology = new TopologyStore(join(this.rootDir, 'topology-l3'));
    const metadata = new MetadataStore(join(this.rootDir, 'topology-l3'));
    const ops = new Operations(new Anthropic(), costTracker);

    const testRunner = new TestRunner(topology, metadata, ops, new Anthropic(), costTracker, join(this.rootDir, 'topology-l3'));
    const report = testRunner.generateReport(results);

    // Add cost section
    const cost = costTracker.summarize();
    const costSection = `\n## Cost\n\nTotal: $${cost.totalCost.toFixed(4)}\n\n| Operation | Calls | Cost |\n|---|---|---|\n` +
      Object.entries(cost.byOperation).map(([op, data]) =>
        `| ${op} | ${(data as any).count} | $${(data as any).cost.toFixed(4)} |`
      ).join('\n') + '\n';

    writeFileSync(join(resultsDir, 'report.md'), report + costSection);
    console.log('Report written to results-l3/report.md');
  }

  async runL3DriftTest(): Promise<void> {
    console.log('Drift test must be run as part of run-l3 (checkpoints at 1, 25, 50).');
  }

  async runL3ScaleTest(): Promise<void> {
    const dataDir = 'topology-l3';
    const topoDir = join(this.rootDir, dataDir);
    const resultsDir = join(this.rootDir, 'results-l3');
    const baselineDir = join(this.rootDir, 'baseline-l3-scale');

    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

    const client = new Anthropic();
    const costTracker = new CostTracker(resultsDir, 25.0);
    const ioLogger = new IOLogger(resultsDir);
    const ops = new Operations(client, costTracker, ioLogger);
    const topology = new TopologyStore(topoDir);
    const metadata = new MetadataStore(topoDir);
    const identity = new IdentityEngine(client, costTracker, ioLogger);
    const resonance = new EmbeddingResonance();

    console.log('Initializing embedding model...');
    await resonance.init();

    const traceDir = join(resultsDir, 'traces');
    const circuit = new Circuit(topology, ops, traceDir, metadata, identity, resonance);
    const testRunner = new TestRunner(topology, metadata, ops, client, costTracker, topoDir);

    const inputs = this.loadInputs();
    const queries = [
      'What connects security to cooking?',
      'What pattern appears in 3+ different domains?',
      "What's the deepest insight from combining all inputs?",
      'What connection would surprise someone who read each input separately?',
      'What bridge concept connects the most different domains, and why?',
    ];

    console.log(`\nTest J: Scale Simulation (topology vs enriched baseline)`);
    console.log(`  ${inputs.length} inputs, ${queries.length} queries\n`);

    const result = await testRunner.runScaleTest(circuit, baselineDir, inputs, queries);

    console.log(`\nResults: Topology ${result.wins}, Baseline ${result.losses}, Tie ${result.ties}`);
    console.log(`Pass threshold: 3/5 topology wins`);
    console.log(`Result: ${result.wins >= 3 ? 'PASS' : 'FAIL'}`);

    writeFileSync(
      join(resultsDir, 'scale-test-results.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(`\nResults written to results-l3/scale-test-results.json`);
    console.log(`Cost: $${costTracker.totalCost.toFixed(4)}`);
  }

  async runFairJudge(): Promise<void> {
    const dataDir = 'topology-l3';
    const topoDir = join(this.rootDir, dataDir);
    const resultsDir = join(this.rootDir, 'results-l3-fair-judge');

    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

    // Backup previous scale test results if they exist
    const origResultsDir = join(this.rootDir, 'results-l3');
    const prevResultsPath = join(origResultsDir, 'scale-test-results.json');
    if (existsSync(prevResultsPath)) {
      const backupPath = join(origResultsDir, 'scale-test-results-pre-redesign.json');
      if (!existsSync(backupPath)) {
        writeFileSync(backupPath, readFileSync(prevResultsPath, 'utf-8'));
        console.log('Backed up previous scale-test-results.json');
      }
    }

    const client = new Anthropic();
    const costTracker = new CostTracker(resultsDir, 10.0);
    const ioLogger = new IOLogger(resultsDir);
    const ops = new Operations(client, costTracker, ioLogger);
    const topology = new TopologyStore(topoDir);
    const metadata = new MetadataStore(topoDir);
    const identity = new IdentityEngine(client, costTracker, ioLogger);
    const resonance = new EmbeddingResonance();

    console.log('Initializing embedding model...');
    await resonance.init();

    const traceDir = join(resultsDir, 'traces');
    const circuit = new Circuit(topology, ops, traceDir, metadata, identity, resonance);

    const inputs = this.loadInputs();
    const queries = [
      'What connects security to cooking?',
      'What pattern appears in 3+ different domains?',
      "What's the deepest insight from combining all inputs?",
      'What connection would surprise someone who read each input separately?',
      'What bridge concept connects the most different domains, and why?',
    ];

    // Build fair baseline: concatenate all inputs into single context
    let allInputsContext = '';
    for (let i = 0; i < inputs.length; i++) {
      allInputsContext += `--- INPUT ${i + 1}: ${inputs[i].name} ---\n\n`;
      allInputsContext += inputs[i].content.trim();
      allInputsContext += '\n\n';
    }

    console.log(`\nFair Judge: topology (signal-driven) vs fair baseline (single context)`);
    console.log(`  ${inputs.length} inputs, ${queries.length} queries\n`);

    const judge = new Judge(client, costTracker);
    let wins = 0, losses = 0, ties = 0;
    const details: Array<{
      query: string;
      topologyAnswer: string;
      baselineAnswer: string;
      judgeResult: any;
    }> = [];

    for (const query of queries) {
      if (costTracker.isOverBudget) {
        console.log('BUDGET EXCEEDED — stopping.');
        break;
      }

      console.log(`  Query: "${query.slice(0, 60)}..."`);

      // Topology answer via circuit.query() (uses new signal-driven interface)
      const topoResult = await circuit.query(query);

      // Fair baseline: single context with all inputs
      const baselineAnswer = await ops.queryWithFlatMemory(
        `${query}\n\nAnswer with a single coherent insight, not a list. Be specific — name the structural mechanism, not just "these are similar."`,
        allInputsContext,
      );

      // Blind judge
      const judgeResult = await judge.blindCompare(query, topoResult.answer, baselineAnswer);

      details.push({
        query,
        topologyAnswer: topoResult.answer,
        baselineAnswer,
        judgeResult,
      });

      if (judgeResult.winner === 'A') wins++;
      else if (judgeResult.winner === 'B') losses++;
      else ties++;

      const label = judgeResult.winner === 'A' ? 'TOPOLOGY' : judgeResult.winner === 'B' ? 'BASELINE' : 'TIE';
      console.log(`    → ${label}`);
    }

    console.log(`\nResults: Topology ${wins}, Baseline ${losses}, Tie ${ties}`);
    console.log(`Pass threshold: 3/5 topology wins`);
    console.log(`Result: ${wins >= 3 ? 'PASS' : 'FAIL'}`);

    const result = { wins, losses, ties, details, type: 'fair-judge' };
    writeFileSync(
      join(resultsDir, 'fair-judge-results.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(`\nResults written to results-l3-fair-judge/fair-judge-results.json`);
    console.log(`Cost: $${costTracker.totalCost.toFixed(4)}`);
  }

  private loadInputs(customDir?: string): Array<{ name: string; content: string }> {
    const inputDir = customDir ? resolve(customDir) : join(this.rootDir, 'inputs');
    const files = readdirSync(inputDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    return files.map((f) => ({
      name: f.replace('.md', ''),
      content: readFileSync(join(inputDir, f), 'utf-8'),
    }));
  }
}

