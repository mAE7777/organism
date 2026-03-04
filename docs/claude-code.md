# Claude Code 竞争性实验协议

**目的**: 测试 Claude Code 多轮聚合（sequential LLM calls + batching）是否能复现 Organism 的 structural discovery
**角色**: Organism 的 existential test — 最强的 "simpler multi-call approach"
**预计用时**: ~30 分钟执行（自动化）
**预计成本**: ~$2-3（~133 API calls，14x cheaper than Organism's $33.59）

---

## 文件结构

```
results-claude-code/
├── round-1/                    # Independent decomposition
│   ├── decompose-01.json       # through decompose-50.json
│   └── summary.json
├── round-2/                    # Connection finding
│   ├── batch-connections/      # 10 batch files
│   ├── cross-batch/            # 45 pair files
│   └── connection-map.json     # Unified connection map
├── round-3/                    # Synthesis & bridge discovery
│   ├── transitive-paths.json
│   ├── bridges.json
│   └── top-10-surprises.json
├── round-4/                    # Meta-analysis
│   ├── meta-patterns.json
│   └── organism-comparison.json
├── round-5/                    # Adversarial pruning
│   ├── classified.json
│   └── pruned-discoveries.json
└── evaluation/
    ├── boundary-test.json
    ├── judge-comparison.json
    ├── human-scores.md
    └── final-scorecard.md
```

---

## Round 1: Independent Decomposition

**目标**: 50 个独立调用，每个只看 1 个 input。模拟 Organism 的 independence property。

**关键约束**: 每个调用之间无信息共享——不传递之前的 decomposition 结果。

### 实现方式

使用 50 个独立 subagent（haiku 模型，成本优先）或 50 个独立 API 调用。每个 subagent 只接收 1 个 input 文件。

### Prompt（每个 input 使用相同 prompt，仅替换文件内容）

```
You are analyzing a single text input through a multi-domain decomposition framework.

INPUT:
"""
{input_content}
"""

Decompose this input into exactly 7 facets, one per domain. For each facet, identify the most salient attribute — a specific quality or association unique to this input's treatment of the domain.

Domains:
1. physical: tangible, material properties
2. abstract: conceptual, theoretical properties
3. social: interpersonal, group dynamics
4. temporal: time-related properties
5. process: procedural, operational properties
6. structural: architectural, compositional properties
7. emotional: affective, experiential properties

For each facet, also identify up to 3 "concept handles" — precise 2-4 word phrases that capture transferable ideas from this input. These handles should be specific enough to potentially match handles from completely different domains.

Output as JSON:
{
  "input_id": "{input_id}",
  "input_topic": "{topic}",
  "facets": [
    {
      "domain": "physical",
      "attribute": "specific 1-2 word label",
      "salience": 0.0-1.0,
      "concept_handles": ["handle1", "handle2", "handle3"]
    }
    // ... 7 facets
  ]
}
```

### Output Schema

```typescript
interface Round1Output {
  input_id: string;        // "01" through "50"
  input_topic: string;     // "security", "cooking", etc.
  facets: {
    domain: "physical" | "abstract" | "social" | "temporal" | "process" | "structural" | "emotional";
    attribute: string;
    salience: number;
    concept_handles: string[];
  }[];
}
```

### 成本估算

- 50 calls × ~500 input tokens × ~300 output tokens
- Haiku: ~$0.05 total
- Sonnet: ~$0.45 total

---

## Round 2: Connection Finding

**目标**: 系统性地发现 input 之间的连接，使用 batching 避免 attention dilution。

三个子阶段：

### Round 2A: Within-Batch Connections

将 50 个 decompositions 分成 10 个 batch（每 batch 5 个）。每个 batch 内做穷举 pair 比较。

**Batching 策略**（最大化跨域性）：

