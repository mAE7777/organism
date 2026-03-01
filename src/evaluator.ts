import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { CostTracker } from './cost.js';
import { withRetry } from './operations.js';
import { findPaths } from './traversal.js';
import type { TopologyState, PathScore, RearrangementScore, Contradiction } from './types.js';
import type { TransitivePath } from './traversal.js';
import type { RearrangementEvent } from './analysis.js';

const HAIKU = 'claude-haiku-4-5-20251001';

const PathScoreSchema = {
  type: 'object',
  properties: {
    surprise: { type: 'number' },
    validity: { type: 'number' },
    insight: { type: 'number' },
    meaning: { type: 'string' },
  },
  required: ['surprise', 'validity', 'insight', 'meaning'],
  additionalProperties: false,
} as const;

const RearrangementScoreSchema = {
  type: 'object',
  properties: {
    specificity: { type: 'number' },
    depth: { type: 'number' },
    crossDomain: { type: 'number' },
    genuine: { type: 'number' },
  },
  required: ['specificity', 'depth', 'crossDomain', 'genuine'],
  additionalProperties: false,
} as const;

const ContradictionSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          conceptA: { type: 'string' },
          conceptB: { type: 'string' },
          pathAImplication: { type: 'string' },
          pathBImplication: { type: 'string' },
          tension: { type: 'string' },
          isContradiction: { type: 'boolean' },
        },
        required: ['conceptA', 'conceptB', 'pathAImplication', 'pathBImplication', 'tension', 'isContradiction'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const;

export async function evaluatePathSemantic(
  path: TransitivePath,
  topology: TopologyState,
  client: Anthropic,
  costTracker: CostTracker,
): Promise<PathScore> {
  costTracker.checkBudget();

  const hopsText = path.hops.join(' → ');
  const prompt = `Rate this emergent path on a 1-5 scale for each dimension:

Path: ${path.from} → ${hopsText} → ${path.to}
Weight: ${path.weight.toFixed(3)}
Source inputs spanned: ${path.sourceInputsSpanned.join(', ')}

Rate:
- surprise (1-5): How unexpected is this connection?
- validity (1-5): Does this connection make genuine sense?
- insight (1-5): Does this connection reveal something non-obvious?

Also provide a one-sentence meaning: what does this path reveal?`;

  const message = await withRetry(() => client.messages.parse({
    model: HAIKU,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: jsonSchemaOutputFormat(PathScoreSchema) },
  }));

  costTracker.record('evaluate-path', HAIKU, message.usage.input_tokens, message.usage.output_tokens);

  const parsed = message.parsed_output as { surprise: number; validity: number; insight: number; meaning: string };
  const compositeScore = (parsed.surprise + parsed.validity + parsed.insight) / 3;

  return {
    pathId: `${path.from}→${path.to}`,
    surprise: parsed.surprise,
    validity: parsed.validity,
    insight: parsed.insight,
    meaning: parsed.meaning,
    isShallow: compositeScore < 2.0,
    compositeScore,
  };
}

export async function evaluateRearrangement(
  event: RearrangementEvent,
  client: Anthropic,
  costTracker: CostTracker,
): Promise<RearrangementScore> {
  costTracker.checkBudget();

  const prompt = `Rate this rearrangement event on a 1-5 scale:

Endpoints: ${event.endpoints.join(' ↔ ')}
Old path: ${event.oldIntermediates.join(' → ') || '(direct)'}
New path: ${event.newIntermediates.join(' → ') || '(direct)'}
From run ${event.fromRun} to run ${event.toRun}
Domain shift: ${event.domainShift ? 'yes' : 'no'}

Rate:
- specificity (1-5): How specific/concrete is this change (vs generic)?
- depth (1-5): How deep is the reasoning behind the change?
- crossDomain (1-5): Does the change cross domain boundaries meaningfully?
- genuine (1-5): Does this feel like genuine reorganization of understanding?`;

  const message = await withRetry(() => client.messages.parse({
    model: HAIKU,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: jsonSchemaOutputFormat(RearrangementScoreSchema) },
  }));

  costTracker.record('evaluate-rearrangement', HAIKU, message.usage.input_tokens, message.usage.output_tokens);

  return message.parsed_output as RearrangementScore;
}

export async function findContradictions(
  topology: TopologyState,
  client: Anthropic,
  costTracker: CostTracker,
): Promise<Contradiction[]> {
  // Find concept pairs with 2+ paths between them
  const multiPathPairs: Array<{ a: string; b: string; paths: TransitivePath[] }> = [];
  const conceptNames = topology.concepts.map(c => c.name);

  const checked = new Set<string>();
  for (let i = 0; i < conceptNames.length && multiPathPairs.length < 20; i++) {
    for (let j = i + 1; j < conceptNames.length && multiPathPairs.length < 20; j++) {
      const key = [conceptNames[i], conceptNames[j]].sort().join('|');
      if (checked.has(key)) continue;
      checked.add(key);

      const paths = findPaths(conceptNames[i], conceptNames[j], topology, 4);
      if (paths.length >= 2) {
        multiPathPairs.push({ a: conceptNames[i], b: conceptNames[j], paths });
      }
    }
  }

  if (multiPathPairs.length === 0) return [];

  costTracker.checkBudget();

  const pairsText = multiPathPairs.slice(0, 10).map((p, idx) => {
    const pathA = p.paths[0];
    const pathB = p.paths[1];
    return `Pair ${idx}: ${p.a} ↔ ${p.b}
  Path A: ${p.a} → ${pathA.hops.join(' → ')} → ${p.b} (weight ${pathA.weight.toFixed(3)})
  Path B: ${p.a} → ${pathB.hops.join(' → ')} → ${p.b} (weight ${pathB.weight.toFixed(3)})`;
  }).join('\n\n');

  const message = await withRetry(() => client.messages.parse({
    model: HAIKU,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `For each pair of paths between the same concepts, determine if they imply contradictory things.

${pairsText}

For each pair:
1. What does Path A imply about the relationship?
2. What does Path B imply?
3. Do these contradict each other?
4. If yes, describe the tension.`,
    }],
    output_config: { format: jsonSchemaOutputFormat(ContradictionSchema) },
  }));

  costTracker.record('evaluate-contradiction', HAIKU, message.usage.input_tokens, message.usage.output_tokens);

  const parsed = message.parsed_output as {
    results: Array<{
      conceptA: string; conceptB: string;
      pathAImplication: string; pathBImplication: string;
      tension: string; isContradiction: boolean;
    }>;
  };

  return parsed.results
    .filter(r => r.isContradiction)
    .map((r, idx) => {
      const pair = multiPathPairs[idx];
      return {
        conceptA: r.conceptA,
        conceptB: r.conceptB,
        pathA: {
          intermediates: pair?.paths[0]?.hops ?? [],
          implication: r.pathAImplication,
        },
        pathB: {
          intermediates: pair?.paths[1]?.hops ?? [],
          implication: r.pathBImplication,
        },
        tension: r.tension,
      };
    });
}
