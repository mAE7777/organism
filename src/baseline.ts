import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Operations } from './operations.js';

export class Baseline {
  private memoryPath: string;
  private ops: Operations;

  constructor(dataDir: string, ops: Operations) {
    this.memoryPath = join(dataDir, 'memory.md');
    this.ops = ops;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  }

  async processInput(text: string, runNumber: number): Promise<{ summaryLength: number }> {
    const summary = await this.ops.summarizeForBaseline(text, runNumber);

    const header = `\n\n## Input ${runNumber}\n\n`;
    const existing = existsSync(this.memoryPath) ? readFileSync(this.memoryPath, 'utf-8') : '# Knowledge Base\n';
    writeFileSync(this.memoryPath, existing + header + summary);

    return { summaryLength: summary.length };
  }

  async query(question: string): Promise<string> {
    const memory = existsSync(this.memoryPath) ? readFileSync(this.memoryPath, 'utf-8') : '';
    return this.ops.queryWithFlatMemory(question, memory);
  }

  getMemory(): string {
    return existsSync(this.memoryPath) ? readFileSync(this.memoryPath, 'utf-8') : '';
  }

  reset(): void {
    if (existsSync(this.memoryPath)) {
      writeFileSync(this.memoryPath, '# Knowledge Base\n');
    }
  }
}

export class EnrichedBaseline {
  private memoryPath: string;
  private synthesisPath: string;
  private ops: Operations;

  constructor(dataDir: string, ops: Operations) {
    this.memoryPath = join(dataDir, 'memory.md');
    this.synthesisPath = join(dataDir, 'synthesis.md');
    this.ops = ops;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  }

  async processInput(text: string, runNumber: number): Promise<{ summaryLength: number }> {
    // Pass 1: Summarize (same as basic baseline)
    const summary = await this.ops.summarizeForBaseline(text, runNumber);

    const header = `\n\n## Input ${runNumber}\n\n`;
    const existing = existsSync(this.memoryPath) ? readFileSync(this.memoryPath, 'utf-8') : '# Knowledge Base\n';
    writeFileSync(this.memoryPath, existing + header + summary);

    // Pass 2: Cross-reference — find connections between new input and all previous
    const allMemory = readFileSync(this.memoryPath, 'utf-8');
    const crossRef = await this.ops.queryWithFlatMemory(
      `What connections, patterns, or tensions exist between this new input and everything previously recorded? Be specific about which inputs connect and why.\n\nNew input (#${runNumber}):\n${summary}`,
      allMemory,
    );

    // Pass 3: Update synthesis document
    const existingSynthesis = existsSync(this.synthesisPath)
      ? readFileSync(this.synthesisPath, 'utf-8')
      : '# Synthesis\n\nNo inputs processed yet.\n';

    const updatedSynthesis = await this.ops.queryWithFlatMemory(
      `Update this synthesis document to incorporate the new cross-references found. Keep it structured, concise, and focused on cross-domain patterns.\n\nNew cross-references:\n${crossRef}`,
      existingSynthesis,
    );

    writeFileSync(this.synthesisPath, updatedSynthesis);

    return { summaryLength: summary.length };
  }

  async query(question: string): Promise<string> {
    const memory = existsSync(this.memoryPath) ? readFileSync(this.memoryPath, 'utf-8') : '';
    const synthesis = existsSync(this.synthesisPath) ? readFileSync(this.synthesisPath, 'utf-8') : '';
    const combined = `${memory}\n\n---\n\nCross-domain synthesis:\n${synthesis}`;
    return this.ops.queryWithFlatMemory(question, combined);
  }

  getMemory(): string {
    return existsSync(this.memoryPath) ? readFileSync(this.memoryPath, 'utf-8') : '';
  }

  reset(): void {
    if (existsSync(this.memoryPath)) writeFileSync(this.memoryPath, '# Knowledge Base\n');
    if (existsSync(this.synthesisPath)) writeFileSync(this.synthesisPath, '# Synthesis\n\nNo inputs processed yet.\n');
  }
}
