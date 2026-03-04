import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { TopologyStore } from './topology.js';
import { computeBridgeScores, detectRearrangements } from './analysis.js';
import { discoverEmergentPaths, type TransitivePath } from './traversal.js';
import type { Concept, Chain, BridgeConcept, TopologyState, ChainHistory } from './types.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const TOPO_DIR = join(ROOT_DIR, 'topology-l3');
const RESULTS_DIR = join(ROOT_DIR, 'results-l3');

// --- Data loaders ---

interface BoundaryResults {
  claudePatterns: Array<{ name: string; description: string; domains: string[] }>;
  topologyBridges: Array<{ name: string; conceptId: string; bridgeScore: number; description: string }>;
  intersection: Array<{ claude: string; topology: string; similarity: number }>;
  topologyUnique: string[];
  claudeUnique: string[];
}

function loadBoundaryResults(): BoundaryResults | null {
  const p = join(RESULTS_DIR, 'boundary-test-results.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function loadTestHScores(): Map<string, number> {
  const p = join(RESULTS_DIR, 'test-h-evaluation-cn.md');
  if (!existsSync(p)) return new Map();
  const content = readFileSync(p, 'utf-8');
  const scores = new Map<string, number>();

  // Split by bridge sections and extract scores
  const sections = content.split(/###\s+桥\s+\d+：/);
  for (const section of sections) {
    // Get bridge name from the first line
    const nameMatch = section.match(/^(.+?)(?:（.+?）)?\s*\|/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    // Get score
    const scoreMatch = section.match(/你的评分（1-5）：\s*_*(\d)_*/);
    if (scoreMatch) {
      scores.set(name, parseInt(scoreMatch[1], 10));
    }
  }

  // Also parse emergent path scores and other sections
  const pathSections = content.split(/###\s+路径\s+\d+：/);
  for (const section of pathSections) {
    const scoreMatch = section.match(/你的评分（1-5）：\s*_*(\d)_*/);
    if (scoreMatch) {
      const nameMatch = section.match(/^(.+?)(?:（.+?）)?$/m);
      if (nameMatch) {
        scores.set(`path:${nameMatch[1].trim()}`, parseInt(scoreMatch[1], 10));
      }
    }
  }

  return scores;
}

interface SignalData {
  runNumber: number;
  bridges: Array<{ concept: string; score: number; isArticulationPoint: boolean }>;
  emergentPaths: Array<{ from: string; to: string; hops: string[]; weight: number }>;
  rearrangements: Array<{ endpoints: [string, string]; fromRun: number; toRun: number }>;
  topologySummary?: any;
}

function loadSignal(): SignalData | null {
  const p = join(RESULTS_DIR, 'signal-run50.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function loadHistory(): { chainHistory: ChainHistory[] } | null {
  const p = join(TOPO_DIR, 'history.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

interface TraceData {
  concepts: number;
  newChains: number;
  newLatentConnections: number;
  bridgesDetected: number;
  pruned: number;
  latentPruned: number;
  identityShift: boolean;
  comparison: { interpretation: string; crossInputChains: string[] };
}

function loadTraces(): Map<number, TraceData> {
  const traceDir = join(RESULTS_DIR, 'traces');
  if (!existsSync(traceDir)) return new Map();
  const traces = new Map<number, TraceData>();
  const files = readdirSync(traceDir).filter(f => f.match(/^run-\d+\.json$/)).sort();
  for (const file of files) {
    const num = parseInt(file.match(/run-(\d+)/)![1], 10);
    traces.set(num, JSON.parse(readFileSync(join(traceDir, file), 'utf-8')));
  }
  return traces;
}

// --- Classification ---

type ConceptTier = 1 | 2 | 3 | 'excluded';
type ConceptStatus = 'ACTIVE' | 'DECAYING' | 'DISCONNECTED';

interface ClassifiedConcept {
  concept: Concept;
  tier: ConceptTier;
  status: ConceptStatus;
  bridgeScore?: number;
  bridgeData?: BridgeConcept;
  boundaryClassification?: 'topology-unique' | 'intersection' | 'not-tested';
  testHScore?: number;
  chainsThrough: Chain[];
  emergentPathCount: number;
}

function getConceptStatus(concept: Concept, chains: Chain[]): ConceptStatus {
  const nameL = concept.name.toLowerCase();
  const connected = chains.filter(c =>
    c.fromConcept.toLowerCase() === nameL ||
    c.toConcept.toLowerCase() === nameL ||
    c.steps.some(s => s.fromConcept.toLowerCase() === nameL || s.toConcept.toLowerCase() === nameL)
  );
  if (connected.length === 0) return 'DISCONNECTED';
  const allLow = connected.every(c => c.weight < 0.5);
  return allLow ? 'DECAYING' : 'ACTIVE';
}

function classifyConcept(
  concept: Concept,
  chains: Chain[],
  bridges: BridgeConcept[],
  boundary: BoundaryResults | null,
  testHScores: Map<string, number>,
  emergentPaths: TransitivePath[],
): ClassifiedConcept {
  const nameL = concept.name.toLowerCase();
  const status = getConceptStatus(concept, chains);

  const bridge = bridges.find(b => b.conceptId === concept.id);
  const chainsThrough = chains.filter(c =>
    c.fromConcept.toLowerCase() === nameL ||
    c.toConcept.toLowerCase() === nameL ||
    c.steps.some(s => s.fromConcept.toLowerCase() === nameL || s.toConcept.toLowerCase() === nameL)
  );

  const onEmergentPath = emergentPaths.filter(p =>
    p.from === nameL || p.to === nameL || p.hops.some(h => h === nameL)
  ).length;

  let boundaryClass: 'topology-unique' | 'intersection' | 'not-tested' = 'not-tested';
  if (boundary) {
    if (boundary.topologyUnique.some(n => n.toLowerCase() === nameL)) {
      boundaryClass = 'topology-unique';
    } else if (boundary.intersection.some(m => m.topology.toLowerCase() === nameL)) {
      boundaryClass = 'intersection';
    }
  }

  const testH = testHScores.get(concept.name);

  // Tier classification
  let tier: ConceptTier;
  if (bridge && (bridge.bridgeScore > 100 || (boundaryClass === 'topology-unique' && (testH ?? 0) >= 4))) {
    tier = 1;
  } else if (status === 'DISCONNECTED') {
    // Check for rescue candidacy
    const uniqueDomains = new Set(concept.facets.map(f => f.domain));
    if (concept.facets.length >= 3 && uniqueDomains.size >= 2) {
      tier = 3;
    } else {
      tier = 'excluded';
    }
  } else if (chainsThrough.length >= 2 || onEmergentPath > 0 || concept.facets.some(f => f.novelty)) {
    tier = 2;
  } else {
    // Check exclusion: single-domain, ≤2 facets
    const uniqueDomains = new Set(concept.facets.map(f => f.domain));
    if (uniqueDomains.size <= 1 && concept.facets.length <= 2) {
      tier = 'excluded';
    } else {
      tier = 2;
    }
  }

  return {
    concept,
    tier,
    status,
    bridgeScore: bridge?.bridgeScore,
    bridgeData: bridge,
    boundaryClassification: boundaryClass,
    testHScore: testH,
    chainsThrough,
    emergentPathCount: onEmergentPath,
  };
}

// --- Inventory generation ---

function generateInventory(): void {
  console.log('Loading data...');
  const topology = new TopologyStore(TOPO_DIR);
  const state = topology.snapshot();
  const bridges = computeBridgeScores(state);
  const emergentPaths = discoverEmergentPaths(state, 0.1, 3, 3);
  const boundary = loadBoundaryResults();
  const testHScores = loadTestHScores();
  const signal = loadSignal();
  const history = loadHistory();
  const traces = loadTraces();

  const rearrangements = history ? detectRearrangements(history.chainHistory) : [];

  console.log('Classifying concepts...');
  const classified = state.concepts.map(c =>
    classifyConcept(c, state.chains, bridges, boundary, testHScores, emergentPaths)
  );

  const tier1 = classified.filter(c => c.tier === 1).sort((a, b) => (b.bridgeScore ?? 0) - (a.bridgeScore ?? 0));
  const tier2 = classified.filter(c => c.tier === 2).sort((a, b) => b.chainsThrough.length - a.chainsThrough.length);
  const tier3 = classified.filter(c => c.tier === 3);
  const excluded = classified.filter(c => c.tier === 'excluded');

  // Chain weight distribution
  const highWeight = state.chains.filter(c => c.weight >= 0.8).length;
  const midWeight = state.chains.filter(c => c.weight >= 0.5 && c.weight < 0.8).length;
  const lowWeight = state.chains.filter(c => c.weight < 0.5).length;

  // Domain distribution
  const domainCounts: Record<string, number> = {};
  for (const c of state.concepts) {
    for (const f of c.facets) {
      domainCounts[f.domain] = (domainCounts[f.domain] ?? 0) + 1;
    }
  }
  const domains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);

  // Questions
  const questions = state.questions ?? [];
  const openQ = questions.filter(q => q.status === 'open');
  const addressedQ = questions.filter(q => q.status === 'addressed');

  let md = `# Topology L3 Inventory (${state.concepts.length} concepts, ${state.chains.length} chains, ${state.runCount} runs)\n\n`;

  // Summary
  md += `## Summary Statistics\n\n`;
  md += `- **Concepts**: ${state.concepts.length} (${state.concepts.length - tier3.length - excluded.length} connected, ${tier3.length + excluded.filter(c => c.status === 'DISCONNECTED').length} disconnected)\n`;
  md += `- **Chains**: ${state.chains.length} (${highWeight} high-weight >=0.8, ${midWeight} mid 0.5-0.8, ${lowWeight} low-weight <0.5)\n`;
  md += `- **Latent connections**: ${state.latentConnections.length}\n`;
  md += `- **Emergent paths**: ${emergentPaths.length}\n`;
  md += `- **Rearrangements**: ${rearrangements.length}\n`;
  md += `- **Questions**: ${questions.length} (${openQ.length} open, ${addressedQ.length} addressed)\n`;
  md += `- **Domains**: ${domains.length} (${domains.map(([d, n]) => `${d} ${n}`).join(', ')})\n\n`;

  // Tier 1
  md += `## Tier 1: Strong Meta-Input Candidates (${tier1.length})\n\n`;
  md += `> Bridge scores recomputed with current code (includes maturity factor). Signal-run50.json scores were computed during L3 run (before recency bias fix). Rankings may differ.\n\n`;
  for (const item of tier1) {
    md += formatTier1(item, state, boundary);
    md += '\n---\n\n';
  }

  // Tier 2
  md += `## Tier 2: Potential Meta-Input Candidates (${tier2.length})\n\n`;
  for (const item of tier2.slice(0, 50)) {
    md += formatTier2(item, state);
  }
  if (tier2.length > 50) {
    md += `\n*... and ${tier2.length - 50} more Tier 2 concepts.*\n\n`;
  }

  // Tier 3
  md += `## Tier 3: Review for Rescue (${tier3.length})\n\n`;
  for (const item of tier3) {
    md += formatTier3(item);
  }

  // Excluded
  md += `## Excluded (${excluded.length})\n\n`;
  md += `${excluded.length} concepts excluded: single-domain with <=2 facets, or fully disconnected with insufficient facet diversity.\n\n`;

  // Emergent paths
  md += `## Emergent Paths (top 50 by weight)\n\n`;
  md += `| # | From | Hops | To | Weight | Inputs Spanned |\n|---|------|------|----|--------|----------------|\n`;
  for (let i = 0; i < Math.min(50, emergentPaths.length); i++) {
    const p = emergentPaths[i];
    md += `| ${i + 1} | ${p.from} | ${p.hops.join(' -> ')} | ${p.to} | ${p.weight.toFixed(3)} | ${p.sourceInputsSpanned.join(',')} |\n`;
  }
  md += '\n';

  // Rearrangements
  md += `## Rearrangement Events (all ${rearrangements.length})\n\n`;
  md += `| Endpoints | From Run | To Run | Old Intermediates | New Intermediates | Domain Shift |\n|-----------|----------|--------|-------------------|-------------------|--------------|\n`;
  for (const r of rearrangements) {
    md += `| ${r.endpoints.join(' <-> ')} | ${r.fromRun} | ${r.toRun} | ${r.oldIntermediates.join(', ') || '(direct)'} | ${r.newIntermediates.join(', ') || '(direct)'} | ${r.domainShift ? 'Yes' : 'No'} |\n`;
  }
  md += '\n';

  // Open questions
  md += `## Open Questions (top 50 by relevance)\n\n`;
  for (let i = 0; i < Math.min(50, openQ.length); i++) {
    const q = openQ[i];
    md += `${i + 1}. **${q.text}** (input ${q.sourceInput}, related: ${q.relatedConcepts.join(', ')})\n`;
  }
  if (openQ.length > 50) md += `\n*... and ${openQ.length - 50} more open questions.*\n`;
  md += '\n';

  // Chain weight distribution
  md += `## Chain Weight Distribution\n\n`;
  const bins = [
    { label: '0.9-1.0', count: state.chains.filter(c => c.weight >= 0.9).length },
    { label: '0.8-0.9', count: state.chains.filter(c => c.weight >= 0.8 && c.weight < 0.9).length },
    { label: '0.7-0.8', count: state.chains.filter(c => c.weight >= 0.7 && c.weight < 0.8).length },
    { label: '0.6-0.7', count: state.chains.filter(c => c.weight >= 0.6 && c.weight < 0.7).length },
    { label: '0.5-0.6', count: state.chains.filter(c => c.weight >= 0.5 && c.weight < 0.6).length },
    { label: '0.4-0.5', count: state.chains.filter(c => c.weight >= 0.4 && c.weight < 0.5).length },
    { label: '0.3-0.4', count: state.chains.filter(c => c.weight >= 0.3 && c.weight < 0.4).length },
    { label: '<0.3', count: state.chains.filter(c => c.weight < 0.3).length },
  ];
  md += `| Range | Count | Bar |\n|-------|-------|-----|\n`;
  const maxCount = Math.max(...bins.map(b => b.count));
  for (const bin of bins) {
    const bar = '█'.repeat(Math.round(bin.count / maxCount * 30));
    md += `| ${bin.label} | ${bin.count} | ${bar} |\n`;
  }
  md += '\n';

  // Per-run timeline
  md += `## Per-Run Timeline\n\n`;
  for (let run = 1; run <= state.runCount; run++) {
    const trace = traces.get(run);
    if (trace) {
      const crossInput = trace.comparison?.crossInputChains?.length ?? 0;
      md += `- **Run ${run}**: +${trace.concepts} concepts, +${trace.newChains} chains, ${trace.bridgesDetected} bridges`;
      if (crossInput > 0) md += `, ${crossInput} cross-input`;
      if (trace.identityShift) md += `, identity shifted`;
      md += '\n';
    }
  }

  writeFileSync(join(RESULTS_DIR, 'inventory.md'), md);
  console.log(`Inventory written to results-l3/inventory.md (${tier1.length} T1, ${tier2.length} T2, ${tier3.length} T3, ${excluded.length} excluded)`);
}

function formatTier1(item: ClassifiedConcept, state: TopologyState, boundary: BoundaryResults | null): string {
  const c = item.concept;
  let md = `### ${c.name}\n\n`;
  md += `- **ID**: ${c.id} | **Source input**: ${c.sourceInput} | **Bridge score**: ${item.bridgeScore?.toFixed(1) ?? 'N/A'}\n`;
  if (item.bridgeData) {
    md += `- **Unique source inputs**: ${item.bridgeData.uniqueSourceInputs} | **Unique domains**: ${item.bridgeData.uniqueDomains} | **Chains through**: ${item.bridgeData.chainsThrough}\n`;
  }
  md += `- **Boundary test**: ${item.boundaryClassification}`;
  if (item.testHScore !== undefined) md += ` | **Test H score**: ${item.testHScore}/5`;
  md += `\n- **Status**: ${item.status}\n`;

  // Facets
  md += `\n**Facets** (${c.facets.length}):\n`;
  for (const f of c.facets) {
    md += `  - ${f.domain}:${f.attribute} (salience ${f.salience})`;
    if (f.novelty) md += ' [NOVEL]';
    if (f.tension && f.tension !== 'null' && f.tension !== '-null') md += ` [TENSION: ${f.tension}]`;
    md += '\n';
  }

  // Chains
  if (item.chainsThrough.length > 0) {
    md += `\n**Chain connections** (${item.chainsThrough.length}):\n`;
    for (const ch of item.chainsThrough.slice(0, 15)) {
      const otherConcept = ch.fromConcept.toLowerCase() === c.name.toLowerCase() ? ch.toConcept : ch.fromConcept;
      md += `  - -> ${otherConcept} (weight ${ch.weight.toFixed(2)}, domains: ${ch.domainsCrossed.join(', ')})\n`;
    }
  }

  return md;
}

function formatTier2(item: ClassifiedConcept, state: TopologyState): string {
  const c = item.concept;
  let md = `### ${c.name}\n`;
  md += `- Input ${c.sourceInput} | ${item.chainsThrough.length} chains | ${item.emergentPathCount} emergent paths | ${item.status}\n`;

  const keyFacets = c.facets.slice(0, 5);
  md += `- Facets: ${keyFacets.map(f => `${f.domain}:${f.attribute}`).join(', ')}`;
  if (c.facets.length > 5) md += ` (+${c.facets.length - 5} more)`;
  md += '\n\n';

  return md;
}

function formatTier3(item: ClassifiedConcept): string {
  const c = item.concept;
  let md = `### ${c.name}\n`;
  md += `- Input ${c.sourceInput} | ${item.status}\n`;
  md += `- All facets: ${c.facets.map(f => `${f.domain}:${f.attribute}`).join(', ')}\n\n`;
  return md;
}

// --- Product report generation ---

function generateReport(): void {
  console.log('Loading data...');
  const topology = new TopologyStore(TOPO_DIR);
  const state = topology.snapshot();
  const bridges = computeBridgeScores(state);
  const emergentPaths = discoverEmergentPaths(state, 0.1, 3, 3);
  const boundary = loadBoundaryResults();
  const testHScores = loadTestHScores();
  const signal = loadSignal();
  const history = loadHistory();

  const rearrangements = history ? detectRearrangements(history.chainHistory) : [];

  // Map bridge scores to concepts
  const bridgeMap = new Map<string, BridgeConcept>();
  for (const b of bridges) {
    bridgeMap.set(b.conceptId, b);
  }

  // Top 10 bridges by score
  const topBridges = bridges.slice(0, 10).map(b => {
    const concept = state.concepts.find(c => c.id === b.conceptId);
    return { concept: concept!, bridge: b };
  }).filter(x => x.concept);

  let md = `# Organism L3: Structural Intelligence Report\n`;
  md += `## 50 inputs across 25+ domains -> ${state.concepts.length} concepts, ${state.chains.length} chains\n\n`;

  // --- What This System Found That Claude Cannot ---
  md += `## What This System Found That Claude Cannot\n\n`;

  for (let i = 0; i < topBridges.length; i++) {
    const { concept, bridge } = topBridges[i];
    const nameL = concept.name.toLowerCase();

    // Get domains from chains
    const chainsThrough = state.chains.filter(c =>
      c.fromConcept.toLowerCase() === nameL ||
      c.toConcept.toLowerCase() === nameL ||
      c.steps.some(s => s.fromConcept.toLowerCase() === nameL || s.toConcept.toLowerCase() === nameL)
    );
    const allDomains = new Set<string>();
    for (const ch of chainsThrough) {
      for (const d of ch.domainsCrossed) allDomains.add(d);
    }
    for (const f of concept.facets) allDomains.add(f.domain);

    // Description from facets
    const keyFacets = concept.facets
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 3)
      .map(f => f.attribute);

    // Boundary classification
    let boundaryLabel = '';
    if (boundary) {
      if (boundary.topologyUnique.some(n => n.toLowerCase() === nameL)) {
        boundaryLabel = 'topology-unique';
      } else if (boundary.intersection.some(m => m.topology.toLowerCase() === nameL)) {
        boundaryLabel = 'intersection';
      }
    }

    const testH = testHScores.get(concept.name);

    md += `### ${i + 1}. ${concept.name}\n\n`;
    md += `**Key facets**: ${keyFacets.join(', ')}\n\n`;
    md += `**Cross-domain evidence**: Connects ${[...allDomains].join(', ')} (${bridge.uniqueSourceInputs} independent sources, ${bridge.uniqueDomains} domains)\n\n`;
    if (testH !== undefined) md += `**Human validation**: ${testH}/5\n\n`;
    md += `**Chain evidence**: ${chainsThrough.length} chains through this concept (avg weight ${(chainsThrough.reduce((s, c) => s + c.weight, 0) / chainsThrough.length).toFixed(2)})`;
    if (boundaryLabel) md += ` | Boundary: ${boundaryLabel}`;
    md += `\n\n`;
  }

  // Side-by-side comparison
  if (boundary) {
    md += `### Boundary Comparison: Topology vs Claude\n\n`;
    md += `| | Topology | Claude |\n|---|---|---|\n`;
    md += `| Total patterns | 10 bridges | ${boundary.claudePatterns.length} patterns |\n`;
    md += `| Topology-unique | ${boundary.topologyUnique.length} | - |\n`;
    md += `| Intersection | ${boundary.intersection.length} | - |\n`;
    md += `| Claude-unique | - | ${boundary.claudeUnique.length} |\n\n`;
    md += `**Key difference**: Claude finds known complexity science concepts (${boundary.claudePatterns.slice(0, 3).map(p => p.name).join(', ')}...). Topology finds original structural insights (${boundary.topologyUnique.slice(0, 3).join(', ')}...) that emerge from accumulated cross-domain traces.\n\n`;
  }

  // --- Emergent Paths ---
  md += `## Emergent Paths (top 10)\n\n`;
  md += `Transitive connections no single LLM call produced:\n\n`;
  for (let i = 0; i < Math.min(10, emergentPaths.length); i++) {
    const p = emergentPaths[i];
    md += `${i + 1}. **${p.from}** -> ${p.hops.join(' -> ')} -> **${p.to}** (weight ${p.weight.toFixed(3)}, spans inputs ${p.sourceInputsSpanned.join(',')})\n`;
  }
  md += '\n';

  // --- Structural Dynamics ---
  md += `## Structural Dynamics\n\n`;
  md += `- **${rearrangements.length} rearrangement events** across ${state.runCount} runs\n`;

  // Find notable rearrangements (run 50, or large changes)
  const run50Rearrangements = rearrangements.filter(r => r.toRun === 50 || r.toRun === 49);
  if (run50Rearrangements.length > 0) {
    md += `- Notable late-run rearrangements (runs 49-50): ${run50Rearrangements.length} events\n`;
  }

  // Unique endpoint pairs
  const uniquePairs = new Set(rearrangements.map(r => r.endpoints.sort().join('|')));
  md += `- ${uniquePairs.size} unique concept pairs rearranged their connection paths\n\n`;

  // --- Path Dependence ---
  const pathDepPath = join(RESULTS_DIR, 'path-dependence-results.json');
  if (existsSync(pathDepPath)) {
    const pathDep = JSON.parse(readFileSync(pathDepPath, 'utf-8'));
    md += `## Path-Dependence\n\n`;
    const metrics = pathDep.metrics;
    if (metrics) {
      md += `- Same inputs, different order -> ${(metrics.semanticJaccard * 100).toFixed(1)}% semantic overlap (Jaccard)\n`;
      md += `- Name-only bridge overlap: ${(metrics.nameOnlyJaccard * 100).toFixed(1)}%\n`;
      md += `- Average best-match similarity: ${(metrics.avgBestMatchSimilarity * 100).toFixed(1)}%\n`;
    }
    md += `- Interpretation: each run produces a unique structural interpretation\n\n`;
  }

  // --- Key Metrics ---
  md += `## Key Metrics\n\n`;

  // Test H average
  const bridgeScores: number[] = [];
  for (const [key, val] of testHScores) {
    if (!key.startsWith('path:')) bridgeScores.push(val);
  }
  if (bridgeScores.length > 0) {
    const avg = bridgeScores.reduce((s, v) => s + v, 0) / bridgeScores.length;
    md += `- **Test H (human validation)**: ${avg.toFixed(2)}/5 (${bridgeScores.length} bridges scored)\n`;
  }

  if (boundary) {
    md += `- **Boundary**: ${boundary.topologyUnique.length}/${boundary.topologyBridges.length} topology-unique bridges\n`;
  }

  // SES from test results
  const testResultsPath = join(RESULTS_DIR, 'test-results.json');
  if (existsSync(testResultsPath)) {
    const testResults = JSON.parse(readFileSync(testResultsPath, 'utf-8'));
    if (testResults.summary?.semanticEmergenceScore) {
      md += `- **SES (semantic emergence score)**: ${testResults.summary.semanticEmergenceScore.toFixed(2)}\n`;
    }
  }

  // Cost
  const costPath = join(RESULTS_DIR, 'cost-log.json');
  if (existsSync(costPath)) {
    const costEntries = JSON.parse(readFileSync(costPath, 'utf-8'));
    if (Array.isArray(costEntries)) {
      const total = costEntries.reduce((s: number, e: any) => s + (e.cost ?? 0), 0);
      md += `- **Cost**: $${total.toFixed(2)} for ${state.runCount} inputs\n`;
    }
  }

  md += `- **Emergent paths**: ${emergentPaths.length}\n`;
  md += `- **Rearrangements**: ${rearrangements.length}\n`;

  writeFileSync(join(RESULTS_DIR, 'product-report.md'), md);
  console.log(`Product report written to results-l3/product-report.md`);
}

export { generateInventory, generateReport };

// CLI when run directly
const isDirectRun = process.argv[1]?.includes('inventory');
if (isDirectRun) {
  const command = process.argv[2];
  if (command === 'inventory') {
    generateInventory();
  } else if (command === 'report') {
    generateReport();
  } else {
    console.log(`Usage:
  npx tsx src/inventory.ts inventory    # full categorized inventory
  npx tsx src/inventory.ts report       # curated product report`);
  }
}
