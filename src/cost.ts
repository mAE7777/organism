import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { CostEntry, CostSummary } from './types.js';

const COST_PER_1K: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
};

export class CostTracker {
  private entries: CostEntry[] = [];
  private filePath: string;
  private budgetCap: number;

  constructor(dataDir: string, budgetCap = 20.0) {
    this.filePath = join(dataDir, 'cost-log.json');
    this.budgetCap = budgetCap;
    if (existsSync(this.filePath)) {
      this.entries = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    }
  }

  record(operation: string, model: string, inputTokens: number, outputTokens: number): number {
    const rates = COST_PER_1K[model] ?? { input: 0.003, output: 0.015 };
    const cost = (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;

    this.entries.push({ operation, model, inputTokens, outputTokens, cost, timestamp: Date.now() });
    this.save();

    return cost;
  }

  get totalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.cost, 0);
  }

  get isOverBudget(): boolean {
    return this.totalCost >= this.budgetCap;
  }

  checkBudget(): void {
    if (this.isOverBudget) {
      throw new Error(`Budget cap exceeded: $${this.totalCost.toFixed(4)} >= $${this.budgetCap.toFixed(2)}`);
    }
  }

  summarize(): CostSummary {
    const byOperation: Record<string, { count: number; cost: number }> = {};
    const byModel: Record<string, { count: number; cost: number }> = {};
    let totalInput = 0;
    let totalOutput = 0;

    for (const e of this.entries) {
      totalInput += e.inputTokens;
      totalOutput += e.outputTokens;

      if (!byOperation[e.operation]) byOperation[e.operation] = { count: 0, cost: 0 };
      byOperation[e.operation].count++;
      byOperation[e.operation].cost += e.cost;

      if (!byModel[e.model]) byModel[e.model] = { count: 0, cost: 0 };
      byModel[e.model].count++;
      byModel[e.model].cost += e.cost;
    }

    return {
      totalCost: this.totalCost,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      byOperation,
      byModel,
    };
  }

  reset(): void {
    this.entries = [];
    this.save();
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
  }
}