| Batch | Inputs | Topics |
|---|---|---|
| 1 | 01, 12, 23, 34, 45 | Security, Parenting, Forest Fire Recovery, Emergence, Rote Learning |
| 2 | 02, 13, 24, 35, 46 | Cooking, Software Architecture, Online Education, Feedback Loops, Brutalist Architecture |
| 3 | 03, 14, 25, 36, 47 | Investing, Gardening, Acoustic Architecture, Adaptation vs Optimization, Atonal Music |
| 4 | 04, 15, 26, 37, 48 | Ecology, Jazz Pedagogy, Medical AI, Role of Constraints, Folk Medicine |
| 5 | 05, 16, 27, 38, 49 | Teaching, Bridge Engineering, Competitive Gaming, Time and Patience, Unfair Game Design |
| 6 | 06, 17, 28, 39, 50 | Architecture, Chemistry, Philosophy of Tech, Trust in Distributed Systems, Utility of Dogmatism |
| 7 | 07, 18, 29, 40 | Music, Epidemiology, Ecological Investing, Paradox of Control |
| 8 | 08, 19, 30, 41 | Medicine, Sports Coaching, Food Security, Security Theater |
| 9 | 09, 20, 31, 42 | Game Design, Linguistics, Systems Thinking, Over-Seasoning |
| 10 | 10, 21, 32, 43, 44 | Philosophy, Food Safety, Resilience Engineering, Index Funds, Monoculture Advantages |

### Prompt 2A（每个 batch 一次调用）

```
You are finding structural connections between decomposed inputs. Each input has been independently analyzed through 7 domains. Your task: find every non-trivial connection between any pair of inputs in this batch.

INPUTS (decomposed):
{batch_decompositions_json}

For every pair of inputs (there are {C(n,2)} pairs in this batch), identify:
1. Shared concept handles (exact or near-exact matches)
2. Structural parallels (different concept handles that point to the same underlying pattern)
3. Surprising connections (relationships that would not be obvious from the topic names alone)

A connection is non-trivial if it goes beyond surface similarity (e.g., "both involve systems" is trivial; "both use constraint as a generative mechanism through temporal accumulation" is non-trivial).

Output as JSON:
{
  "batch_id": {batch_id},
  "connections": [
    {
      "input_a": "{id}",
      "input_b": "{id}",
      "connection_type": "shared_handle" | "structural_parallel" | "surprising",
      "concept": "precise 2-5 word name for the shared concept",
      "domain_a": "which domain in input A",
      "domain_b": "which domain in input B",
      "explanation": "why this connection is meaningful",
      "weight": 0.0-1.0
    }
  ]
}
```

### Round 2B: Cross-Batch Connections

将 10 个 batch 的全部 within-batch connections 整合，进行 3 次 cross-batch 分析调用（而非 45 次稀疏 pairwise）。每次调用覆盖 ~3-4 个 batch，确保所有 batch 在至少 2 次调用中出现。

**调用分组**:
- Call 1: Batches 1-4（20 inputs, ~40 connections）
- Call 2: Batches 4-7（19 inputs, ~35 connections）— 与 Call 1 重叠 Batch 4
- Call 3: Batches 7-10（17 inputs, ~30 connections）— 与 Call 2 重叠 Batch 7

重叠设计确保 every batch pair 在至少一次调用中共同出现。

### Prompt 2B

```
You are finding cross-batch connections. Multiple batches of inputs have been independently analyzed for within-batch connections. Now find connections ACROSS batches.

ALL WITHIN-BATCH CONNECTIONS FOR THIS GROUP:
{all_connections_from_batches_in_this_group}

Your task:
1. For each pair of batches in this group, identify concepts that bridge them
2. Find transitive paths: if Batch A has connection A→X and Batch B has connection X→C, surface the A→C path
3. Look for concepts that appear in different batches under different names (semantic deduplication)
4. Flag any concept that connects inputs from 3+ batches — these are bridge candidates

A cross-batch connection is valuable when:
- The connected inputs have no topical overlap (e.g., cooking and epidemiology)
- The bridging concept is structural, not surface-level
- The connection would surprise someone who read both inputs

Output as JSON:
{
  "group_batches": [1, 2, 3, 4],
  "cross_connections": [
    {
      "concept": "precise 2-5 word name",
      "inputs_connected": [{"id": "01", "batch": 1}, {"id": "15", "batch": 4}],
      "connection_type": "shared_handle" | "structural_parallel" | "surprising",
      "bridge_potential": 0.0-1.0,
      "explanation": "why this bridges across batches"
    }
  ],
  "semantic_merges": [
    {
      "canonical_name": "unified concept name",
      "variants": ["name in batch 1", "name in batch 3"],
      "batches": [1, 3]
    }
  ],
  "bridge_candidates": [
    {
      "concept": "name",
      "batch_count": 3,
      "input_count": 5,
      "inputs": ["01", "04", "15", "23", "37"]
    }
  ]
}
```

