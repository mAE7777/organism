# Level 3 Design: From Star Graph to Sense-Making Infrastructure

**Date:** 2026-02-26
**Context:** L2 proved structural emergence (204 paths) but Layer 2 semantic evaluation exposed critical problems: hub gravity (62% of paths through one concept), surface-level connections via generic facets, star graph topology. This design addresses every identified problem and redefines what the system outputs.

---

## What L2 Proved and What It Didn't

| Claim | Status | Evidence |
|-------|--------|----------|
| Code-only computation produces structural emergence | **Proved** | 204 transitive paths, 27 rearrangements |
| Emergence is semantically meaningful | **Weak** | Only 3-4/20 top paths scored >3 on all dimensions |
| Topology beats baseline at answering questions | **Failed** | 9-1 loss in blind judge |
| Identity loop produces genuine cognitive development | **Plausible** | 3 distinct phases observed, but decompose drift not tested |
| Hub gravity is the dominant structural pattern | **Proved** | 62% of paths through Fermentation, 54% through Defense in Depth |

**L3's mission:** Fix the structural problems that made L2's emergence shallow, redefine what the system outputs, and build a comprehensive test suite that answers every open question automatically.

---

## Architecture Changes

### Change 1: Crystallization Decompose

**Problem:** Current decompose extracts static facets via structured output template. Facets are generic (`structural:layering`) and overloaded (same attribute matches security, cooking, engineering). This creates hub gravity.

**New design:**

```
OLD: decompose(text) → LM fills {domain, attribute, salience}[] template → concepts

NEW: Two-phase crystallization
  Phase A — Free thinking:
    Input: text + topology context (top 5 bridges, recent rearrangements,
           highest-uncertainty regions, current identity)
    Prompt: "Read this text. Given what the topology already knows:
            - What here is GENUINELY NEW (not another instance of an existing pattern)?
            - What here CHALLENGES or CONTRADICTS existing connections?
            - What here DEEPENS an existing connection beyond its current resolution?
            - What QUESTIONS does this raise that the topology can't yet answer?
            Think freely. 200-400 words."
    Model: Sonnet
    Output: freeform thinking text

  Phase B — Structural extraction:
    Input: freeform thinking + original text
    Prompt: "Extract concepts and facets from this thinking.
            For each facet:
            - domain: category
            - attribute: DOMAIN-QUALIFIED description (not 'layering' but
              'security-independent-control-layering' or 'culinary-transformative-layering')
            - salience: 0-1
            - novelty: is this facet new relative to existing topology? (true/false)
            - tension: does this facet contradict an existing connection? (concept name or null)
            Also extract 1-3 open questions this text raises."
    Model: Haiku
    Output: concepts[] with qualified facets + questions[]
```

**Why this fixes hub gravity:** Domain-qualified attributes prevent different-domain concepts from matching on surface words. "Defense in Depth's layering" and "Catenary Distribution's layering" produce different facets, so they don't form a trivial connection through shared attribute text.

**Why crystallization matters:** Phase A forces LM to think RELATIVE TO the topology, not in isolation. Input #20 won't just produce "linguistic structure has frameworks" — it'll produce "linguistic determinism challenges the layering model because linguistic structure is recursive, not stacked."

**Cost:** +1 Sonnet call per input (~$0.01), +1 Haiku call per input (~$0.001). Roughly 30% increase over current decompose cost.

**Open questions stored as topology citizens:**

```typescript
interface TopologyQuestion {
  id: string;
  text: string;                    // the question itself
  sourceInput: number;
  relatedConcepts: string[];       // concepts this question is about
  status: 'open' | 'addressed' | 'dissolved';
  addressedByInput?: number;       // which input addressed it
  dissolvedByRearrangement?: string; // which rearrangement made it irrelevant
}
```

Questions participate in the graph. When a future input's decompose naturally addresses an open question, the question gets marked `addressed` — this is a measurable signal of knowledge deepening.

### Change 2: Antagonistic Hub Suppression

**Problem:** 5 concepts from inputs 1-2 dominate the entire topology. Decay is uniform (5%/run) and doesn't distinguish hubs from genuine bridges.

**New design: Structural Pruner (runs after every processInput)**

