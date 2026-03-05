import { logger } from './logger.js';

export class ProgressTracker {
  private total: number;
  private current = 0;
  private label: string;
  private lastReported = 0;
  private startTime: number;

  constructor(label: string, total: number) {
    this.label = label;
    this.total = total;
    this.startTime = Date.now();
  }

  increment(count = 1): void {
    this.current += count;
    const pct = Math.floor((this.current / this.total) * 100);
    if (pct >= this.lastReported + 10 || this.current === this.total) {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      logger.info(`${this.label}: ${this.current}/${this.total} (${pct}%) [${elapsed}s]`);
      this.lastReported = pct;
    }
  }

  finish(): { elapsed: number; count: number } {
    const elapsed = Date.now() - this.startTime;
    logger.info(`${this.label}: completed ${this.current} items in ${(elapsed / 1000).toFixed(1)}s`);
    return { elapsed, count: this.current };
  }
}