### Round 2C: Connection Map Merge

合并 2A 和 2B 的所有连接到统一 connection map。

### Prompt 2C

```
You are merging all discovered connections into a unified connection map.

WITHIN-BATCH CONNECTIONS:
{all_2a_results}

CROSS-BATCH CONNECTIONS:
{all_2b_results}

Tasks:
1. Deduplicate: merge connections that describe the same underlying concept under different names
2. Build a concept inventory: list every unique concept with all inputs it connects
3. Flag potential bridges: concepts that connect inputs from 3+ different batches
4. Calculate coverage: what percentage of the 50 inputs are connected to at least one other input?

Output as JSON:
{
  "concepts": [
    {
      "name": "concept name",
      "connected_inputs": ["01", "04", "23", ...],
      "connected_domains": ["physical", "abstract", ...],
      "source_batches": [1, 4, 7],
      "total_connections": 5,
      "bridge_flag": true/false,
      "avg_weight": 0.0-1.0
    }
  ],
  "coverage": {
    "connected_inputs": 48,
    "total_inputs": 50,
    "isolated_inputs": ["33", "47"]
  },
  "bridge_candidates": ["concept_name_1", "concept_name_2", ...]
}
```

### 成本估算

- 2A: 10 calls × ~2000 tokens = ~$0.30 (sonnet)
- 2B: 3 calls × ~4000 tokens = ~$0.10 (sonnet)
- 2C: 1 call × ~5000 tokens = ~$0.05 (sonnet)
- **Subtotal: ~$0.69**

---

## Round 3: Synthesis & Bridge Discovery

### Round 3A: Transitive Path Discovery

从 connection map 出发，穷举性地发现 transitive paths。

### Prompt 3A

```
You are discovering transitive connections — indirect paths between inputs that have no direct connection.

CONNECTION MAP:
{connection_map_json}

Task: For every pair of inputs that are NOT directly connected, check if there exists a path through intermediate concepts:
- Input A connects to Concept X
- Concept X also connects to Input B
- Therefore A and B are transitively connected through X

More valuable paths:
- 2-hop: A → concept X → B (A and B share no direct concept, but both connect to X through different domains)
- 3-hop: A → X → intermediate input → Y → B

For each transitive path:
1. Rate surprise (1-10): would someone who read A and B independently ever notice this connection?
2. Rate depth (1-10): how structurally deep is the connection (vs surface analogy)?
3. Name the path: "A → B through [concept], via [intermediate]"

Find ALL 2-hop paths. Find the top 20 most surprising 3-hop paths.

Output as JSON:
{
  "two_hop_paths": [
    {
      "input_a": "01",
      "input_b": "17",
      "through_concept": "concept name",
      "surprise": 8,
      "depth": 7,
      "explanation": "why this path is meaningful"
    }
  ],
  "three_hop_paths": [
    {
      "input_a": "01",
      "intermediate": "23",
      "input_b": "47",
      "concepts": ["concept X", "concept Y"],
      "surprise": 9,
      "depth": 8,
      "explanation": "why this path is meaningful"
    }
  ]
}
```

### Round 3B: Bridge Concept Identification

从 connection map + transitive paths 中识别 bridge concepts。

### Prompt 3B

```
You are identifying bridge concepts — abstract ideas that connect otherwise disconnected domains.

CONNECTION MAP:
{connection_map_json}

TRANSITIVE PATHS:
{round_3a_results}

A bridge concept has these properties:
1. It connects inputs from 3+ different topical clusters (not just similar domains)
2. Removing it would disconnect parts of the concept network
3. It reveals a structural principle, not a surface similarity
4. It would surprise someone who read each connected input independently

Bridge score formula (approximate):
  bridge_score = connected_inputs × connected_domains × avg_connection_weight

For each bridge concept:
1. Name it precisely (2-5 words, evocative and specific — not generic like "interconnection")
2. List all inputs it connects
3. List all domains it spans
4. Count its transitive paths (from Round 3A)
5. Explain what structural principle it reveals
6. Rate: could a reader of any single connected input have independently named this concept? (Y/N)

Output the top 15, ranked by bridge_score.

Output as JSON:
{
  "bridges": [
    {
      "name": "bridge name",
      "bridge_score": 123.45,
      "connected_inputs": ["01", "04", ...],
      "connected_domains": ["physical", "abstract", ...],
      "transitive_path_count": 12,
      "structural_principle": "explanation",
      "independently_discoverable": false
    }
  ]
}
```