```typescript
interface PrunerResult {
  hubsPenalized: { concept: string; oldCentrality: number; chainsDecayed: number }[];
  bridgesProtected: string[];
  redundantPathsMerged: number;
  orphansArchived: number;
}

function structuralPrune(topology: TopologyState): PrunerResult {
  // 1. Compute betweenness centrality for each concept
  const centrality = computeBetweennessCentrality(topology);

  // 2. Identify true bridges vs mere hubs
  //    True bridge: removing it disconnects part of the graph
  //    Mere hub: removing it, graph stays connected
  const bridges = findArticulationPoints(topology);
  const hubs = concepts where centrality > threshold AND NOT in bridges;

  // 3. Penalize hubs: chains through hubs decay at 3x normal rate
  for (const hub of hubs) {
    for (const chain of chainsThrough(hub)) {
      chain.weight *= (1 - 0.15);  // 15% decay vs normal 5%
    }
  }

  // 4. Protect true bridges: chains through true bridges decay at 0.5x rate
  for (const bridge of bridges) {
    for (const chain of chainsThrough(bridge)) {
      chain.weight *= (1 - 0.025);  // 2.5% vs normal 5%
    }
  }

  // 5. Merge redundant paths
  //    If 3+ chains connect same endpoints through different intermediates,
  //    keep the highest-weight one, merge others into a meta-chain
  const redundantGroups = findRedundantPaths(topology);
  for (const group of redundantGroups) {
    const best = group.sort((a, b) => b.weight - a.weight)[0];
    best.weight = Math.min(1.0, best.weight * 1.2); // strengthen survivor
    // archive the rest, don't delete — they're evidence of path convergence
  }

  // 6. Orphan rescue + archive
  const orphans = concepts with 0 chains above weight 0.2;
  for (const orphan of orphans) {
    // one rescue attempt: try to connect strongest facet to random high-weight concept
    const rescue = await connect(orphan.strongestFacet, randomHighWeightConcept);
    if (!rescue) archive(orphan);
  }
}
```

**Centrality threshold:** Start with top 10% by betweenness centrality. This is an empirical parameter — observe whether hub suppression actually distributes connections or just kills the topology.

**Expected effect on L2 data:** Fermentation and Defense in Depth would get 3x decay on most chains. After 10 more runs, their dominance should drop from 62%/54% to <30%. New bridges should emerge from later inputs.

### Change 3: Resonance Scan Upgrade

**Problem:** String-matching resonance (exact/substring/Jaccard) found only 9 latent connections in 27 runs. Mechanism is effectively dead.

**New design: Embedding-based resonance**

```typescript
import { pipeline } from '@xenova/transformers';

// Load once at startup — runs locally, no API calls
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

function computeResonance(facetA: Facet, facetB: Facet): number {
  // 1. Embed the full facet description (domain:attribute)
  const embA = embed(facetA.domain + ' ' + facetA.attribute);
  const embB = embed(facetB.domain + ' ' + facetB.attribute);

  // 2. Cosine similarity
  const cosineSim = dot(embA, embB) / (norm(embA) * norm(embB));

  // 3. Domain penalty: same-domain resonance is less interesting
  const domainPenalty = facetA.domain === facetB.domain ? 0.5 : 1.0;

  // 4. Salience weighting
  return cosineSim * domainPenalty * facetA.salience * facetB.salience;
}
```

**Threshold:** 0.65 cosine similarity (after domain penalty). Higher than current 0.5 string-match because embeddings find more candidates.

**Cost:** Zero API cost. ~50ms per facet pair on CPU. For 10 new facets × 500 existing facets = 5000 comparisons = ~250ms total. Negligible.

**Expected effect:** Latent connections should go from 9 to 50-100+ over 27 runs. This restores the "unexpected connection discovery" mechanism that string matching killed.

**Dependency:** Requires `@xenova/transformers` npm package (~50MB download, runs in Node.js).

### Change 4: Output Redefinition — Structural Signals

**Problem:** Current output is either raw topology state (for analysis) or LM-generated answers (for queries). Neither represents topology's genuine value.

**New design: TopologySignal as primary output**

