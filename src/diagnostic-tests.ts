import { resolve, join } from 'path';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { TopologyStore } from './topology.js';
import { CostTracker } from './cost.js';
import { EmbeddingResonance } from './resonance.js';
import { computeBridgeScores } from './analysis.js';
import { withRetry } from './operations.js';
import type { TopologyState, Concept, BridgeConcept } from './types.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const RESULTS_DIR = join(ROOT_DIR, 'results-l3');
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

// --- Shared helpers ---

interface EnrichedBridge {
  name: string;
  conceptId: string;
  bridgeScore: number;
  description: string; // "name: domain:attr, domain:attr, domain:attr"
}

interface MatchResult {
  indexA: number;
  indexB: number;
  similarity: number;
}

interface ClaudePattern {
  name: string;
  description: string;
  domains: string[];
}

function enrichBridge(concept: Concept, bridgeScore: number): EnrichedBridge {
  const topFacets = [...concept.facets]
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 3);
  const facetStr = topFacets.map(f => `${f.domain}:${f.attribute}`).join(', ');
  return {
    name: concept.name,
    conceptId: concept.id,
    bridgeScore,
    description: `${concept.name}: ${facetStr}`,
  };
}

function getTopBridges(topology: TopologyState, count: number): EnrichedBridge[] {
  const scores = computeBridgeScores(topology);
  const top = scores.slice(0, count);
  return top.map(b => {
    const concept = topology.concepts.find(c => c.id === b.conceptId);
    if (!concept) throw new Error(`Concept ${b.conceptId} not found in topology`);
    return enrichBridge(concept, b.bridgeScore);
  });
}