### Round 3C: Top 10 Surprising Connections

```
Review all connections, transitive paths, and bridges discovered so far. Select your top 10 most surprising structural discoveries — the ones most likely to change how someone thinks about these domains.

Criteria for selection:
1. Anti-intuitive: the connection runs counter to initial expectations
2. Generative: knowing this connection opens new questions or perspectives
3. Specific: it's not a vague platitude but a precise structural claim
4. Novel: it goes beyond established cross-disciplinary thinking (beyond "everything is a system")

For each, write a 2-3 sentence explanation that would make a smart generalist say "I never thought of it that way."

Output as JSON:
{
  "top_10": [
    {
      "rank": 1,
      "name": "discovery name",
      "inputs_involved": ["01", "04", "23"],
      "explanation": "2-3 sentences",
      "surprise_rating": 9,
      "type": "bridge" | "transitive_path" | "structural_parallel"
    }
  ]
}
```

### 成本估算

- 3A: 1 call × ~8000 tokens = ~$0.07 (sonnet)
- 3B: 1 call × ~6000 tokens = ~$0.05 (sonnet)
- 3C: 1 call × ~4000 tokens = ~$0.04 (sonnet)
- **Subtotal: ~$0.16**

---

## Round 4: Meta-Analysis & Adversarial Pruning

> **重要**: Round 4A 和 4B（pruning + meta-analysis）必须在 Round 4C（Organism comparison）之前执行。
> 看到 Organism 的 bridges 后再做自我分类会引入 contamination bias。

### Round 4A: Pattern-of-Patterns

```
You are performing meta-analysis — analyzing the structure of your own discoveries.

ALL BRIDGES:
{round_3b_bridges}

ALL TRANSITIVE PATHS:
{round_3a_paths}

TOP 10 SURPRISES:
{round_3c_top_10}

Questions to answer:
1. What does the structure of your connection map reveal? Which domains are most interconnected? Which are most isolated? Why?
2. Do your bridges cluster around certain themes, or are they uniformly distributed?
3. What's missing? Are there pairs of inputs that SHOULD be connected but aren't? What concept would bridge them?
4. What meta-pattern (pattern of patterns) emerges from your top 10 discoveries?
5. If you could add one more input to this corpus to maximally restructure the connection map, what topic would it be, and why?

Output as JSON:
{
  "structural_analysis": {
    "most_connected_domains": [...],
    "most_isolated_inputs": [...],
    "bridge_clustering": "description",
    "missing_connections": [...],
    "meta_pattern": "description",
    "suggested_51st_input": {"topic": "...", "rationale": "..."}
  }
}
```

### Round 4B: Adversarial Pruning

对所有发现进行自我过滤。**必须在看到 Organism bridges 之前执行，防止 contamination。**

```
You are performing adversarial self-evaluation. Classify every discovery from Rounds 3-4A into three categories:

RETRIEVAL: This insight is directly extractable from a single source document. A reader of that document alone would easily identify this pattern.

SYNTHESIS: This insight requires combining 2+ sources but follows logically from their content. A reader who read the relevant sources would likely notice this connection with moderate effort.

DISCOVERY: This insight requires a reasoning leap that goes beyond what any reader of the individual sources would naturally make. The connection exists at a structural level that is not signposted in any source.

For each discovery, also answer:
- "Could a smart generalist, given only the 50 topic NAMES (not content), independently produce this insight?" (Y/N)
- If Y, this is NOT a genuine discovery — it's derivable from topic-level associations.

Be ruthlessly honest. Most of your findings will be Retrieval or Synthesis. That's fine. The goal is to identify which, if any, are genuine Discoveries.

Input: ALL findings from Rounds 3-4A
{all_round_3_and_4a_findings}

Output as JSON:
{
  "classified": [
    {
      "finding": "name",
      "source": "round_3b" | "round_3c" | "round_4a",
      "classification": "retrieval" | "synthesis" | "discovery",
      "topic_name_derivable": true/false,
      "confidence": 0.0-1.0,
      "reasoning": "why this classification"
    }
  ],
  "summary": {
    "retrieval_count": 0,
    "synthesis_count": 0,
    "discovery_count": 0,
    "topic_derivable_count": 0
  }
}
```