```typescript
interface TopologySignal {
  // === Persistent discoveries ===
  bridges: {
    concept: string;
    score: number;
    uniqueDomains: number;
    isArticulationPoint: boolean;  // true bridge vs mere hub
    survivedDecayCycles: number;
  }[];

  // === Emergent paths (code-discovered, not LM-created) ===
  emergentPaths: {
    from: string;
    to: string;
    hops: string[];
    weight: number;
    domainsCrossed: string[];
    semanticScore?: number;       // from automated semantic evaluation
  }[];

  // === Structural dynamics ===
  rearrangements: {
    endpoints: [string, string];
    previousIntermediates: string[];
    currentIntermediates: string[];
    run: number;
    interpretation?: string;
  }[];

  // === Tensions and contradictions ===
  contradictions: {
    conceptA: string;
    conceptB: string;
    pathA: { intermediates: string[]; implication: string };
    pathB: { intermediates: string[]; implication: string };
    tension: string;
  }[];

  // === Knowledge gaps ===
  uncertaintyProfile: {
    structural: number;     // 0-1: connection density in sparse regions
    coherence: number;      // 0-1: contradictory path prevalence
    resolution: number;     // 0-1: avg facet count per concept
    identity: number;       // 0-1: identity oscillation in recent runs
  };

  // === What the topology forgot (and why) ===
  decayReport: {
    chainsPruned: number;
    conceptsArchived: string[];
    hubsPenalized: string[];
    reasonableForgets: string[];    // chains that decayed below threshold
    suspiciousForgets: string[];    // high-cross-domain chains that decayed (worth investigating)
  };

  // === Open questions ===
  openQuestions: {
    text: string;
    relatedConcepts: string[];
    age: number;                    // how many runs since asked
  }[];

  // === Diff from previous signal ===
  delta: {
    newBridges: string[];
    lostBridges: string[];
    newRearrangements: number;
    questionsAddressed: number;
    resolutionChange: number;       // positive = getting smarter
  };
}
```

**Three output modes:**

1. **`emitSignal()`** — returns TopologySignal after each processInput. Primary output. No LM call.

2. **`humanReport(signal)`** — Haiku translates TopologySignal into readable prose. One cheap LM call for presentation only.

3. **`queryWithDirectives(question)`** — Instead of dumping graph data, extracts 3-5 relevant structural signals, has Haiku phrase them as reasoning directives, then Sonnet answers with directives as starting points. This replaces the old query() for cases where an answer is actually needed.

### Change 5: Automated Semantic Evaluation

**Problem:** Layer 2 evaluation required manual inspection. Can't iterate fast if every evaluation needs human judgment.

**New design: Automated semantic scoring of emergent paths**

```typescript
async function evaluatePathSemantic(path: TransitivePath, topology: TopologyState): Promise<PathScore> {
  // Get concept details
  const fromConcept = getConcept(path.from, topology);
  const toConcept = getConcept(path.to, topology);
  const hopConcepts = path.hops.map(h => getConcept(h, topology));

  // Have Haiku evaluate on 3 dimensions
  const evaluation = await haiku.parse({
    prompt: `Two concepts from completely different domains are connected through a structural path.

Concept A: ${fromConcept.name} (domain: ${fromConcept.primaryDomain})
  Key facets: ${fromConcept.facets.slice(0,3).map(f => f.attribute).join(', ')}

Concept B: ${toConcept.name} (domain: ${toConcept.primaryDomain})
  Key facets: ${toConcept.facets.slice(0,3).map(f => f.attribute).join(', ')}

Path: ${path.from} → ${path.hops.join(' → ')} → ${path.to}

Rate this connection:
1. SURPRISE (1-5): Would someone who studied both domains separately think to connect them?
2. VALIDITY (1-5): Does the connection make genuine structural sense, not just surface wordplay?
3. INSIGHT (1-5): Does this connection teach something that reading about A and B separately wouldn't?