function greedyMatch(
  matrixRows: number, // items in set A
  matrixCols: number, // items in set B
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

async function llmJudgePair(
  a: string,
  b: string,
  client: Anthropic,
  costTracker: CostTracker,
): Promise<{ score: number; explanation: string }> {
  const resp = await withRetry(() =>
    client.messages.create({
      model: HAIKU,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Concept A: "${a}"\nConcept B: "${b}"\n\nDo these capture the same underlying structural pattern? Rate 1-5:\n1 = Completely different\n3 = Same phenomenon from different angles\n5 = Same concept, different name\n\nRespond with just the number and one sentence explanation. Format: N: explanation`,
      }],
    })
  );

  const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
  costTracker.record('diagnostic-judge', HAIKU, resp.usage.input_tokens, resp.usage.output_tokens);

  const match = text.match(/^(\d):\s*(.+)/);
  if (match) {
    return { score: parseInt(match[1], 10), explanation: match[2].trim() };
  }
  return { score: 3, explanation: text.trim() };
}

function loadInputs(): Array<{ name: string; content: string }> {
  const inputDir = join(ROOT_DIR, 'inputs');
  const files = readdirSync(inputDir).filter(f => f.endsWith('.md')).sort();
  return files.map(f => ({
    name: f.replace('.md', ''),
    content: readFileSync(join(inputDir, f), 'utf-8'),
  }));
}

// --- Test 1: Capability Boundary ---

async function runBoundaryTest() {
  console.log('\n=== TEST 1: CAPABILITY BOUNDARY ===\n');

  const client = new Anthropic();
  const costTracker = new CostTracker(RESULTS_DIR, 5.0);
  const resonance = new EmbeddingResonance();
  await resonance.init();

  // Step 1: Get Claude's patterns from all 50 inputs
  console.log('Step 1: Asking Claude to find cross-domain patterns in all 50 inputs...');
  const inputs = loadInputs();

  let concatenated = '';
  for (let i = 0; i < inputs.length; i++) {
    concatenated += `--- INPUT ${i + 1}: ${inputs[i].name} ---\n\n`;
    concatenated += inputs[i].content.trim();
    concatenated += '\n\n';
  }

  const prompt = `I'm giving you ${inputs.length} short texts from different domains.

Read all of them, then identify the cross-domain structural patterns you see.

For each pattern:
- Give it a concise name (2-5 words)
- Describe the structural mechanism it captures (1-2 sentences)
- List which domains it connects

Output JSON:
{
  "patterns": [
    {
      "name": "...",
      "description": "...",
      "domains": ["...", "..."]
    }
  ]
}

Find as many genuine patterns as you can. Be specific about the structural property, not just "these are similar."

${concatenated}`;

  const resp = await withRetry(() =>
    client.messages.create({
      model: SONNET,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    })
  );

  costTracker.record('diagnostic-boundary-claude', SONNET, resp.usage.input_tokens, resp.usage.output_tokens);
  console.log(`  API cost: $${((resp.usage.input_tokens / 1000) * 0.003 + (resp.usage.output_tokens / 1000) * 0.015).toFixed(4)}`);

  const responseText = resp.content[0].type === 'text' ? resp.content[0].text : '';

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('Failed to extract JSON from Claude response');
    console.log('Raw response:', responseText.slice(0, 500));
    return;
  }

  let claudePatterns: ClaudePattern[];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    claudePatterns = parsed.patterns;
  } catch (e) {
    // Attempt to recover truncated JSON: find the last complete object in the array
    console.log('  JSON truncated, attempting recovery...');
    const raw = jsonMatch[0];
    const lastCompleteObj = raw.lastIndexOf('}');
    if (lastCompleteObj === -1) {
      console.error('Failed to recover truncated JSON');
      return;
    }
    // Find the array start and close it
    const arrayStart = raw.indexOf('[');
    if (arrayStart === -1) {
      console.error('Failed to find patterns array');
      return;
    }
    // Walk backwards from lastCompleteObj to find the last complete pattern entry
    let depth = 0;
    let cutPoint = lastCompleteObj;
    for (let i = lastCompleteObj; i >= arrayStart; i--) {
      if (raw[i] === '}') depth++;
      if (raw[i] === '{') depth--;
      if (depth === 0 && raw[i] === '}') {
        cutPoint = i + 1;
        break;
      }
    }
    const repaired = raw.slice(0, arrayStart) + raw.slice(arrayStart, cutPoint) + ']}';
    try {
      const parsed = JSON.parse(repaired);
      claudePatterns = parsed.patterns;
      console.log(`  Recovered ${claudePatterns.length} patterns from truncated response`);
    } catch (e2) {
      console.error('Failed to recover truncated JSON:', e2);
      return;
    }
  }

  console.log(`  Claude found ${claudePatterns.length} patterns`);

  // Step 2: Get topology's top 10 bridges
  console.log('\nStep 2: Loading topology bridges...');
  const store = new TopologyStore(join(ROOT_DIR, 'topology-l3'));
  const topology = store.snapshot();
  const topBridges = getTopBridges(topology, 10);

  console.log('  Top 10 topology bridges:');
  for (const b of topBridges) {
    console.log(`    ${b.name} (score: ${b.bridgeScore.toFixed(2)})`);
  }

  // Step 3: Embed and compute similarity matrix
  console.log('\nStep 3: Computing embedding similarity matrix...');

  const claudeTexts = claudePatterns.map(p => `${p.name}: ${p.description}`);
  const bridgeTexts = topBridges.map(b => b.description);

  const claudeEmbeddings = await Promise.all(claudeTexts.map(t => resonance.embed(t)));
  const bridgeEmbeddings = await Promise.all(bridgeTexts.map(t => resonance.embed(t)));

  // Full similarity matrix
  const matrix: number[][] = [];
  for (let i = 0; i < claudeEmbeddings.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < bridgeEmbeddings.length; j++) {
      row.push(EmbeddingResonance.cosineSimilarity(claudeEmbeddings[i], bridgeEmbeddings[j]));
    }
    matrix.push(row);
  }

  // Step 4: Greedy matching
  console.log('\nStep 4: Greedy matching (threshold 0.55)...');
  const matches = greedyMatch(
    claudePatterns.length,
    topBridges.length,
    (i, j) => matrix[i][j],
    0.55,
  );

  // Step 5: LLM judge for ambiguous pairs (0.55-0.70)
  console.log('\nStep 5: LLM judge for ambiguous matches...');
  const judgedMatches: Array<{
    claudePattern: ClaudePattern;
    bridge: EnrichedBridge;
    similarity: number;
    judge?: { score: number; explanation: string };
  }> = [];

  for (const m of matches) {
    const entry: typeof judgedMatches[0] = {
      claudePattern: claudePatterns[m.indexA],
      bridge: topBridges[m.indexB],
      similarity: m.similarity,
    };

    if (m.similarity >= 0.55 && m.similarity < 0.70) {
      console.log(`  Judging: "${claudePatterns[m.indexA].name}" vs "${topBridges[m.indexB].name}" (sim: ${m.similarity.toFixed(3)})`);
      entry.judge = await llmJudgePair(
        claudeTexts[m.indexA],
        bridgeTexts[m.indexB],
        client,
        costTracker,
      );
      console.log(`    Judge: ${entry.judge.score}/5 — ${entry.judge.explanation}`);
    }

    judgedMatches.push(entry);
  }

  // Categorize
  const matchedBridgeIndices = new Set(matches.map(m => m.indexB));
  const matchedClaudeIndices = new Set(matches.map(m => m.indexA));

  // Refine: remove matches where judge scored 1-2
  const confirmedMatches = judgedMatches.filter(m => !m.judge || m.judge.score >= 3);
  const rejectedMatches = judgedMatches.filter(m => m.judge && m.judge.score < 3);

  // Recalculate after rejections
  const confirmedBridgeIndices = new Set(confirmedMatches.map(m => topBridges.indexOf(m.bridge)));
  const confirmedClaudeIndices = new Set(confirmedMatches.map(m => claudePatterns.indexOf(m.claudePattern)));

  const topologyUnique = topBridges.filter((_, i) => !confirmedBridgeIndices.has(i));
  const claudeUnique = claudePatterns.filter((_, i) => !confirmedClaudeIndices.has(i));
  const intersection = confirmedMatches;

  // Output
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS: CAPABILITY BOUNDARY TEST');
  console.log('='.repeat(60));

  console.log(`\nClaude patterns: ${claudePatterns.length}`);
  console.log(`Topology bridges: ${topBridges.length}`);
  console.log(`\nIntersection (${intersection.length}):`);
  for (const m of intersection) {
    console.log(`  Claude "${m.claudePattern.name}" ≈ Topology "${m.bridge.name}" (sim: ${m.similarity.toFixed(3)}${m.judge ? `, judge: ${m.judge.score}/5` : ''})`);
  }

  console.log(`\nTopology-unique (${topologyUnique.length}):`);
  for (const b of topologyUnique) {
    // Find best Claude match even below threshold
    const bestMatch = claudePatterns.reduce((best, p, i) => {
      const idx = topBridges.indexOf(b);
      const sim = matrix[i][idx];
      return sim > best.sim ? { pattern: p, sim } : best;
    }, { pattern: claudePatterns[0], sim: 0 });
    console.log(`  ${b.name} (best Claude match: "${bestMatch.pattern.name}" at ${bestMatch.sim.toFixed(3)})`);
  }

  console.log(`\nClaude-unique (${claudeUnique.length}):`);
  for (const p of claudeUnique) {
    console.log(`  ${p.name}: ${p.description}`);
  }

  // Interpretation
  const topUniqueCount = topologyUnique.length;
  console.log('\nInterpretation:');
  if (topUniqueCount >= 5) {
    console.log('  → Topology genuinely discovers patterns Claude cannot see natively');
  } else if (topUniqueCount >= 2) {
    console.log('  → Mixed — topology adds some value, partially redundant');
  } else {
    console.log('  → Topology is largely redundant with full-context Claude');
  }

  // Check if the three 5/5-scored bridges are topology-unique
  const highValueBridges = ['Keystone Vulnerability', 'Distributed Tacit Signal', 'Structural Opacity'];
  const highValueUnique = topologyUnique.filter(b =>
    highValueBridges.some(hv => b.name.toLowerCase().includes(hv.toLowerCase()))
  );
  if (highValueUnique.length > 0) {
    console.log(`  → ${highValueUnique.length}/3 high-value bridges (${highValueUnique.map(b => b.name).join(', ')}) are topology-unique`);
  }

  // Save results
  const results = {
    timestamp: new Date().toISOString(),
    claudePatterns,
    topologyBridges: topBridges,
    similarityMatrix: matrix,
    matches: judgedMatches.map(m => ({
      claudePattern: m.claudePattern.name,
      bridge: m.bridge.name,
      similarity: m.similarity,
      judgeScore: m.judge?.score,
      judgeExplanation: m.judge?.explanation,
    })),
    intersection: intersection.map(m => ({ claude: m.claudePattern.name, topology: m.bridge.name, similarity: m.similarity })),
    topologyUnique: topologyUnique.map(b => b.name),
    claudeUnique: claudeUnique.map(p => p.name),
    rejectedMatches: rejectedMatches.map(m => ({ claude: m.claudePattern.name, topology: m.bridge.name, similarity: m.similarity, judgeScore: m.judge?.score })),
    cost: costTracker.summarize(),
  };

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, 'boundary-test-results.json'), JSON.stringify(results, null, 2));
  console.log(`\nResults saved to results-l3/boundary-test-results.json`);
  console.log(`Total cost: $${costTracker.totalCost.toFixed(4)}`);
}

// --- Test 2: Semantic Path-Dependence ---

async function runPathDependenceTest() {
  console.log('\n=== TEST 2: SEMANTIC PATH-DEPENDENCE ===\n');

  const client = new Anthropic();
  const costTracker = new CostTracker(RESULTS_DIR, 5.0);
  const resonance = new EmbeddingResonance();
  await resonance.init();

  // Step 1: Load both topologies and get top 10 bridges from each
  console.log('Step 1: Loading topologies and extracting bridges...');

  const originalStore = new TopologyStore(join(ROOT_DIR, 'topology-l3'));
  const shuffledStore = new TopologyStore(join(ROOT_DIR, 'topology-l3-pilot-shuffled-10'));

  const originalTopology = originalStore.snapshot();
  const shuffledTopology = shuffledStore.snapshot();

  console.log(`  Original: ${originalTopology.concepts.length} concepts, ${originalTopology.chains.length} chains, ${originalTopology.runCount} runs`);
  console.log(`  Shuffled: ${shuffledTopology.concepts.length} concepts, ${shuffledTopology.chains.length} chains, ${shuffledTopology.runCount} runs`);

  const originalBridges = getTopBridges(originalTopology, 10);
  const shuffledBridges = getTopBridges(shuffledTopology, 10);

  console.log('\n  Original top 10 bridges:');
  for (const b of originalBridges) {
    console.log(`    ${b.name} (score: ${b.bridgeScore.toFixed(2)})`);
  }

  console.log('\n  Shuffled top 10 bridges:');
  for (const b of shuffledBridges) {
    console.log(`    ${b.name} (score: ${b.bridgeScore.toFixed(2)})`);
  }

  // Step 2: Embed and compute 10x10 similarity matrix
  console.log('\nStep 2: Computing 10×10 similarity matrix...');

  const originalTexts = originalBridges.map(b => b.description);
  const shuffledTexts = shuffledBridges.map(b => b.description);

  const originalEmb = await Promise.all(originalTexts.map(t => resonance.embed(t)));
  const shuffledEmb = await Promise.all(shuffledTexts.map(t => resonance.embed(t)));

  const matrix: number[][] = [];
  for (let i = 0; i < originalEmb.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < shuffledEmb.length; j++) {
      row.push(EmbeddingResonance.cosineSimilarity(originalEmb[i], shuffledEmb[j]));
    }
    matrix.push(row);
  }

  // Print matrix as text table
  console.log('\nSimilarity Matrix (Original × Shuffled):');

  // Header: abbreviated shuffled names
  const abbrev = (name: string, len: number) => name.length > len ? name.slice(0, len - 1) + '…' : name.padEnd(len);
  const colWidth = 8;
  const nameWidth = 30;

  let header = ''.padEnd(nameWidth) + ' | ';
  for (let j = 0; j < shuffledBridges.length; j++) {
    header += `S${j}`.padStart(colWidth);
  }
  console.log(header);
  console.log('-'.repeat(header.length));

  for (let i = 0; i < originalBridges.length; i++) {
    let row = abbrev(originalBridges[i].name, nameWidth) + ' | ';
    for (let j = 0; j < shuffledBridges.length; j++) {
      const sim = matrix[i][j];
      row += sim.toFixed(3).padStart(colWidth);
    }
    console.log(row);
  }

  // Legend
  console.log('\nShuffled bridge legend:');
  for (let j = 0; j < shuffledBridges.length; j++) {
    console.log(`  S${j}: ${shuffledBridges[j].name}`);
  }

  // Step 3: Greedy matching
  console.log('\nStep 3: Greedy matching (threshold 0.45)...');
  const matches = greedyMatch(
    originalBridges.length,
    shuffledBridges.length,
    (i, j) => matrix[i][j],
    0.45,
  );

  console.log(`  Found ${matches.length} matches above threshold`);
  for (const m of matches) {
    console.log(`    "${originalBridges[m.indexA].name}" ↔ "${shuffledBridges[m.indexB].name}" (sim: ${m.similarity.toFixed(3)})`);
  }

  // Step 4: LLM judge for ambiguous pairs (0.45-0.65)
  console.log('\nStep 4: LLM judge for ambiguous matches...');
  const judgedMatches: Array<{
    original: EnrichedBridge;
    shuffled: EnrichedBridge;
    similarity: number;
    judge?: { score: number; explanation: string };
  }> = [];

  for (const m of matches) {
    const entry: typeof judgedMatches[0] = {
      original: originalBridges[m.indexA],
      shuffled: shuffledBridges[m.indexB],
      similarity: m.similarity,
    };

    if (m.similarity >= 0.45 && m.similarity < 0.65) {
      console.log(`  Judging: "${originalBridges[m.indexA].name}" vs "${shuffledBridges[m.indexB].name}" (sim: ${m.similarity.toFixed(3)})`);
      entry.judge = await llmJudgePair(
        originalTexts[m.indexA],
        shuffledTexts[m.indexB],
        client,
        costTracker,
      );
      console.log(`    Judge: ${entry.judge.score}/5 — ${entry.judge.explanation}`);
    }

    judgedMatches.push(entry);
  }

  // Step 5: Compute metrics
  const matchedOriginalIndices = new Set(matches.map(m => m.indexA));
  const matchedShuffledIndices = new Set(matches.map(m => m.indexB));

  const unmatchedOriginal = originalBridges.filter((_, i) => !matchedOriginalIndices.has(i));
  const unmatchedShuffled = shuffledBridges.filter((_, i) => !matchedShuffledIndices.has(i));

  // Avg best-match similarity (including all, not just above threshold)
  let sumBestMatch = 0;
  for (let i = 0; i < originalBridges.length; i++) {
    let bestSim = 0;
    for (let j = 0; j < shuffledBridges.length; j++) {
      if (matrix[i][j] > bestSim) bestSim = matrix[i][j];
    }
    sumBestMatch += bestSim;
  }
  const avgBestMatch = sumBestMatch / originalBridges.length;

  const matchCoverage = matches.length / 10;
  const semanticJaccard = matches.filter(m => m.similarity >= 0.55).length /
    (originalBridges.length + shuffledBridges.length - matches.filter(m => m.similarity >= 0.55).length);

  // Output
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS: SEMANTIC PATH-DEPENDENCE TEST');
  console.log('='.repeat(60));

  console.log('\nMetrics:');
  console.log(`  Name-only Jaccard:              0% (previously computed)`);
  console.log(`  Avg best-match similarity:      ${avgBestMatch.toFixed(3)}`);
  console.log(`  Match coverage:                 ${(matchCoverage * 100).toFixed(0)}% (${matches.length}/10)`);
  console.log(`  Semantic Jaccard (sim ≥ 0.55):  ${(semanticJaccard * 100).toFixed(1)}%`);

  console.log(`\nMatched pairs (${matches.length}):`);
  for (const m of judgedMatches) {
    const judgeStr = m.judge ? ` [judge: ${m.judge.score}/5]` : '';
    console.log(`  "${m.original.name}" ↔ "${m.shuffled.name}" (sim: ${m.similarity.toFixed(3)}${judgeStr})`);
  }

  console.log(`\nUnmatched original (${unmatchedOriginal.length}): ${unmatchedOriginal.map(b => b.name).join(', ')}`);
  console.log(`Unmatched shuffled (${unmatchedShuffled.length}): ${unmatchedShuffled.map(b => b.name).join(', ')}`);

  // Interpretation
  console.log('\nInterpretation:');
  if (avgBestMatch > 0.65 && matchCoverage > 0.7) {
    console.log('  → Same concepts, different names. Path-dependence is lexical, not structural.');
  } else if (avgBestMatch >= 0.50 && matchCoverage >= 0.4) {
    console.log('  → Partial overlap. Some bridges are stable, some are path-unique.');
  } else {
    console.log('  → Genuinely different concepts. Path-dependence is real and conceptual.');
  }

  // Save results
  const results = {
    timestamp: new Date().toISOString(),
    originalBridges: originalBridges.map(b => ({ name: b.name, description: b.description, score: b.bridgeScore })),
    shuffledBridges: shuffledBridges.map(b => ({ name: b.name, description: b.description, score: b.bridgeScore })),
    similarityMatrix: matrix,
    matches: judgedMatches.map(m => ({
      original: m.original.name,
      shuffled: m.shuffled.name,
      similarity: m.similarity,
      judgeScore: m.judge?.score,
      judgeExplanation: m.judge?.explanation,
    })),
    unmatchedOriginal: unmatchedOriginal.map(b => b.name),
    unmatchedShuffled: unmatchedShuffled.map(b => b.name),
    metrics: {
      nameOnlyJaccard: 0,
      avgBestMatchSimilarity: avgBestMatch,
      matchCoverage,
      semanticJaccard,
    },
    cost: costTracker.summarize(),
  };

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, 'path-dependence-results.json'), JSON.stringify(results, null, 2));
  console.log(`\nResults saved to results-l3/path-dependence-results.json`);
  console.log(`Total cost: $${costTracker.totalCost.toFixed(4)}`);
}

// --- CLI ---

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'boundary':
      await runBoundaryTest();
      break;
    case 'path-dependence':
      await runPathDependenceTest();
      break;
    default:
      console.log(`Usage:
  npx tsx src/diagnostic-tests.ts boundary          # Test 1: Capability boundary
  npx tsx src/diagnostic-tests.ts path-dependence   # Test 2: Semantic path-dependence`);
  }
}

export { runBoundaryTest, runPathDependenceTest };

main().catch(err => {
  console.error(err);
  process.exit(1);
});
