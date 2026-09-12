interface QueueItem<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class RequestQueue<T = void> {
  private queue: QueueItem<T>[] = [];
  private processing = false;

  constructor(private cooldownMs = 5000) {}

  enqueue(execute: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ execute, resolve, reject });
      if (!this.processing) this.processNext();
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const item = this.queue.shift()!;

    try {
      const result = await item.execute();
      item.resolve(result);
    } catch (e) {
      item.reject(e as Error);
    }

    if (this.queue.length > 0) {
      setTimeout(() => this.processNext(), this.cooldownMs);
    } else {
      this.processing = false;
    }
  }
}
