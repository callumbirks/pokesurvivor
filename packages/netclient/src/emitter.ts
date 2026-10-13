/** A minimal typed event emitter (DOM-free). */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  /** Returns a function that removes the handler. */
  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Resolves with the next payload of `event` that passes `filter`. */
  next<K extends keyof Events>(
    event: K,
    filter: (payload: Events[K]) => boolean = () => true,
  ): Promise<Events[K]> {
    return new Promise((resolve) => {
      const off = this.on(event, (payload) => {
        if (!filter(payload)) return;
        off();
        resolve(payload);
      });
    });
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])])
      (handler as (payload: Events[K]) => void)(payload);
  }
}
