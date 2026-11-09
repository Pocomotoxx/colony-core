import { ColonyEvent } from './types.js';

export type EventHandler<T = unknown> = (event: ColonyEvent<T>) => void | Promise<void>;

/**
 * High-performance, topic-based asynchronous event bus for Colony members
 */
export class MessageBus {
  // Handlers for different topics take different payload types, so the stores cannot name one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, Set<EventHandler<any>>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wildcardHandlers = new Set<EventHandler<any>>();
  private eventHistory: ColonyEvent[] = [];
  private maxHistory: number;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  /**
   * Subscribe to a specific topic or pattern
   */
  public subscribe<T = unknown>(topic: string, handler: EventHandler<T>): () => void {
    if (topic === '*') {
      this.wildcardHandlers.add(handler);
      return () => this.wildcardHandlers.delete(handler);
    }

    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);

    return () => {
      const current = this.handlers.get(topic);
      if (current) {
        current.delete(handler);
        if (current.size === 0) {
          this.handlers.delete(topic);
        }
      }
    };
  }

  /**
   * Publish an event across the Colony
   */
  public async publish<T = unknown>(
    topic: string,
    senderId: string,
    payload: T
  ): Promise<ColonyEvent<T>> {
    const event: ColonyEvent<T> = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      topic,
      senderId,
      timestamp: Date.now(),
      payload,
    };

    if (this.eventHistory.length >= this.maxHistory) {
      this.eventHistory.shift();
    }
    this.eventHistory.push(event);

    const promises: Promise<void>[] = [];

    // Specific topic handlers
    const specificHandlers = this.handlers.get(topic);
    if (specificHandlers) {
      for (const handler of specificHandlers) {
        promises.push(
          Promise.resolve().then(() => handler(event)).catch((err) => {
            console.error(`[MessageBus] Error in handler for topic '${topic}':`, err);
          })
        );
      }
    }

    // Wildcard handlers
    for (const handler of this.wildcardHandlers) {
      promises.push(
        Promise.resolve().then(() => handler(event)).catch((err) => {
          console.error(`[MessageBus] Error in wildcard handler for topic '${topic}':`, err);
        })
      );
    }

    await Promise.all(promises);
    return event;
  }

  public getHistory(topicPrefix?: string): ColonyEvent[] {
    if (!topicPrefix) {
      return [...this.eventHistory];
    }
    return this.eventHistory.filter((e) => e.topic.startsWith(topicPrefix));
  }

  public clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
    this.eventHistory = [];
  }
}
