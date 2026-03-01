import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { Facet, Concept, Chain, ChainStep, ComparisonResult, TopologyState, FacetPair, SignalQueryContext } from './types.js';
import { CostTracker } from './cost.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status;
      const isParseError = err?.message?.includes('Failed to parse structured output');
      const retryable = status === 500 || status === 529 || status === 503 || status === 429 || isParseError;
      if (retryable && attempt < maxRetries - 1) {
        const retryAfter = err?.headers?.['retry-after'];
        const baseDelay = status === 429 ? 60000 : isParseError ? 5000 : 2000;
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelay * Math.pow(2, attempt);
        const reason = isParseError ? 'JSON parse' : `${status}`;
        console.log(`  API error (${reason}), retrying in ${Math.round(delay / 1000)}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

const DecomposeSchema = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          facets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
                attribute: { type: 'string' },
                salience: { type: 'number' },
              },
              required: ['domain', 'attribute', 'salience'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'facets'],
        additionalProperties: false,
      },
    },
  },
  required: ['concepts'],
  additionalProperties: false,
} as const;

const ConnectSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pairIndex: { type: 'number' },
          connected: { type: 'boolean' },
          chain: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fromConcept: { type: 'string' },
                fromFacet: { type: 'string' },
                toConcept: { type: 'string' },
                toFacet: { type: 'string' },
              },
              required: ['fromConcept', 'fromFacet', 'toConcept', 'toFacet'],
              additionalProperties: false,
            },
          },
          confidence: { type: 'number' },
          domainsCrossed: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['pairIndex', 'connected', 'chain', 'confidence', 'domainsCrossed'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const;

const CrystallizationSchema = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          facets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
                attribute: { type: 'string' },
                salience: { type: 'number' },
                novelty: { type: 'boolean' },
                tension: { type: 'string', nullable: true },
              },
              required: ['domain', 'attribute', 'salience', 'novelty'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'facets'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          relatedConcepts: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'relatedConcepts'],
        additionalProperties: false,
      },
    },
  },
  required: ['concepts', 'questions'],
  additionalProperties: false,
} as const;

const CompareSchema = {
  type: 'object',
  properties: {
    appeared: { type: 'array', items: { type: 'string' } },
    disappeared: { type: 'array', items: { type: 'string' } },
    shifted: { type: 'array', items: { type: 'string' } },
    crossInputChains: { type: 'array', items: { type: 'string' } },
    interpretation: { type: 'string' },
  },
  required: ['appeared', 'disappeared', 'shifted', 'crossInputChains', 'interpretation'],
  additionalProperties: false,
} as const;

export interface DecomposeResult {
  concepts: Array<{ name: string; facets: Facet[] }>;
}

export interface CrystallizationResult {
  concepts: Array<{ name: string; facets: Facet[] }>;
  questions: Array<{ text: string; relatedConcepts: string[] }>;
}

export interface ConnectResult {
  chain: ChainStep[];
  confidence: number;
  domainsCrossed: string[];
}

export class Operations {
  private client: Anthropic;
  private costTracker: CostTracker;

  constructor(client: Anthropic, costTracker: CostTracker) {
    this.client = client;
    this.costTracker = costTracker;
  }

  async decompose(text: string, identityContext?: string): Promise<DecomposeResult> {
    this.costTracker.checkBudget();

    const identityPrefix = identityContext
      ? `${identityContext}\n\nPay special attention to concepts that extend or challenge your existing connections.\n\n`
      : '';

    const message = await withRetry(() => this.client.messages.parse({
      model: HAIKU,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `${identityPrefix}Given this text, extract 3-8 key concepts. For each concept, identify 5-10 distinct facets.

Each facet has:
- domain: one of "physical", "abstract", "social", "temporal", "process", "structural", "emotional"
- attribute: the specific quality or association (one or two words)
- salience: how prominent this facet is in the given context (0.0-1.0)

Text:
${text}`,
        },
      ],
      output_config: {
        format: jsonSchemaOutputFormat(DecomposeSchema),
      },
    }));

    this.costTracker.record(
      'decompose',
      HAIKU,
      message.usage.input_tokens,
      message.usage.output_tokens
    );

    return message.parsed_output as DecomposeResult;
  }

  async decomposeCrystallize(
    text: string,
    topologyContext: {
      topBridges: string[];
      recentRearrangements: string[];
      highUncertaintyRegions: string[];
      currentIdentity?: string;
    },
  ): Promise<CrystallizationResult> {
    this.costTracker.checkBudget();

    // Phase A: Sonnet free thinking (NOT structured output)
    const contextLines = [
      topologyContext.topBridges.length > 0 ? `Current bridge concepts: ${topologyContext.topBridges.join(', ')}` : '',
      topologyContext.recentRearrangements.length > 0 ? `Recent rearrangements: ${topologyContext.recentRearrangements.join('; ')}` : '',
      topologyContext.highUncertaintyRegions.length > 0 ? `Uncertain regions: ${topologyContext.highUncertaintyRegions.join(', ')}` : '',
      topologyContext.currentIdentity ? `Identity: ${topologyContext.currentIdentity}` : '',
    ].filter(Boolean).join('\n');

    const thinkMessage = await withRetry(() => this.client.messages.create({
      model: SONNET,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are analyzing a text that will be integrated into a knowledge topology. Think freely about what's genuinely new, what challenges existing connections, what deepens understanding, and what questions arise.

${contextLines ? `Topology context:\n${contextLines}\n\n` : ''}Text to analyze:
${text}

Think in 200-400 words. Focus on:
- What's genuinely new here vs what's familiar?
- What challenges or contradicts existing connections?
- What deepens or extends current understanding?
- What questions does this raise that the topology can't yet answer?`,
        },
      ],
    }));

    const thinkText = thinkMessage.content.find((b) => b.type === 'text')?.text ?? '';
    this.costTracker.record(
      'decompose-think',
      SONNET,
      thinkMessage.usage.input_tokens,
      thinkMessage.usage.output_tokens,
    );

    // Phase B: Haiku structured extraction
    const extractMessage = await withRetry(() => this.client.messages.parse({
      model: HAIKU,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Based on this analysis, extract structured concepts with domain-qualified facets.

Analysis:
${thinkText}

Original text:
${text}

Extract 3-8 key concepts. For each concept, identify 5-10 distinct facets.
Each facet has:
- domain: one of "physical", "abstract", "social", "temporal", "process", "structural", "emotional"
- attribute: a domain-qualified quality (e.g., for structural: "structural-layering", for process: "iterative-refinement")
- salience: how prominent this facet is (0.0-1.0)
- novelty: true if this facet represents something new not captured by existing topology bridges
- tension: if this facet contradicts or challenges an existing connection, describe the tension (null otherwise)

Also extract 0-5 questions this text raises that the topology might not yet be able to answer.`,
        },
      ],
      output_config: {
        format: jsonSchemaOutputFormat(CrystallizationSchema),
      },
    }));

    this.costTracker.record(
      'decompose-extract',
      HAIKU,
      extractMessage.usage.input_tokens,
      extractMessage.usage.output_tokens,
    );

    const parsed = extractMessage.parsed_output as CrystallizationResult;
    return {
      concepts: parsed.concepts.map((c) => ({
        name: c.name,
        facets: c.facets.map((f) => ({
          domain: f.domain,
          attribute: f.attribute,
          salience: f.salience,
          novelty: (f as any).novelty,
          tension: (f as any).tension ?? null,
        })),
      })),
      questions: parsed.questions ?? [],
    };
  }

  async connect(pairs: FacetPair[], topologyContext: string): Promise<Array<ConnectResult | null>> {
    if (pairs.length === 0) return [];
    this.costTracker.checkBudget();

    const pairsText = pairs
      .map(
        (p, i) =>
          `Pair ${i}: "${p.facetA.concept}" facet [${p.facetA.facet.domain}:${p.facetA.facet.attribute}] → "${p.facetB.concept}" facet [${p.facetB.facet.domain}:${p.facetB.facet.attribute}]`
      )
      .join('\n');

    const message = await withRetry(() => this.client.messages.parse({
      model: SONNET,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `For each pair of facets below, trace an association chain from A to B through intermediate concepts.

Each step: one concept's facet connects to another concept's facet through genuine association.
The chain must feel NATURAL — forced connections are worse than no connection.
If no genuine chain exists within 7 steps, mark as not connected.

Known topology context:
${topologyContext || 'Empty — first input.'}

Pairs:
${pairsText}

For each pair, return whether a connection exists, the chain of steps, a confidence score (0.0-1.0), and which domains were crossed.`,
        },
      ],
      output_config: {
        format: jsonSchemaOutputFormat(ConnectSchema),
      },
    }));

    this.costTracker.record(
      'connect',
      SONNET,
      message.usage.input_tokens,
      message.usage.output_tokens
    );

    const parsed = message.parsed_output as {
      results: Array<{
        pairIndex: number;
        connected: boolean;
        chain: ChainStep[];
        confidence: number;
        domainsCrossed: string[];
      }>;
    };

    return pairs.map((_, i) => {
      const result = parsed.results.find((r) => r.pairIndex === i);
      if (!result || !result.connected || result.confidence <= 0.6) return null;
      return {
        chain: result.chain,
        confidence: result.confidence,
        domainsCrossed: result.domainsCrossed,
      };
    });
  }

  async compare(previous: TopologyState, current: TopologyState): Promise<ComparisonResult> {
    this.costTracker.checkBudget();

    // Only send the delta to avoid massive prompts as topology grows
    const prevConceptIds = new Set(previous.concepts.map((c) => c.id));
    const prevChainIds = new Set(previous.chains.map((c) => c.id));

    const newConcepts = current.concepts.filter((c) => !prevConceptIds.has(c.id));
    const newChains = current.chains.filter((c) => !prevChainIds.has(c.id));
    const removedChains = previous.chains.filter((c) => !new Set(current.chains.map((x) => x.id)).has(c.id));

    // Cross-input chains from entire current state (but just names)
    const crossInputChains = current.chains.filter((c) => {
      const fromLower = c.fromConcept.toLowerCase();
      const toLower = c.toConcept.toLowerCase();
      const fromConcept = current.concepts.find((x) => x.name.toLowerCase() === fromLower);
      const toConcept = current.concepts.find((x) => x.name.toLowerCase() === toLower);
      return fromConcept && toConcept && fromConcept.sourceInput !== toConcept.sourceInput;
    });

    const formatConcepts = (cs: typeof newConcepts) =>
      cs.map((c) => `  ${c.name} [input ${c.sourceInput}]: ${c.facets.map((f) => `${f.domain}:${f.attribute}`).join(', ')}`).join('\n');
    const formatChains = (cs: typeof newChains) =>
      cs.map((c) => `  ${c.fromConcept} → ${c.toConcept} (depth ${c.depth}, weight ${c.weight.toFixed(2)})`).join('\n');

    const message = await withRetry(() => this.client.messages.parse({
      model: SONNET,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Analyze topology changes from run ${previous.runCount} to ${current.runCount}.

Summary: ${previous.concepts.length}→${current.concepts.length} concepts, ${previous.chains.length}→${current.chains.length} chains

New concepts (${newConcepts.length}):
${formatConcepts(newConcepts) || '  (none)'}

New chains (${newChains.length}):
${formatChains(newChains) || '  (none)'}

Removed/decayed chains (${removedChains.length}):
${formatChains(removedChains) || '  (none)'}

Cross-input chains total (${crossInputChains.length}):
${formatChains(crossInputChains.slice(0, 30)) || '  (none)'}
${crossInputChains.length > 30 ? `  ... and ${crossInputChains.length - 30} more` : ''}

What changed? Focus on:
- What new connections appeared and why they matter
- What connections disappeared and whether that loss is significant
- Which cross-input chains are most surprising or valuable
- What does this change REVEAL — not just what's different, but what the difference means`,
        },
      ],
      output_config: {
        format: jsonSchemaOutputFormat(CompareSchema),
      },
    }));

    this.costTracker.record(
      'compare',
      SONNET,
      message.usage.input_tokens,
      message.usage.output_tokens
    );

    return message.parsed_output as ComparisonResult;
  }

  async queryWithTopology(question: string, topology: TopologyState): Promise<string> {
    this.costTracker.checkBudget();

    const formatState = (s: TopologyState): string => {
      const concepts = s.concepts
        .map((c) => `  ${c.name} [from input ${c.sourceInput}]: ${c.facets.map((f) => `${f.domain}:${f.attribute}`).join(', ')}`)
        .join('\n');
      const chains = s.chains
        .map((c) => `  ${c.fromConcept} → ${c.toConcept} (depth ${c.depth}, weight ${c.weight.toFixed(2)}, domains: ${c.domainsCrossed.join(',')})`)
        .join('\n');
      return `Concepts (${s.concepts.length}):\n${concepts}\n\nChains (${s.chains.length}):\n${chains}`;
    };

    const message = await withRetry(() => this.client.messages.create({
      model: SONNET,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `You have access to a knowledge topology — a network of concepts connected through facet-based association chains. Use this topology to answer the question, paying special attention to cross-domain connections and chains that link concepts from different source inputs.

Topology:
${formatState(topology)}

Question: ${question}

Answer based on what the topology reveals. Highlight any non-obvious cross-domain connections.`,
        },
      ],
    }));

    const textBlock = message.content.find((b) => b.type === 'text');
    this.costTracker.record(
      'query-topology',
      SONNET,
      message.usage.input_tokens,
      message.usage.output_tokens
    );

    return textBlock?.text ?? '';
  }

  async queryWithSignal(question: string, context: SignalQueryContext): Promise<string> {
    this.costTracker.checkBudget();

    let bridgeSection = '';
    if (context.bridges.length > 0) {
      bridgeSection = context.bridges.map(b =>
        `BRIDGE: "${b.name}" connects ${b.domains.join(', ')} through ${b.structuralClaim}. ` +
        `Confirmed across ${b.sourceCount} independent sources.`
      ).join('\n\n');
    }

    let pathSection = '';
    if (context.emergentPaths.length > 0) {
      pathSection = '\nHIDDEN CONNECTIONS (discovered through transitive analysis):\n' +
        context.emergentPaths.map(p =>
          `${p.from} → ${p.to} (through: ${p.hops.join(' → ')})`
        ).join('\n');
    }

    let tensionSection = '';
    if (context.contradictions.length > 0) {
      tensionSection = '\nUNRESOLVED TENSIONS:\n' +
        context.contradictions.map(c => c.description).join('\n');
    }

    const prompt = `You are answering a question using insights from a knowledge topology that has processed ${context.inputCount} diverse sources across ${context.domainCount} domains.

${bridgeSection ? `Structural patterns discovered:\n\n${bridgeSection}` : ''}
${pathSection}
${tensionSection}

Question: ${question}

Answer with a single coherent insight, not a list. Explain WHY the structural connection holds, not just THAT it exists. If the topology's patterns are relevant, ground your answer in them. If they're not relevant to this question, say so honestly.`;

    const message = await withRetry(() => this.client.messages.create({
      model: SONNET,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }));

    const textBlock = message.content.find(b => b.type === 'text');
    this.costTracker.record('query-topology', SONNET,
      message.usage.input_tokens, message.usage.output_tokens);
    return textBlock?.text ?? '';
  }

  async queryWithFlatMemory(question: string, memory: string): Promise<string> {
    this.costTracker.checkBudget();

    const message = await withRetry(() => this.client.messages.create({
      model: SONNET,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `You have access to a collection of summarized knowledge from various inputs. Use this knowledge to answer the question.

Knowledge:
${memory}

Question: ${question}

Answer based on what the knowledge reveals. Highlight any non-obvious cross-domain connections.`,
        },
      ],
    }));

    const textBlock = message.content.find((b) => b.type === 'text');
    this.costTracker.record(
      'query-baseline',
      SONNET,
      message.usage.input_tokens,
      message.usage.output_tokens
    );

    return textBlock?.text ?? '';
  }

  async summarizeForBaseline(text: string, runNumber: number): Promise<string> {
    this.costTracker.checkBudget();

    const message = await withRetry(() => this.client.messages.create({
      model: SONNET,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Summarize the key concepts, relationships, and insights from this text. Be thorough — capture all important ideas and how they relate to each other.

Input #${runNumber}:
${text}

Provide a detailed summary that preserves the key concepts and their relationships.`,
        },
      ],
    }));

    const textBlock = message.content.find((b) => b.type === 'text');
    this.costTracker.record(
      'baseline-summarize',
      SONNET,
      message.usage.input_tokens,
      message.usage.output_tokens
    );

    return textBlock?.text ?? '';
  }
}
