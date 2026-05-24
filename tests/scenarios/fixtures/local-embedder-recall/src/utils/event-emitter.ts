/**
 * Typed event emitter for internal application events.
 * Strongly typed event map prevents misspelled event names at compile time.
 */

export type Listener<T> = (event: T) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

/**
 * Typed event emitter.
 * @example
 * const bus = new EventEmitter<{ "user.created": User; "user.deleted": { id: string } }>();
 */
export class EventEmitter<TEventMap extends Record<string, unknown>> {
  private _listeners = new Map<keyof TEventMap, Set<Listener<unknown>>>();
  private _onceLocked = new Set<string>(); // IDs of once-listeners already fired

  /** Subscribe to an event. Returns a subscription handle. */
  on<K extends keyof TEventMap>(event: K, listener: Listener<TEventMap[K]>): Subscription {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(listener as Listener<unknown>);
    return {
      unsubscribe: () => {
        this._listeners.get(event)?.delete(listener as Listener<unknown>);
      },
    };
  }

  /** Subscribe to an event exactly once; auto-unsubscribes after first fire. */
  once<K extends keyof TEventMap>(event: K, listener: Listener<TEventMap[K]>): Subscription {
    const wrapper: Listener<TEventMap[K]> = async (e) => {
      sub.unsubscribe();
      await listener(e);
    };
    const sub = this.on(event, wrapper);
    return sub;
  }

  /** Emit an event, calling all registered listeners in registration order. */
  async emit<K extends keyof TEventMap>(event: K, data: TEventMap[K]): Promise<void> {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      await listener(data);
    }
  }

  /** Remove all listeners for a specific event, or all events if none specified. */
  off<K extends keyof TEventMap>(event?: K): void {
    if (event !== undefined) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }

  /** Return the number of listeners registered for a given event. */
  listenerCount<K extends keyof TEventMap>(event: K): number {
    return this._listeners.get(event)?.size ?? 0;
  }
}
