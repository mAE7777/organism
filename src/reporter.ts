import type { TopologySignal } from './types.js';
import { Operations, withRetry } from './operations.js';
import Anthropic from '@anthropic-ai/sdk';
import { CostTracker } from './cost.js';

const HAIKU = 'claude-haiku-4-5-20251001';

export async function humanReport(
  signal: TopologySignal,
  client: Anthropic,
  costTracker: CostTracker,
): Promise<string> {
  costTracker.checkBudget();

  const bridgeSection = signal.bridges.length > 0
    ? signal.bridges.map(b =>
        `  ${b.concept} (score ${b.score.toFixed(2)}${b.isArticulationPoint ? ', BRIDGE NODE' : ''})`
      ).join('\n')
    : '  None detected';

  const pathSection = signal.emergentPaths.length > 0
    ? signal.emergentPaths.slice(0, 5).map(p =>
        `  ${p.from} → ${p.hops.join(' → ')} → ${p.to} (weight ${p.weight.toFixed(3)})`
      ).join('\n')
    : '  None found';

  const rearrangeSection = signal.rearrangements.length > 0
    ? signal.rearrangements.map(r =>
        `  ${r.endpoints.join(' ↔ ')}: run ${r.fromRun} → ${r.toRun}`
      ).join('\n')
    : '  None';

  const questionSection = signal.openQuestions.length > 0
    ? signal.openQuestions.map(q => `  - ${q.text}`).join('\n')
    : '  No open questions';

  const prompt = `Translate this topology signal into a readable human report. Be specific and insightful, not generic.

Bridges:
${bridgeSection}

Emergent Paths (${signal.emergentPaths.length} total):
${pathSection}

Rearrangements:
${rearrangeSection}

Decay: ${signal.decayReport.hubsPenalized.length} hubs penalized, ${signal.decayReport.bridgesProtected.length} bridges protected, ${signal.decayReport.orphansArchived.length} orphans archived

Open Questions:
${questionSection}

Delta since last signal:
- New bridges: ${signal.delta.newBridges.join(', ') || 'none'}
- Lost bridges: ${signal.delta.lostBridges.join(', ') || 'none'}
- Rearrangements this run: ${signal.delta.rearrangementsThisRun}
- Questions opened: ${signal.delta.questionsOpened}

Write 3-5 paragraphs covering:
1. Key bridges and why they matter
2. Most interesting emergent paths
3. Structural dynamics (rearrangements, decay)
4. Open questions and knowledge gaps
5. What changed since last signal`;

  const message = await withRetry(() => client.messages.create({
    model: HAIKU,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  }));

  costTracker.record(
    'report',
    HAIKU,
    message.usage.input_tokens,
    message.usage.output_tokens,
  );

  const text = message.content.find(b => b.type === 'text');
  return text?.text ?? '';
}