Also: In ONE sentence, what does this path actually MEAN? (If you can't articulate it, the connection is probably shallow.)`,
    schema: {
      surprise: z.number().min(1).max(5),
      validity: z.number().min(1).max(5),
      insight: z.number().min(1).max(5),
      meaning: z.string(),
      isShallow: z.boolean()
    }
  });

  return {
    ...evaluation,
    compositeScore: (evaluation.surprise + evaluation.validity + evaluation.insight) / 3,
    pathId: `${path.from}|${path.to}|${path.hops.join(',')}`,
  };
}
```

**When to run:** After every 10 processInput runs, evaluate a random sample of 30 emergent paths. Store results. Track composite score distribution over time.

**Cost:** 30 × Haiku call ≈ $0.03 per evaluation round. Negligible.

**Kill criterion:** If after 50+ inputs, average composite score of emergent paths < 2.5/5, semantic emergence isn't happening at this density/resolution. If > 3.5, thesis has strong support.

---

## Complete Test Suite

### Test A: Hub Gravity Index (HGI)

**What it measures:** How concentrated the topology is around a few hubs.

**Metric:** Gini coefficient of betweenness centrality across all concepts.
- 0.0 = perfectly uniform (every concept equally central)
- 1.0 = perfect concentration (one concept is the only bridge)

**Implementation:**
```typescript
function hubGravityIndex(topology: TopologyState): number {
  const centralities = computeBetweennessCentrality(topology);
  return giniCoefficient(Object.values(centralities));
}
```

**Tracking:** Compute after every processInput. Plot over time.
- L2 baseline: probably ~0.8 (very concentrated)
- L3 target: < 0.5 after hub suppression kicks in
- Healthy: decreasing over time (distributed network emerging)

### Test B: Semantic Emergence Score (SES)

**What it measures:** Are emergent paths semantically meaningful?

**Metric:** Average composite score from automated semantic evaluation (Test A above) on random sample of 30 paths.

**Tracking:** Every 10 runs.
- L2 baseline: ~2.2/5 (estimated from manual evaluation)
- L3 target: > 3.0/5
- Kill: If < 2.5 after 50 inputs, semantic emergence isn't viable

### Test C: Resolution Growth

**What it measures:** Is the system making finer distinctions over time?

**Metric:** Average unique attribute count per concept (domain-qualified attributes).

```typescript
function resolutionScore(topology: TopologyState): number {
  const facetCounts = topology.concepts.map(c =>
    new Set(c.facets.map(f => f.domain + ':' + f.attribute)).size
  );
  return facetCounts.reduce((a, b) => a + b, 0) / facetCounts.length;
}
```

**Tracking:** Every processInput.
- L2 baseline: ~6.5 facets/concept (but many duplicates like `structural:layering`)
- L3 target: increasing over time WITH domain-qualified attributes (so actual distinct facets, not surface duplicates)

### Test D: Decompose Drift

**What it measures:** Does the identity loop actually change how decompose works?

**Protocol:**
```
1. Save input #1's original text
2. At run 1: decompose(text, identity=run1) → facets_early
3. At run 25: decompose(text, identity=run25) → facets_late
4. At run 50: decompose(text, identity=run50) → facets_latest
5. Compute Jaccard similarity between facet sets
6. Have Haiku evaluate: "Are these decompositions qualitatively different?
   Does the later one show more nuanced understanding?"
