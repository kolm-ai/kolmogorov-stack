// W819-1 sink — buffers passive-monitor captures so downstream consumers
// (pattern-detect, status-bar, routing) can drain them.
//
// Pure TS, zero runtime deps. Intentionally framework-agnostic so a Node
// test runner can import the compiled JS without VS Code globals.

export interface Capture {
  readonly id: string;
  readonly uri: string;
  readonly language: string;
  readonly text: string;
  readonly insertedAt: number;
  readonly source: 'copilot' | 'cursor' | 'claude-code' | 'unknown';
}

export interface CaptureQueueOptions {
  readonly maxSize?: number;
}

/**
 * In-memory bounded FIFO queue used by the passive monitor.
 *
 * Honest contract: when the queue exceeds `maxSize`, oldest captures are
 * silently dropped — this matches the W815 active-learning expectation that
 * the editor session is the producer and the kolm runtime is the durable
 * sink.
 */
export class CaptureQueue {
  private readonly buffer: Capture[] = [];
  private readonly maxSize: number;
  private readonly listeners: Array<(c: Capture) => void> = [];

  constructor(opts: CaptureQueueOptions = {}) {
    this.maxSize = Math.max(1, opts.maxSize ?? 512);
  }

  enqueue(capture: Capture): void {
    this.buffer.push(capture);
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
    for (const fn of this.listeners) {
      try {
        fn(capture);
      } catch {
        // listener errors must never poison the producer
      }
    }
  }

  size(): number {
    return this.buffer.length;
  }

  drain(): Capture[] {
    const out = this.buffer.slice();
    this.buffer.length = 0;
    return out;
  }

  peek(): readonly Capture[] {
    return this.buffer.slice();
  }

  onCapture(fn: (c: Capture) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}
