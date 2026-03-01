import type {
  TopologyState,
  TopologySignal,
  SignalDelta,
  BridgeConcept,
  PrunerResult,
  TopologyQuestion,
} from './types.js';
import type { RearrangementEvent } from './analysis.js';
import type { TransitivePath } from './traversal.js';

export function emitSignal(
  topology: TopologyState,
  previousSignal: TopologySignal | null,
  bridges: BridgeConcept[],
  articulationPoints: string[],
  prunerResult: PrunerResult,
  rearrangements: RearrangementEvent[],
  emergentPaths: TransitivePath[],
  runNumber: number,
): TopologySignal {
  const articulationSet = new Set(articulationPoints.map(a => a.toLowerCase()));

  const conceptMap = new Map(topology.concepts.map(c => [c.id, c]));

  const signalBridges = bridges.slice(0, 10).map(b => {
    const concept = conceptMap.get(b.conceptId);
    const name = concept?.name ?? b.conceptId;

    // Build structural claim from top facets
    const topFacets = (concept?.facets ?? [])
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 3);
    const structuralClaim = topFacets.length > 0
      ? topFacets.map(f => `${f.domain}:${f.attribute}`).join(', ')
      : '';

    // Domains from chains through this concept
    const nameLower = name.toLowerCase();
    const chainsThrough = topology.chains.filter(c =>
      c.fromConcept.toLowerCase() === nameLower ||
      c.toConcept.toLowerCase() === nameLower
    );
    const domains = [...new Set(chainsThrough.flatMap(c => c.domainsCrossed))];

    return {
      concept: name,
      score: b.bridgeScore,
      isArticulationPoint: articulationSet.has(nameLower),
      structuralClaim,
      domains,
      sourceCount: b.uniqueSourceInputs,
    };
  });

  const signalPaths = emergentPaths.slice(0, 20).map(p => ({
    from: p.from,
    to: p.to,
    hops: p.hops,
    weight: p.weight,
  }));

  const signalRearrangements = rearrangements.slice(0, 10).map(r => ({
    endpoints: r.endpoints,
    fromRun: r.fromRun,
    toRun: r.toRun,
  }));

  const facetCount = topology.concepts.reduce((s, c) => s + c.facets.length, 0);
  const density = topology.concepts.length > 0
    ? topology.chains.length / topology.concepts.length
    : 0;

  const openQuestions = (topology.questions ?? []).filter(q => q.status === 'open');

  // Compute delta
  const prevBridgeNames = new Set((previousSignal?.bridges ?? []).map(b => b.concept));
  const currBridgeNames = new Set(signalBridges.map(b => b.concept));
  const newBridges = signalBridges.filter(b => !prevBridgeNames.has(b.concept)).map(b => b.concept);
  const lostBridges = (previousSignal?.bridges ?? []).filter(b => !currBridgeNames.has(b.concept)).map(b => b.concept);

  const prevQuestionCount = previousSignal?.openQuestions.length ?? 0;

  const delta: SignalDelta = {
    newBridges,
    lostBridges,
    newEmergentPaths: signalPaths.length - (previousSignal?.emergentPaths.length ?? 0),
    rearrangementsThisRun: signalRearrangements.filter(r => r.toRun === runNumber).length,
    questionsOpened: openQuestions.length - prevQuestionCount,
    questionsClosed: (previousSignal?.openQuestions.length ?? 0) - openQuestions.length,
  };

  return {
    bridges: signalBridges,
    emergentPaths: signalPaths,
    rearrangements: signalRearrangements,
    contradictions: [],
    uncertaintyProfile: {
      density,
      contradictionCount: 0,
      facetCount,
      identityOscillation: 0,
    },
    decayReport: prunerResult,
    openQuestions,
    delta,
    runNumber,
    timestamp: Date.now(),
  };
}