```

**Tracking:** At runs 1, 25, 50.
- Pass: Jaccard similarity < 0.5 (significantly different facets) AND Haiku says later decomposition is more nuanced
- Fail: Jaccard > 0.8 (identity loop is cosmetic)

### Test E: Question Lifecycle

**What it measures:** Do open questions get addressed by future inputs?

**Metric:** Question resolution rate = addressed questions / total questions.

**Tracking:** Every 10 runs.
- If 0%: questions are just data points, not functional
- If >20%: topology is genuinely building on its own gaps
- If a question gets dissolved (made irrelevant by a rearrangement): even more interesting

### Test F: Contradiction Discovery Rate

**What it measures:** Is the topology finding genuine tensions?

**Implementation:**
```typescript
function findContradictions(topology: TopologyState): Contradiction[] {
  const contradictions = [];
  // For each pair of concepts with multiple paths between them
  for (const [pair, paths] of multiPathPairs(topology)) {
    // Check if paths go through concepts with opposing facets
    // e.g., one path through "control" and another through "surrender"
    const pathImplications = paths.map(p =>
      evaluatePathImplication(p, topology) // Haiku: "what does this path imply?"
    );
    // If implications conflict, it's a contradiction
    if (implicationsConflict(pathImplications)) {
      contradictions.push({ pair, paths, implications: pathImplications });
    }
  }
  return contradictions;
}
```

**Tracking:** After every 10 runs.
- L2 baseline: 0 (contradictions weren't tracked)
- L3 target: > 0. Any genuine contradiction found = evidence of structural depth
- Gold standard: a contradiction that reveals a genuine insight (like "A both enables and inhibits B, because under condition X it enables but under condition Y it inhibits")

### Test G: Star Graph → Network Transition

**What it measures:** Is the topology evolving from star graph to distributed network?

**Metrics:**
```typescript
function networkHealth(topology: TopologyState): NetworkMetrics {
  return {
    // 1. Hub dependency: what % of paths go through top 3 concepts?
    top3PathShare: pathsThroughTop3 / totalPaths,  // L2: ~90%. Target: <40%

    // 2. Graph diameter: longest shortest path between any two concepts
    diameter: computeDiameter(topology),  // higher = more distributed

    // 3. Clustering coefficient: do concepts form local clusters?
    clusteringCoeff: avgClusteringCoefficient(topology),  // higher = richer local structure

    // 4. Number of articulation points (true bridges)
    articulationPoints: findArticulationPoints(topology).length,

    // 5. Average path length between random concept pairs
    avgPathLength: sampleAvgPathLength(topology, 100),
  };
}
```

**Tracking:** Every 10 runs. The transition from star to network should be visible as:
- top3PathShare decreasing
- diameter increasing
- clusteringCoeff increasing
- articulationPoints stable or increasing
- avgPathLength increasing then stabilizing

### Test H: Structural Signal Value (Human Validation)

**What it measures:** Are the TopologySignal outputs actually useful?

**Protocol (run once at 50 inputs):**
```
1. Generate TopologySignal
2. Present to human:
   a. Top 5 bridges: "Does knowing these hub concepts help you understand
      the connections across your 50 inputs?"
   b. Top 5 emergent paths (by semantic score): "Did you already know about
      these connections, or is this genuinely new to you?"
   c. Rearrangement events: "Does knowing that your understanding of X shifted
      from path A to path B match your own sense of how your thinking changed?"
   d. Contradictions: "Is this tension real? Does it point to something you
      hadn't articulated?"
   e. Open questions: "Are these good questions? Would you not have thought to ask them?"
3. Human rates each section 1-5
4. Composite score: average across sections
```

**Pass:** Composite > 3.0 (signals are genuinely useful)
**Fail:** Composite < 2.0 (signals are noise)

This is the ONE test that requires human judgment. Everything else is automated.

### Test I: Rearrangement Semantic Quality

**What it measures:** When paths rearrange, is the new path semantically better?

**Implementation:**
```typescript
async function evaluateRearrangement(event: RearrangementEvent): Promise<RearrangementScore> {
  return await haiku.parse({
    prompt: `A knowledge system's understanding of how ${event.conceptA} connects to ${event.conceptB} changed.

Old path: ${event.conceptA} → ${event.previousIntermediates.join(' → ')} → ${event.conceptB}
New path: ${event.conceptA} → ${event.currentIntermediates.join(' → ')} → ${event.conceptB}

Is the new path:
1. More specific? (1-5)
2. Deeper (more intermediate steps that add meaning)? (1-5)
3. More cross-domain? (1-5)
4. Overall: is this a genuine shift in understanding or just noise? (1-5)`,
    schema: { specificity: z.number(), depth: z.number(),
              crossDomain: z.number(), genuine: z.number() }
  });
}
```

**Tracking:** Evaluate every rearrangement as it happens.
- L2 had 27 rearrangements but didn't evaluate quality
- L3 target: average "genuine" score > 3.0

### Test J: Scale Simulation

**What it measures:** Would topology beat RAG at scale?

**Protocol:**
```
1. After 50 inputs, generate 5 questions that require cross-domain structural connections
2. Three systems answer each:
   a. Full-context baseline: all 50 summaries in one Sonnet call (if fits in context)
   b. RAG-simulated baseline: only top-5 retrieved summaries in Sonnet call
   c. Topology: queryWithDirectives