### Round 4C: Organism Comparison (POST-PRUNING)

> 这一步在 4B pruning 之后执行。此时 Claude Code 的发现已被独立分类，不会被 Organism 的 bridges 影响。

```
Compare your top 10 bridge discoveries with these 10 bridge concepts discovered by a different system (Organism) analyzing the same 50 inputs:

ORGANISM'S TOP 10 BRIDGES:
1. Keystone Vulnerability (score: 352.66) — connects 27 inputs across 15 domains, 44 transitive chains
2. Structural Opacity (score: 287.93) — connects 22 inputs across 17 domains, 24 chains
3. Layered Epistemic Opacity (score: 195.14) — connects 17 inputs across 13 domains, 19 chains
4. Irreversible Distributed Knowledge Loss (score: 170.00) — connects 10 inputs across 17 domains, 11 chains
5. Epistemic Constraint (score: 168.32) — connects 11 inputs across 17 domains, 10 chains
6. Subthreshold Accumulation Preceding Phase-Shift (score: 163.40) — connects 17 inputs across 12 domains, 18 chains
7. Layered Epistemic Opacity via Historical Discontinuity (score: 162.98) — connects 10 inputs across 17 domains, 11 chains
8. Distributed Tacit Signal (score: 159.50) — connects 11 inputs across 25 domains, 15 chains
9. Keystone Vulnerability Ambiguity (score: 148.23) — connects 17 inputs across 9 domains, 20 chains
10. Generative vs. Catastrophic Thresholds (score: 130.16) — connects 14 inputs across 10 domains, 10 chains

YOUR TOP 10 BRIDGES:
{round_3b_top_10}

For each Organism bridge:
1. Did you discover the same concept (exact or near match)?
2. Did you discover something that partially overlaps?
3. Is this concept findable from your connection map but you didn't flag it?
4. Is this concept genuinely undetectable from your approach?

For each of your bridges that has no Organism match:
1. Is it genuinely novel, or a restatement of a well-known cross-disciplinary idea?
2. Would Organism's topology have found it?

Output as JSON:
{
  "comparison": [
    {
      "organism_bridge": "Keystone Vulnerability",
      "match_status": "exact" | "partial" | "findable_but_missed" | "undetectable",
      "your_nearest": "your bridge name or null",
      "explanation": "why match/mismatch"
    }
  ],
  "your_unique_bridges": [
    {
      "name": "your bridge",
      "genuinely_novel": true/false,
      "organism_would_find": true/false,
      "explanation": "..."
    }
  ]
}
```

### 成本估算

- 4A: 1 call × ~6000 tokens = ~$0.05 (sonnet)
- 4B: 1 call × ~8000 tokens = ~$0.07 (sonnet)
- 4C: 1 call × ~4000 tokens = ~$0.04 (sonnet)
- **Subtotal: ~$0.16**

---

## Evaluation

### E1: Boundary Test

与 Organism 使用相同的 boundary test 方法。将 Claude Code 的 top 10 bridges 交给 fresh Claude instance。

**实现**: 新对话（或 subagent with no prior context），使用以下 prompt：

```
You are given 50 topics spanning diverse domains: security, cooking, investing, ecology, teaching, architecture, music, medicine, game design, philosophy, military strategy, parenting, software architecture, gardening, jazz pedagogy, bridge engineering, chemistry, epidemiology, sports coaching, linguistics, food safety, portfolio rebalancing, forest fire recovery, online education, acoustic architecture, medical AI, competitive gaming, philosophy of technology, ecological investing, food security, systems thinking, resilience engineering, information theory, emergence, feedback loops, adaptation vs optimization, role of constraints, time and patience, trust in distributed systems, paradox of control, security theater, over-seasoning, index funds, monoculture advantages, rote learning, brutalist architecture, atonal music, folk medicine, unfair game design, utility of dogmatism.

Without any additional context, identify cross-domain bridge patterns — abstract structural concepts that connect 3 or more of these unrelated domains in non-obvious ways. Name each pattern precisely (2-5 words). Generate your top 10.
```

**匹配规则**: 使用 embedding cosine similarity（threshold 0.5）或人工判断。

