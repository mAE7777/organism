import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface IOLogEntry {
  timestamp: number;
  operation: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  response: string;
  inputTokens: number;
  outputTokens: number;
}

export class IOLogger {
  private filePath: string;
  private initialized = false;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'io-log.jsonl');
  }

  log(entry: IOLogEntry): void {
    if (!this.initialized) {
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.initialized = true;
    }
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
  }
}
