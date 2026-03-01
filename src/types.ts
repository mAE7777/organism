export interface Facet {
  domain: string;
  attribute: string;
  salience: number;
  novelty?: boolean;
  tension?: string | null;
}

export interface Concept {
  id: string;
  name: string;
  facets: Facet[];
  sourceInput: number;
}

export interface ChainStep {
  fromConcept: string;
  fromFacet: string;
  toConcept: string;
  toFacet: string;
}

export type ChainValidationStatus = 'unvalidated' | 'shallow' | 'validated' | 'challenged';

export interface Chain {
  id: string;
  fromConcept: string;
  toConcept: string;
  steps: ChainStep[];
  depth: number;
  domainsCrossed: string[];
  confidence: number;
  weight: number;
  createdAtRun: number;
  lastTraversedRun: number;
  validationStatus?: ChainValidationStatus;
}

export interface LatentConnection {
  fromConcept: string;
  toConcept: string;
  resonanceScore: number;
  facetPairs: FacetPair[];
  weight: number;
  createdAtRun: number;
  validated: boolean;
}

export interface BridgeConcept {
  conceptId: string;
  bridgeScore: number;
  uniqueSourceInputs: number;
  uniqueDomains: number;
  chainsThrough: number;
  discoveredAtRun: number;
}

export interface ChainVersion {
  run: number;
  intermediates: string[];
  confidence: number;
}

export interface ChainHistory {
  endpoints: [string, string];
  versions: ChainVersion[];
  rearrangementCount: number;
}

export interface IdentitySnapshot {
  run: number;
  description: string;
  topBridges: string[];
  dominantDomains: string[];
  recentShifts: string[];
}

export interface RunMetadata {
  chainHistory: ChainHistory[];
  identitySnapshots: IdentitySnapshot[];
  bridgeConcepts: BridgeConcept[];
}

export interface TopologyState {
  concepts: Concept[];
  chains: Chain[];
  latentConnections: LatentConnection[];
  runCount: number;
  questions?: TopologyQuestion[];
}

export interface ComparisonResult {
  appeared: string[];
  disappeared: string[];
  shifted: string[];
  crossInputChains: string[];
  interpretation: string;
}

export interface CostEntry {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: number;
}

export interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byOperation: Record<string, { count: number; cost: number }>;
  byModel: Record<string, { count: number; cost: number }>;
}

export interface FacetPair {
  facetA: { concept: string; facet: Facet };
  facetB: { concept: string; facet: Facet };
}

export interface TopologyQuestion {
  id: string;
  text: string;
  sourceInput: number;
  relatedConcepts: string[];
  status: 'open' | 'addressed' | 'dissolved';
  addressedByInput?: number;
  dissolvedByRearrangement?: string;
  confidence?: number;
  evidenceChains?: string[];
}

export interface PathScore {
  pathId: string;
  surprise: number;
  validity: number;
  insight: number;
  meaning: string;
  isShallow: boolean;
  compositeScore: number;
}

export interface RearrangementScore {
  specificity: number;
  depth: number;
  crossDomain: number;
  genuine: number;
}

export interface Contradiction {
  conceptA: string;
  conceptB: string;
  pathA: { intermediates: string[]; implication: string };
  pathB: { intermediates: string[]; implication: string };
  tension: string;
}

export interface PrunerResult {
  hubsPenalized: string[];
  bridgesProtected: string[];
  redundantPathsMerged: number;
  orphansArchived: string[];
}

export interface NetworkMetrics {
  top3PathShare: number;
  diameter: number;
  clusteringCoeff: number;
  articulationPoints: string[];
  avgPathLength: number;
}

export interface HealthCheckResult {
  hubGravityIndex: number;
  staleRegions: Array<{ concepts: string[]; avgWeight: number }>;
  orphanCount: number;
  bridgeStability: { stable: string[]; newBridges: string[]; lostBridges: string[] };
  warnings: string[];
}

export interface TopologySignal {
  bridges: Array<{
    concept: string;
    score: number;
    isArticulationPoint: boolean;
    structuralClaim?: string;
    domains?: string[];
    sourceCount?: number;
  }>;
  emergentPaths: Array<{ from: string; to: string; hops: string[]; weight: number }>;
  rearrangements: Array<{ endpoints: [string, string]; fromRun: number; toRun: number }>;
  contradictions: Contradiction[];
  uncertaintyProfile: { density: number; contradictionCount: number; facetCount: number; identityOscillation: number };
  decayReport: PrunerResult;
  openQuestions: TopologyQuestion[];
  delta: SignalDelta;
  runNumber: number;
  timestamp: number;
}

export interface SignalQueryContext {
  inputCount: number;
  domainCount: number;
  bridges: Array<{
    name: string;
    structuralClaim: string;
    domains: string[];
    sourceCount: number;
  }>;
  emergentPaths: Array<{ from: string; to: string; hops: string[]; weight: number }>;
  contradictions: Array<{ description: string }>;
}

export interface SignalDelta {
  newBridges: string[];
  lostBridges: string[];
  newEmergentPaths: number;
  rearrangementsThisRun: number;
  questionsOpened: number;
  questionsClosed: number;
}
