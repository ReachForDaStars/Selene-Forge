/** Minimal typed event emitter — no dependencies, no wildcards, no magic. */
export class Emitter<Events extends string> {
  private listeners = new Map<Events, Set<(...args: any[]) => void>>();

  on(event: Events, listener: (...args: any[]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off(event: Events, listener: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: Events, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[selene] listener for "${event}" failed`, error);
      }
    }
  }
}

/** Debounce that keeps the latest arguments and exposes `flush`/`cancel`. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const run = () => {
    timer = null;
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };

  const debounced = (...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, wait);
  };
  debounced.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return debounced;
}
