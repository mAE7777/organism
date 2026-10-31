# organism

organism is an experiment in giving an LLM a memory shaped like a graph instead of a flat list of notes. The question it tests: when new text keeps reshaping that graph, does the graph surface cross-domain connections that the model would not propose if you asked it directly?

Each input text is broken into concepts. Each concept carries facets tagged with a domain, such as `temporal:delayed-feedback`. The model proposes links between concepts. Code then walks the graph and finds longer paths (A to B to C) that no single model call produced. Links decay, hubs are penalized, and bridges between domains are protected, so the graph reorganizes as inputs arrive.

## How one input is processed

`src/circuit.ts` runs these steps for each input:

1. **Decompose.** Claude Sonnet writes free-form notes on what the input adds to the current graph. Claude Haiku then extracts concepts and domain-tagged facets from those notes.
2. **Connect.** Local embeddings pick candidate link targets, and the model accepts or rejects each link.
3. **Scan for resonance.** A local `all-MiniLM-L6-v2` model finds similar facets across domains without API calls.
4. **Prune.** Betweenness centrality sets decay. Hubs decay three times faster and bridges at half speed. Redundant paths merge, and orphan concepts are rescued or archived.
5. **Update identity.** The system writes a short description of its current bridges and dominant domains. That description goes into the next decompose prompt.
6. **Emit a signal.** `TopologySignal` lists bridges, emergent paths, rearrangements, and open questions. Building it needs no model call.

## What the experiments showed

The work ran in three levels. Each level was designed to fix what the previous one exposed.

**Level 1, 10 inputs.** The plumbing worked: 57 concepts and 290 links. Emergence did not show up. Every link was one the model had been asked for, and the graph spent 17 times more tokens than a flat-memory baseline for answers of similar quality. None of the 14 thesis claims was validated. Details are in [`docs/mvo-results.md`](docs/mvo-results.md).

**Level 2, 50 inputs.** Code traversal found 204 paths that no model call produced, and the graph rearranged itself 27 times. One concept sat on 62% of all paths, so the graph was close to a star. Details are in [`docs/level-2-design.md`](docs/level-2-design.md).

**Level 3, 50 inputs, $33.59.** Level 3 added two-step decompose, embedding resonance, and structural pruning, and measured them with an evaluation suite of eleven tests. Test K was not run. The design is in [`L3-DESIGN.md`](L3-DESIGN.md).

| Test | Result | Score |
|------|--------|-------|
| B: Semantic emergence | PASS | 3.66/5 average composite |
| G: Network shape | PASS | 6.5% top-3 path share |
| D: Decompose drift | PASS | 0.048 Jaccard |
| H: Human validation | PASS | 4.17/5 average |
| E: Question lifecycle | PASS | 41.5% resolution rate |
| F: Contradictions | PASS | 19 found |
| A: Hub concentration | FAIL | 0.641 Gini (target below 0.5) |
| C: Resolution growth | FAIL | decreasing trend |
| I: Rearrangement quality | FAIL | 2.03/5 average |
| J: Scale simulation | FAIL | graph 1, baseline 4 |

The three must-pass tests in the design (B, G, and D) passed. Hub concentration and rearrangement quality still failed.

### Input order changes the result

Running the same 10 inputs in two different orders produced bridges with no names in common (Jaccard 0.0). Bridges from both orders scored well in human review. The graph records a story that depends on the order of its inputs. It does not recover a fixed property of the inputs.

### The graph loses when it has to write prose

In Test J, a model that wrote answers from the graph lost to the same model with every input in its context. Rated directly as structures, the same bridges averaged 4.17 out of 5 in human review (Test H). Whatever value the graph has is in the structures, not in prose generated from them.

## Status

Level 3 is complete. Three questions are open:

- Does the graph find connections that a stronger model cannot reach by itself?
- Are order-dependent structures useful across many orderings, or only in the two runs tested?
- Can the cost drop enough to matter? A full Level 3 run with evaluation cost $35.71, and the connect step is about half of that.

## Run it

Put an `ANTHROPIC_API_KEY` in `.env` (see `.env.example`), then:

```sh
npm install
npx tsx src/index.ts run-l3                 # 50-input run
npx tsx src/index.ts run-l3 --resume        # resume from the last completed input
npx tsx src/index.ts run-l3-evaluate        # evaluation suite
npx tsx src/tension.ts topology-l3          # structural tension report for a finished run
npm test                                    # 175 unit tests (vitest)
```

`npx tsx src/index.ts` with no command lists every command. The tension report reads `state.json` and `history.json` from a run's topology folder. It reports which edges and concepts carry the most negative Forman-Ricci curvature, and whether metrics across the run history show early-warning signs of a transition.

## Project structure

```
src/
  index.ts          CLI entry point
  circuit.ts        Per-input processing
  operations.ts     Model calls (decompose, connect, compare)
  topology.ts       Graph state (concepts, links, decay)
  resonance.ts      Local embedding resonance
  pruner.ts         Structural pruning (centrality, decay, merges)
  identity.ts       Self-description and feedback
  signals.ts        TopologySignal assembly
  test-suite.ts     Evaluation tests A to K
  tension.ts        Curvature and early-warning report over a saved run
  ...               Runner, judge, metrics, and reporting
inputs/             50 input essays across domains
topology/           Saved run history: chain versions, identity snapshots, bridge scores
tests/              Unit tests (vitest)
docs/               Design notes and results for Levels 1 and 2
```