3. Blind judge (human) rates answers on insight quality (not presentation)

If topology beats RAG-simulated baseline: evidence for scale advantage
If topology beats full-context baseline: evidence for structural computation advantage
```

### Test K: Autopoietic Signal — Does Output Change Input?

**What it measures:** Do the structural signals from TopologySignal actually influence the next processInput cycle?

**Protocol:**
```
1. Process input N, emit TopologySignal
2. Process input N+1 normally (TopologySignal feeds into decompose via identity context + uncertainty + open questions)
3. Process input N+1 WITHOUT TopologySignal (fresh decompose, no context)
4. Compare facets from step 2 vs step 3
5. If significantly different: autopoietic loop is functional
6. If identical: signals aren't actually influencing the system
```

---

## Implementation Phases

### Phase 1: Core Fixes (decompose + pruner + resonance)

**Files to modify:**
- `src/operations.ts` — new decompose prompt (crystallization two-phase)
- `src/types.ts` — TopologyQuestion, domain-qualified facets, TopologySignal
- `src/analysis.ts` — add betweenness centrality, articulation points, hub suppression
- `src/topology.ts` — store questions, differential decay rates
- `src/resonance.ts` (new) — embedding-based resonance using @xenova/transformers

**Files to create:**
- `src/signals.ts` — TopologySignal generation, emitSignal()
- `src/pruner.ts` — Structural Pruner (hub suppression, redundancy merging, orphan handling)
- `src/graph-metrics.ts` — centrality, clustering coefficient, diameter, articulation points

**Tests:**
- `tests/decompose-crystallization.test.ts` — verify two-phase decompose produces domain-qualified facets
- `tests/pruner.test.ts` — verify hub suppression reduces centrality concentration
- `tests/resonance-embedding.test.ts` — verify embedding resonance finds semantically similar facets that string matching misses
- `tests/graph-metrics.test.ts` — centrality, articulation points, Gini coefficient

### Phase 2: Signal Output + Automated Evaluation

**Files to modify:**
- `src/circuit.ts` — processInput returns TopologySignal, query replaced with queryWithDirectives
- `src/runner.ts` — emit signals, run automated evaluations every 10 runs

**Files to create:**
- `src/evaluator.ts` — automated semantic path scoring, rearrangement evaluation, contradiction detection
- `src/reporter.ts` — humanReport() from TopologySignal

**Tests:**
- `tests/evaluator.test.ts` — mock API for semantic scoring
- `tests/signals.test.ts` — signal generation, delta computation

### Phase 3: Test Suite

**Files to create:**
- `src/test-suite.ts` — all 11 tests (A through K) as runnable functions
- `src/test-runner.ts` — orchestrator that runs relevant tests at appropriate intervals

**CLI commands:**
```
run-l3                          # full run with new architecture
run-l3 --resume                 # resume from last completed input
run-l3-signals                  # emit TopologySignal for current state
run-l3-evaluate                 # run automated evaluation suite
run-l3-report                   # comprehensive report with all test results
run-l3-test [A|B|C|...|K]      # run specific test
run-l3-drift-test               # run decompose drift experiment
run-l3-scale-test               # run scale simulation
```

### Phase 4: 50-Input Run with Continuous Monitoring

**Protocol:**
```
1. Reset topology (fresh start with new architecture)
2. Process all 50 inputs (reuse L2's input files)
3. After every input: compute HGI, resolution score, network health
4. After every 10 inputs:
   - Run semantic evaluation (Test B) on 30 random paths
   - Run contradiction detection (Test F)
   - Run question lifecycle check (Test E)
   - Emit TopologySignal with delta
5. At inputs 1, 25, 50: run decompose drift test (Test D)
6. After all 50 inputs:
   - Run full test suite (all 11 tests)
   - Generate comprehensive report
   - Run scale simulation (Test J)
   - One human evaluation session (Test H)
```

**Budget estimate:**
- 50 inputs × ($0.02 decompose + $0.01 Haiku extraction + ~$0.30 connect) ≈ $16.50
- 5 evaluation rounds × $0.03 ≈ $0.15
- Drift tests: ~$0.10
- Scale test: ~$0.50
- Signals/reports: ~$0.20
- **Total: ~$17.50**
- **Budget cap: $20.00**

---

## Success Criteria

### Must-pass (thesis lives or dies)

| Test | Criterion | What it means if it fails |
|------|-----------|--------------------------|
| B (Semantic Emergence) | Avg composite > 3.0/5 after 50 inputs | Structural paths aren't semantically meaningful. Core thesis is wrong. |
| G (Star→Network) | top3PathShare < 40% after 50 inputs | Hub suppression failed. Architecture still produces star graphs. |
| D (Decompose Drift) | Jaccard < 0.5 between run 1 and run 50 decompose | Identity loop is cosmetic. System doesn't change how it thinks. |

### Should-pass (thesis is strong)

| Test | Criterion | What it means if it fails |
|------|-----------|--------------------------|
| A (Hub Gravity) | Gini < 0.5 after 50 inputs | Network is still too concentrated but may improve with more inputs |
| C (Resolution) | Increasing trend over 50 inputs | System isn't making finer distinctions |
| E (Questions) | Resolution rate > 10% | Question mechanism isn't functional |
| I (Rearrangement) | Avg "genuine" > 3.0 | Rearrangements are noise, not learning |
| J (Scale) | Topology beats RAG-sim on 3/5 queries | No practical advantage even at simulated scale |

### Nice-to-have (thesis is exciting)

| Test | Criterion | What it means |
|------|-----------|---------------|
| F (Contradictions) | At least 1 genuine contradiction found | System can detect tensions in knowledge |
| H (Human validation) | Composite > 3.5 | Signals are genuinely useful to a human |
| K (Autopoietic) | Significant difference between with/without signal | System's output genuinely changes its own input |

---

## What's NOT in L3

- **No AoT integration.** Structured forgetting is addressed by the Pruner (redundancy merging, hub suppression). Full AoT DAG decomposition is a separate experiment for L4.
- **No multi-agent stigmergy.** Single-agent topology first. Multi-agent trace sharing is L4+.
- **No SLM.** All operations use Anthropic API (Haiku/Sonnet). Local SLM for decompose is an optimization for L4.
- **No phase transition mechanism.** Phase transition is observed (gas→liquid→solid metrics tracked in Test G), not engineered. If natural phase transition is observed, L4 can formalize it.
- **No product layer.** No MCP server, no API, no user-facing interface. Pure research validation.

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/types.ts` | Modify | TopologyQuestion, TopologySignal, domain-qualified facets, PathScore |
| `src/operations.ts` | Modify | Two-phase crystallization decompose |
| `src/topology.ts` | Modify | Store questions, differential decay |
| `src/analysis.ts` | Modify | Betweenness centrality, articulation points |
| `src/circuit.ts` | Modify | Emit TopologySignal, queryWithDirectives |
| `src/runner.ts` | Modify | Continuous monitoring, evaluation scheduling |
| `src/cost.ts` | Modify | Budget cap → $20 |
| `src/signals.ts` | **New** | TopologySignal generation, delta computation |
| `src/pruner.ts` | **New** | Hub suppression, redundancy merging, orphan handling |
| `src/resonance.ts` | **New** | Embedding-based resonance (@xenova/transformers) |
| `src/graph-metrics.ts` | **New** | Centrality, clustering, diameter, Gini coefficient |
| `src/evaluator.ts` | **New** | Automated semantic scoring, contradiction detection |
| `src/reporter.ts` | **New** | Human-readable reports from TopologySignal |
| `src/test-suite.ts` | **New** | All 11 tests (A-K) |
| `src/test-runner.ts` | **New** | Test orchestration and scheduling |
| `tests/decompose-crystallization.test.ts` | **New** | Crystallization decompose tests |
| `tests/pruner.test.ts` | **New** | Hub suppression tests |
| `tests/resonance-embedding.test.ts` | **New** | Embedding resonance tests |
| `tests/graph-metrics.test.ts` | **New** | Graph metric computation tests |
| `tests/evaluator.test.ts` | **New** | Automated evaluation tests |
| `tests/signals.test.ts` | **New** | Signal generation tests |
