import Anthropic from '@anthropic-ai/sdk';
import type { IdentitySnapshot, BridgeConcept, TopologyState } from './types.js';
import type { RearrangementEvent } from './analysis.js';
import { CostTracker } from './cost.js';
import { withRetry } from './operations.js';

const HAIKU = 'claude-haiku-4-5-20251001';

export class IdentityEngine {
  private client: Anthropic;
  private costTracker: CostTracker;

  constructor(client: Anthropic, costTracker: CostTracker) {
    this.client = client;
    this.costTracker = costTracker;
  }

  async generateSnapshot(
    topology: TopologyState,
    bridges: BridgeConcept[],
    previousIdentity: IdentitySnapshot | undefined,
    rearrangements: RearrangementEvent[],
    decayVictims: { chains: number; latent: number },
    run: number,
  ): Promise<IdentitySnapshot> {
    this.costTracker.checkBudget();

    const topBridgeNames = bridges.slice(0, 5).map((b) => {
      const concept = topology.concepts.find((c) => c.id === b.conceptId);
      return concept?.name ?? b.conceptId;
    });

    const domainCounts: Record<string, number> = {};
    for (const concept of topology.concepts) {
      for (const f of concept.facets) {
        domainCounts[f.domain] = (domainCounts[f.domain] ?? 0) + 1;
      }
    }
    const dominantDomains = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([d]) => d);

    const shifts: string[] = [];
    if (rearrangements.length > 0) {
      shifts.push(`${rearrangements.length} connection path(s) rearranged`);
    }
    if (decayVictims.chains > 0) {
      shifts.push(`${decayVictims.chains} direct chain(s) pruned by decay`);
    }
    if (decayVictims.latent > 0) {
      shifts.push(`${decayVictims.latent} latent connection(s) pruned by decay`);
    }

    const prompt = `You are a knowledge topology that has processed ${run} inputs. Generate a one-paragraph self-description of your current understanding.

Structural signals:
- ${topology.concepts.length} concepts, ${topology.chains.length} direct chains, ${topology.latentConnections.length} latent connections
- Top bridge concepts (most connected across domains): ${topBridgeNames.join(', ') || 'none yet'}
- Dominant domains: ${dominantDomains.join(', ')}
- Recent shifts: ${shifts.join('; ') || 'none'}
${previousIdentity ? `\nPrevious self-description (run ${previousIdentity.run}):\n"${previousIdentity.description}"` : ''}

Write a one-paragraph description (3-5 sentences) of what this topology currently understands — what patterns it sees, what domains it connects, what it's learning. Be specific to the structural signals, not generic. If there was a previous identity, note what has changed.`;

    const message = await withRetry(() => this.client.messages.create({
      model: HAIKU,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }));

    const text = message.content.find((b) => b.type === 'text');
    this.costTracker.record(
      'identity',
      HAIKU,
      message.usage.input_tokens,
      message.usage.output_tokens,
    );

    return {
      run,
      description: text?.text ?? '',
      topBridges: topBridgeNames,
      dominantDomains,
      recentShifts: shifts,
    };
  }

  formatForDecompose(snapshot: IdentitySnapshot): string {
    return `Your current understanding (after ${snapshot.run} inputs): ${snapshot.description} Top bridge concepts: ${snapshot.topBridges.join(', ')}. Dominant domains: ${snapshot.dominantDomains.join(', ')}.`;
  }
}
