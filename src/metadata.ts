import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { RunMetadata, ChainHistory, ChainVersion, IdentitySnapshot, BridgeConcept, TopologySignal } from './types.js';

export class MetadataStore {
  private data: RunMetadata;
  private filePath: string;
  private signals: TopologySignal[] = [];
  private questionStatuses: Array<{ questionId: string; status: string; detail?: string }> = [];

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'history.json');
    if (existsSync(this.filePath)) {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      this.data = {
        chainHistory: raw.chainHistory ?? [],
        identitySnapshots: raw.identitySnapshots ?? [],
        bridgeConcepts: raw.bridgeConcepts ?? [],
      };
      this.signals = raw.signals ?? [];
      this.questionStatuses = raw.questionStatuses ?? [];
    } else {
      this.data = { chainHistory: [], identitySnapshots: [], bridgeConcepts: [] };
    }
  }

  recordChainVersion(endpoints: [string, string], run: number, intermediates: string[], confidence: number): void {
    const key = [...endpoints].sort() as [string, string];
    let history = this.data.chainHistory.find(
      (h) => {
        const sorted = [...h.endpoints].sort();
        return sorted[0] === key[0] && sorted[1] === key[1];
      }
    );

    if (!history) {
      history = { endpoints: key, versions: [], rearrangementCount: 0 };
      this.data.chainHistory.push(history);
    }

    const prevVersion = history.versions[history.versions.length - 1];
    const version: ChainVersion = { run, intermediates, confidence };
    history.versions.push(version);

    // check for rearrangement: same endpoints, different intermediates
    if (prevVersion) {
      const prevKey = prevVersion.intermediates.join('|');
      const newKey = intermediates.join('|');
      if (prevKey !== newKey) {
        history.rearrangementCount++;
      }
    }

    this.save();
  }

  getChainHistory(endpoints: [string, string]): ChainHistory | undefined {
    const key = [...endpoints].sort();
    return this.data.chainHistory.find((h) => {
      const sorted = [...h.endpoints].sort();
      return sorted[0] === key[0] && sorted[1] === key[1];
    });
  }

  getRearrangementEvents(): ChainHistory[] {
    return this.data.chainHistory.filter((h) => h.rearrangementCount > 0);
  }

  addIdentitySnapshot(snapshot: IdentitySnapshot): void {
    this.data.identitySnapshots.push(snapshot);
    this.save();
  }

  getIdentityAt(run: number): IdentitySnapshot | undefined {
    return this.data.identitySnapshots.find((s) => s.run === run);
  }

  getLatestIdentity(): IdentitySnapshot | undefined {
    if (this.data.identitySnapshots.length === 0) return undefined;
    return this.data.identitySnapshots[this.data.identitySnapshots.length - 1];
  }

  getAllIdentitySnapshots(): IdentitySnapshot[] {
    return this.data.identitySnapshots;
  }

  updateBridgeConcepts(bridges: BridgeConcept[]): void {
    this.data.bridgeConcepts = bridges;
    this.save();
  }

  getBridgeConcepts(): BridgeConcept[] {
    return this.data.bridgeConcepts;
  }

  get chainHistories(): ChainHistory[] {
    return this.data.chainHistory;
  }

  addSignal(signal: TopologySignal): void {
    this.signals.push(signal);
    this.save();
  }

  getSignalAt(run: number): TopologySignal | undefined {
    return this.signals.find(s => s.runNumber === run);
  }

  getAllSignals(): TopologySignal[] {
    return this.signals;
  }

  recordQuestionStatus(questionId: string, status: string, detail?: string): void {
    this.questionStatuses.push({ questionId, status, detail });
    this.save();
  }

  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const toSave = {
      ...this.data,
      signals: this.signals,
      questionStatuses: this.questionStatuses,
    };
    writeFileSync(this.filePath, JSON.stringify(toSave, null, 2));
  }

  reset(): void {
    this.data = { chainHistory: [], identitySnapshots: [], bridgeConcepts: [] };
    this.signals = [];
    this.questionStatuses = [];
    this.save();
  }
}
