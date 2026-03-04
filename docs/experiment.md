# Organism 竞争性实验设计

**日期**: 2026-03-02
**来源**: 基于 vision-3.2, tasks.md, enriched-analysis, agentic-graph.md 的综合分析

---

## 实验协议

两个详细的实验协议已就绪：

| 实验 | 协议文档 | 角色 | 成本 | 时间 |
|---|---|---|---|---|
| **NotebookLM** | [docs/notebooklm.md](notebooklm.md) | Retrieval baseline | 免费 | ~2-3h (手动) |
| **Claude Code 多轮** | [docs/claude-code.md](claude-code.md) | Existential test | ~$2-3 | ~30min (自动) |
| **Organism (已有)** | results-l3/ | Reference | $33.59 | ~2h (已完成) |

三方使用完全相同的评估方法：Boundary test, Human scoring (1-5), Judge comparison (5 queries × 4 dimensions), Retrieval/Synthesis/Discovery classification。

### 核心问题

> 更简单的方法能否达到 Organism 输出中那些高分涌现的质量？

### Organism 已有数据快照

- **Boundary test**: 9/10 topology-unique
- **Human scoring**: 4.17/5 (Pass, threshold 3.5)
- **Judge test**: Topology 1-4 Baseline (143.5 vs 164)
- **Transitive paths**: 204 emergent
- **Cost**: $33.59 / 882 API calls
- **Top bridge**: Keystone Vulnerability (score 352.66, 27 inputs, 15 domains, 44 chains)

---

## 背景与动机

提出两个竞争性实验来测试 Organism 的核心价值：

1. **NotebookLM 实验**：将 Organism 的 input 作为 resources 直接放进 Google NotebookLM，重新设计 prompt 和规则以适配 NotebookLM 的范式（notebook instructions 中定义 conversational goal/style/role，分散放置在不同配置位置），output 通过 prompt 提问或 studio 功能（mind map、reports 等）产出。

2. **Claude Code 多轮聚合实验**：用 Claude Code 直接处理相同 input，通过对话进行分解、连接等操作。之前已做过单轮对比（结果不如 Organism）。关键创新：将第一轮所有 Claude Code 输出以 input 形式再次进行一遍完整流程（prompt 和细节需要重新设计以适配），测试 Claude Code 能否通过多轮聚合对话实现拓扑结构能做到的事情。Claude Code 不用担心 token cost，可以进行多轮测试。

核心问题：这些方法能否达到涌现结构，或者达到 Organism 输出中那些高分涌现的质量？

---

## 总判断：值得做，但两个实验的价值完全不同

---

## 实验 1：NotebookLM — 值得做但不是竞争者

**它本质上是 retrieval baseline，不是 discovery competitor。**

NotebookLM 是 source-grounded 系统——Gemini 只能从上传的文档中提取和重组信息。enriched-analysis.md Section 10 已经明确了这个区分：

> GraphRAG answers: "What does the text say about X?" Organism answers: "What structural patterns exist across all texts that no individual text reveals?"

NotebookLM 做的是前者。它的 mind map、report、FAQ 都是对已有内容的重组和摘要，不是跨域结构发现。即使精心设计 notebook instructions（role、style、conversational goal），它仍然被限制在 source faithfulness 范围内——这正是它的设计目标，也是它不可能产生涌现的原因。

### NotebookLM 适配设计思路

NotebookLM 的配置入口：
- **Notebook Instructions**: "Notebooks can be customized to help you achieve different goals: do research, help learn, show various perspectives, or converse in a particular style and tone. Define your conversational goal, style, or role" — 这里可以注入 Organism 的 decomposition 规则和 cross-domain 发现目标
- **提问 Prompt**: 需要精心设计以引导 Gemini 做跨文档的结构性分析而非单文档摘要
- **Studio 功能**: Mind Map（可视化结构）、Reports（综合分析）、FAQ（问题驱动发现）

### 作为 lower bound 的价值

如果 NotebookLM 通过 retrieval + Gemini 推理就能产生那些高分 bridge 洞察，那说明 Organism 的 topology 是 overhead。如果不能（预测不能），它量化了 retrieval 和 discovery 之间的差距。