| Metric | Result |
|---|---|
| Claude Code bridges boundary-unique | __/10 |
| Organism bridges boundary-unique | 9/10 |

### E2: Embedding-Based Bridge Comparison

计算 Claude Code 和 Organism bridges 之间的 pairwise cosine similarity。

```python
# Pseudocode
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('BAAI/bge-large-en-v1.5')

cc_bridges = [...]  # Claude Code top 10
org_bridges = [...]  # Organism top 10

cc_emb = model.encode(cc_bridges)
org_emb = model.encode(org_bridges)

# Pairwise similarity matrix
similarity = cosine_similarity(cc_emb, org_emb)
# Match if max similarity > 0.5
```

### E3: Judge Comparison

使用相同的 5 个 judge queries，sonnet 作为 judge，blind A/B 对比。

**5 queries**:

1. "What connects security to cooking?"
2. "What pattern appears in 3+ different domains?"
3. "What's the deepest insight from combining all inputs?"
4. "What connection would surprise someone who read each input separately?"
5. "What bridge concept connects the most different domains, and why?"

**Process**:
1. 用 Claude Code 的 connection map + bridges 回答 5 个 queries
2. 使用 Organism 的现有 query 回答（from `results-l3/scale-test-results.json`）
3. Sonnet judge 做 blind A/B comparison（randomize order），按 4 个维度打分：
   - insightDepth (1-10)
   - crossDomainSynthesis (1-10)
   - specificity (1-10)
   - surprise (1-10)

**Organism 参考分数**:

| Query | Topology Score | Baseline Score |
|---|---|---|
| Security ↔ cooking | 28 | 32 |
| Pattern in 3+ domains | 26 | 33 |
| Deepest insight | 33 | 31 |
| Surprising connection | 28 | 34 |
| Bridge connecting most domains | 28.5 | 34 |

### E4: Human Scoring Protocol

与 Organism Test H 相同的协议：

1. 阅读 Claude Code 的 top 10 bridges
2. 每个 bridge 评分 1-5："这个 bridge 是否有意义？"
3. 阅读 top 5 transitive paths
4. 每条路径评分 1-5："这个连接是否 make sense？"
5. 整体评分 1-5："Claude Code 是否'理解'了这 50 个 inputs 的关系？"
6. 平均所有分数。Pass threshold: 3.5

**Organism 参考**: 平均 4.17/5 (Pass)

### E5: Structural Novelty Classification

| Finding | Classification | Topic-Name Derivable? |
|---|---|---|
| Bridge 1 | R / S / D | Y / N |
| Bridge 2 | R / S / D | Y / N |
| ... | ... | ... |

---

## 成本估算汇总

| Round | Calls | Estimated Cost |
|---|---|---|
| Round 1: Decomposition | 50 | $0.05 (haiku) / $0.45 (sonnet) |
| Round 2A: Within-batch | 10 | $0.30 |
| Round 2B: Cross-batch | 3 | $0.10 |
| Round 2C: Merge | 1 | $0.05 |
| Round 3A: Transitive paths | 1 | $0.07 |
| Round 3B: Bridge identification | 1 | $0.05 |
| Round 3C: Top 10 surprises | 1 | $0.04 |
| Round 4A: Meta-analysis | 1 | $0.05 |
| Round 4B: Adversarial pruning | 1 | $0.07 |
| Round 4C: Organism comparison | 1 | $0.04 |
| E1: Boundary test | 1 | $0.02 |
| E3: Judge queries (5 + judge) | 15 | $0.50 |
| **Total** | **~86-91** | **~$1.34 - $1.74** |

对比 Organism: $33.59 for 882 calls = **19-25x cheaper**

---

## Decision Criteria

### Boundary Test

| Claude Code Result | Interpretation |
|---|---|
| 0-2/10 boundary-unique | **Organism wins decisively.** Claude Code finds only known patterns. Topology produces genuinely novel structure. |
| 3-5/10 boundary-unique | **Organism wins on novelty.** Claude Code finds some novel bridges but ~half are derivable from topic names alone. Topology's exhaustive traversal finds more of the "hidden" connections. |
| 6-8/10 boundary-unique | **Draw / depends on quality.** Both systems find novel bridges. Compare head-to-head: which bridges are more surprising, more generative, more precisely named? |
| 9-10/10 boundary-unique | **Claude Code matches Organism.** If bridges are also comparable in quality and specificity, Organism's topology overhead is not justified for bridge discovery. Organism must find value elsewhere (exhaustiveness, reproducibility, cost-at-scale). |

