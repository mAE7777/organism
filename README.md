# organism

An experimental system that tests whether AI can build knowledge structures that produce insights a flat-memory LLM cannot. Concepts are decomposed into faceted representations, connected through structural chains, and evolved through decay, pruning, and identity feedback, creating a topology that reorganizes itself as new information arrives.

The core question: does structural computation over accumulated traces produce genuinely emergent understanding, or is it just expensive prompt engineering?

## Architecture

```
Input text
  → Decompose (two-phase crystallization: free thinking + structured extraction)
  → Connect (embedding-guided target selection + LLM chain validation)
  → Resonance scan (embedding similarity for latent connections)
  → Structural pruning (hub suppression, bridge protection, orphan handling)
  → Identity update (self-model fed back into future decomposition)
  → Signal emission (bridges, emergent paths, contradictions, questions)
```

Each input produces concepts with domain-qualified facets. Concepts are connected through chains: weighted, typed edges that cross domain boundaries. Transitive paths (A→B→C) are discovered by code traversal, not LLM generation. This is the mechanism for emergence: the topology contains connections no single LLM call produced.

### Key components

- **Crystallization decompose**: Two-phase. Sonnet thinks freely about what's new or challenging relative to the existing topology, then Haiku extracts structured concepts with domain-qualified facets. Prevents hub gravity from generic attributes.
- **Embedding resonance**: Local `all-MiniLM-L6-v2` model finds semantically similar facets across domains without API calls. Replaces string-matching resonance that was effectively dead in L2.
- **Structural pruner**: Computes betweenness centrality. Hubs get 3x decay, true bridges get 0.5x decay. Merges redundant paths. Rescues or archives orphans.
- **Identity loop**: After each run, the system generates a self-description reflecting its current bridge concepts, dominant domains, and recent shifts. This identity feeds into subsequent decompose prompts, creating behavioral drift over time.
- **Signal output**: Primary output is `TopologySignal`: bridges, emergent paths, rearrangements, contradictions, uncertainty profile, decay report, open questions, and delta from the previous signal. No LLM call required.

## Experiment levels

### L1 (MVO): proof of plumbing

10 inputs, A/B test vs flat memory. Proved the engineering works (57 concepts, 290 chains). Did not prove emergence: all connections were LLM-solicited. System B spent 17x more tokens for comparable quality. 0/14 thesis claims validated.

### L2: proving emergence

50 inputs with transitive path discovery, facet resonance, bridge detection, identity loop, aggressive decay, and rearrangement tracking. Proved structural emergence: 204 transitive paths from chain composition, 27 rearrangement events, identity drift confirmed. Hub gravity problem identified (62% of paths through one concept).

### L3: sense-making infrastructure

50 inputs with crystallization decompose, embedding resonance, structural pruning, automated evaluation suite (tests A-K), and signal-driven output.

**Results (50 inputs, $33.59):**

| Test | Result | Score |
|------|--------|-------|
| B: Semantic Emergence | PASS | 3.66/5 avg composite |
| G: Network Shape | PASS | 6.5% top-3 path share |
| D: Decompose Drift | PASS | 0.048 Jaccard (significant drift) |
| H: Human Validation | PASS | 4.17/5 avg |
| E: Question Lifecycle | PASS | 41.5% resolution rate |
| F: Contradictions | PASS | 19 found |
| A: Hub Gravity | FAIL | 0.641 Gini (need <0.5) |
| C: Resolution Growth | FAIL | decreasing trend |
| I: Rearrangement Quality | FAIL | 2.03/5 avg genuine |
| J: Scale Simulation | FAIL | topology 1, baseline 4 |

Must-pass tests (B, G, D) all pass. The topology produces semantically meaningful emergent paths, distributes connections beyond a star graph, and genuinely changes how it decomposes over time.

### Critical finding: path dependence

The same 10 inputs processed in different order produce **0% bridge overlap** (Jaccard = 0.0). The topology constructs path-dependent structural narratives, not invariant corpus properties. Both orderings' bridges score well with human evaluators — the structures are useful but arbitrary with respect to sequence.

### The text-output evaluation problem

Test J (LLM essay comparison) fails because it collapses structural computation into a text-generation task where Claude with full context naturally dominates. Test H (human validation of structures directly) scores 4.17/5. The topology's value is in the structural artifacts themselves, not their translation to prose.

## Usage

```sh
npm install
```

Requires `ANTHROPIC_API_KEY` in `.env`.

```sh
npx tsx src/index.ts run-l3                 # 50-input run
npx tsx src/index.ts run-l3 --resume        # resume from last input
npx tsx src/index.ts run-l3-evaluate        # automated test suite (A-K)

npm test                                    # unit tests (vitest, 163 total)
```

## Project structure

```
src/
  index.ts          CLI entry point
  circuit.ts        Per-input processing pipeline
  operations.ts     LLM calls (decompose, connect, compare)
  topology.ts       State management (concepts, chains, decay)
  resonance.ts      Local embedding resonance
  pruner.ts         Structural pruning (centrality, decay, merges)
  identity.ts       Self-model generation and feedback
  signals.ts        TopologySignal assembly
  test-suite.ts     Automated evaluation tests (A-K)
  ...               Additional modules (runner, judge, metrics, reporting)
inputs/             50 input essays across domains
topology/           Topology history from the L3 run
tests/              Unit tests (vitest)
docs/               Design docs and experiment results
```

## Cost

L3 full run (50 inputs + evaluation + scale test): ~$35.71. The connect operation dominates (~50% of spend). Embedding resonance is free (local model).

## Status

L3 experiment complete. Structural computation works — emergent paths, bridge detection, identity drift, question lifecycle all validated. Text-output evaluation fails to capture the topology's value. Path dependence is real but both orderings produce human-validated useful structures.

Open questions: whether the topology finds things an LLM fundamentally cannot (capability boundary), whether path-dependent structures are consistently useful across many orderings, and whether semantic similarity (not string matching) would show convergence between different run orders.

Developed privately in early 2026. History filtered from the private original; personal and unrelated material removed.