### 预期结果

NotebookLM 会在综合摘要、事实问答上表现优秀，但不会产生 topology-unique bridges。它会找到文档中已经暗示的连接，但不会发现 A-C 类型的 transitive 连接（因为 Gemini 不做跨文档的结构性遍历）。

### 投入

~1-2 小时设置 + 测试，值得做。

---

## 实验 2：Claude Code 多轮聚合 — 这是真正的 existential test

这是最重要的实验。

### 为什么这是正确的竞争者

enriched-analysis.md Section 1 直接指出了这个问题：

> Organism must demonstrate that its specific structural mechanism (faceted decomposition + graph traversal) produces value that simpler multi-call approaches (e.g., just running Claude 50 times with different prompts and concatenating results) cannot.

Claude Code 多轮聚合正是这个 "simpler multi-call approach" 的最强版本。

### 关键结构差异分析

Organism 做了什么是 Claude Code 本质上难以复制的：

#### 1. 独立性（Independence）

Organism 的 50 次 decompose 调用是完全独立的——每次只看一个 input，不受其他 49 个的影响。这意味着每个 input 被平等地、深入地分析。Claude Code 在对话中处理 50 个 input 时，注意力不可避免地偏向近期/显著内容。agentic-graph.md §16.1 指出这正是 Graph→LLM 的核心问题：

> 两个项目（Buehler 和 Organism）都没有解决让图结构对 LLM "可读"的问题

但反过来看，LLM 对话也没有解决让"所有 input 获得平等注意力"的问题。

#### 2. 组合性（Composability）

这是最关键的差异。Organism 的 transitive path 发现是机械性的：
- Call 1 产生 A→B
- Call 2 产生 B→C
- Graph traversal 发现 A→C（零 LLM 调用）

Claude Code 需要"注意到"A-C 关系，这依赖于：注意力是否同时覆盖 A-B 和 B-C，prompt 是否引导它寻找传递连接，上下文窗口是否足够。对于 204 条 emergent paths 中的每一条，Claude 都必须显式地发现它——而 graph traversal 是穷举的。

#### 3. 穷举性（Exhaustiveness）

Graph traversal（BFS/DFS）检查所有可能的路径。Claude Code 的推理是选择性的——它找到看起来最相关的连接，但会遗漏不那么直觉的路径。而 Organism 中最有价值的发现恰恰是那些反直觉的 bridge（boundary test 证明了这一点：9/10 是 Claude 独立无法发现的）。

### 多轮聚合可能改变局面

提出的关键设计——把第一轮所有输出作为第二轮的 input——本质上是用对话模拟 dimension elevation（enriched Section 14）。这确实可能部分弥补上述差距：

- 第一轮：分散处理，产生初步连接
- 第二轮：以第一轮输出为 input，可能发现 meta-connections
- 第三轮（如果需要）：进一步聚合

这实际上是在用 sequential LLM calls 模拟 graph accumulation。理论上，如果轮次足够多，信息终会被充分组合。

### 结构性限制

#### a) 注意力稀释不会因多轮而消失

第二轮的 input 是第一轮的所有输出——信息量更大但更抽象。Claude 仍然会做选择性注意力分配。而 topology 的优势在于它保持了所有连接的平等存在——没有任何连接因为"不够显眼"而被忽略。

#### b) 组合爆炸 vs 选择性遗漏

50 个 input → 360 个 concepts → 数千条可能的 transitive path。Graph traversal 穷举所有。Claude Code 即使在多轮中也只会发现其中最显著的子集。问题是：被遗漏的那些，是否恰好包含那些高分涌现？

从已有数据看，高分涌现往往是反直觉的（否则单次 Claude 就能发现）。反直觉的连接恰恰是 LLM 选择性推理最容易跳过的。

#### c) vision-3.2 的核心论点

> 结构性计算独立于 LLM——204 条 emergent paths 中没有一条是 LLM "想出来的"，它们是图遍历的数学结果。

多轮 Claude Code 的每一个发现都是 LLM "想出来的"。区别在于：topology 的发现来自结构，Claude 的发现来自推理。如果某个 bridge 需要 3 跳传递才能到达，topology 保证找到它，Claude 需要显式推理链——而 agentic-graph.md §16 记录了 LLM 在长推理链上的不可靠性。