### Judge Comparison

| Claude Code vs Organism | Interpretation |
|---|---|
| CC scores < Organism on 4+/5 queries | Topology produces better query answers. The structural context helps. |
| CC scores ≈ Organism (±2 per query) | Both produce comparable query answers. Topology's value is not in individual query quality. |
| CC scores > Organism on 4+/5 queries | Claude Code is better at answering queries. This is expected — Organism lost to baseline on 4/5 judge queries. The question is whether Claude Code can ALSO discover novel bridges. |

### Human Scoring

| Claude Code Average | Interpretation |
|---|---|
| < 3.5 | Bridges don't make sense. Quantity without quality. |
| 3.5 - 4.0 | Decent but below Organism's 4.17. Some bridges are meaningful, some are forced. |
| 4.0 - 4.5 | Comparable to Organism. Both produce meaningful bridges. |
| > 4.5 | Better than Organism. Claude's language model advantage in articulation. |

### Composite Decision

| Scenario | Verdict |
|---|---|
| Boundary ≤ 3, Judge ≈, Human < 4.0 | **Organism's core value confirmed.** Topology finds what LLM reasoning cannot. |
| Boundary 4-6, Judge ≈, Human ≈ | **Organism has edge but not decisive.** Need to evaluate cost/value ratio. At $33 vs $2, Claude Code may be "good enough." |
| Boundary 7+, Judge ≈, Human ≈ | **Organism needs repositioning.** Value is in exhaustiveness/reproducibility, not unique discovery. |
| Boundary 7+, Judge >, Human > | **Organism's approach is not competitive.** Simpler multi-call approach is better AND cheaper. |

---

## Prediction

| 维度 | Claude Code 预测 | Organism 实际 |
|---|---|---|
| Boundary-unique bridges | 4-5/10 | 9/10 |
| Judge query avg | ~30/40 | 29.1/40 (lost to baseline) |
| Human rating avg | ~3.8/5 | 4.17/5 |
| Transitive paths found | ~30-50 | 204 |
| Discovery-class findings | ~3-4/10 | ~8/10 |
| Cost | ~$2 | $33.59 |

**预测逻辑**:
- Claude Code 的 batching + systematic prompting 会找到 obvious + moderately-surprising connections
- 但 exhaustive transitive path discovery 需要 combinatorial search，LLM 做不到穷举
- Anti-intuitive bridges（如 "Distributed Tacit Signal" 连接 folk medicine 到 epidemiology）需要看到 intermediate conceptual stepping stones，sequential prompting 会 miss 多数
- Judge queries: Claude Code 可能 slightly outperform Organism（因为 Organism 输给了 baseline 4/5）——but this measures query answering, not structural discovery
- Cost advantage is massive: if Claude Code gets 60% of the discovery quality at 6% of the cost, that's a meaningful result

---

## 实现注意事项

### Subagent 策略

Round 1 的 50 个 decomposition 可以并行执行（Task tool with haiku model, 50 independent subagents）。这是最大的并行化机会。

Round 2A 的 10 个 batch 也可并行。

Round 2B 的 45 个 cross-batch pairs 可并行但需要 2A 先完成。

Rounds 3-5 是 sequential（每轮依赖上一轮的输出）。

### 输出持久化

每个 round 的 JSON 输出保存到 `results-claude-code/round-{n}/`。这允许：
- 中断后恢复（从最后完成的 round 继续）
- 事后分析（不需要重跑实验）
- 与 Organism 的 `results-l3/` 直接对比

### 可复现性

记录每次 API 调用的 model、temperature（建议 0.3 for decomposition, 0.7 for discovery）、token usage。存入 `results-claude-code/cost-log.json`。

### 与 NotebookLM 实验的对比

两个实验使用完全相同的评估方法：
- Boundary test（相同 prompt, 相同 matching threshold）
- Human scoring（相同 1-5 scale, 相同 criteria）
- Retrieval/Synthesis/Discovery classification（相同定义）
- Judge comparison（相同 5 queries, 相同 4 dimensions, 相同 judge model）

这保证三方（NotebookLM, Claude Code, Organism）可以 apples-to-apples 对比。