---

## 实验设计建议

### 评估标准（关键）

enriched Section 13 已经说了："Stop using Judge-style text comparison." 正确的评估是：

1. **Boundary test**（最强验证）：每个系统产出的 top-10 bridges/insights，让一个 fresh Claude instance（没见过任何过程）尝试独立产生相同发现。Organism 已有数据：9/10 boundary-unique。Claude Code 多轮和 NotebookLM 分别能达到几/10？

2. **人工打分**：直接对比——哪些涌现让你觉得"这是我自己想不到的"？这才是 cognitive springboard 价值。

3. **结构新颖性**：不是文字质量，而是连接的新颖性。A 和 C 之间的关系，是文档中已经暗示的（retrieval），还是需要通过 B 才能发现的（structural discovery）？

### Claude Code 多轮的具体设计

- **Round 1**：50 个 input，prompt 要求做 faceted decomposition（模拟 Organism 的 7 domain），然后 cross-input connection finding
- **Round 2**：Round 1 的全部输出作为 input，prompt 要求做 meta-analysis——"what patterns across these connections suggest deeper structural relationships?"
- **Round 3**：Round 2 的输出 + 原始 50 inputs，prompt 要求 identify bridges（"concepts that connect otherwise separate domains"）
- **可选 Round 4**：adversarial round——"which of these bridges are trivially derivable from any single input? Remove those."

关键 prompt 设计原则：每轮的 prompt 必须 explicitly 引导 Claude 做 Organism 自动做的事（穷举遍历、传递性发现、反偏好连接）。如果不做这个引导，Claude 会自然地走最短路径——产生显而易见的连接。

---

## 预测

| 维度 | NotebookLM | Claude Code 多轮 | Organism |
|---|---|---|---|
| 综合摘要质量 | 最好 | 好 | 中等（observation collapse） |
| 显性跨域连接 | 中等 | 好 | 好 |
| 反直觉 bridge | 差 | 中等 | 最好 |
| Boundary-unique 发现 | ~1/10 | ~4-5/10 | 9/10 |
| 穷举性 | 无 | 选择性 | 穷举 |
| 可复现性 | 高 | 低（路径依赖） | 中（路径依赖但结构稳定） |

**Claude Code 多轮会是一个强对手，但会在反直觉发现上输给 topology。** 原因是组合性和穷举性——这是结构计算相对于序列推理的根本优势。但如果 Claude Code 多轮在 3 轮内就能产生 7/10 boundary-unique 发现，那 Organism 的 topology 优势虽然存在但可能不值得 $33/run 的代价。

---

## 最终判断与优先级

**两个实验都值得做，但优先级明确：**

1. **Claude Code 多轮是必须做的**——这是 Organism 的 existential validation。如果多轮对话能达到同等质量，Organism 需要重新定位（从"结构发现引擎"变成"高效结构发现引擎——更快、更穷举"）。如果不能，Organism 的核心价值被确认。

2. **NotebookLM 值得花 1-2 小时做**——作为 retrieval baseline，量化 discovery 和 retrieval 之间的差距。但不要在这上面投入太多设计精力——它不是同类竞争者。

**最有价值的结果**不是"谁赢了"，而是**差异在哪里**：
- Organism 产生而 Claude Code 没产生的 bridges → 这些是 topology 的独特价值
- Claude Code 产生而 Organism 没产生的 insights → 这些暴露 topology 的盲点
- 两者都产生的 → 这些是 structural attractors（enriched Section 5），最高置信度的发现

---

## 文档参考

本文分析基于以下文档：
- `vision-3.2`：Organism 核心设计文档，observation collapse 分析，三条 receiver path
- `tasks.md`：实验优先级列表
- `enriched-analysis.md`：519 资源的研究分析，20 个 section 的决策矩阵
- `agentic-graph.md`：1165 行 Buehler 生态系统 + 竞争分析 + 代码深度解剖
- `map.md`：17 branch 研究地图，12 contested findings
- 已有实验数据：L2 Judge test (1-9), L3 Judge (1-4), Boundary test (9/10 topology-unique)
