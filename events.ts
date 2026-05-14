/**
 * Typed application event bus.
 *
 * Components emit events instead of writing to stderr so the TUI can
 * surface them in the status bar or as user-visible notifications.
 */

export type EventMap = {
  "rate-limit-retry": {
    url: string;
    attempt: number;
    maxRetries: number;
    waitMs: number;
  };
};

const listeners: {
  [K in keyof EventMap]?: Set<(payload: EventMap[K]) => void>;
} = {};

export function onEvent<K extends keyof EventMap>(
  type: K,
  listener: (payload: EventMap[K]) => void,
): () => void {
  const set = (listeners[type] ??= new Set()) as Set<(payload: EventMap[K]) => void>;
  set.add(listener);
  return () => set.delete(listener);
}

export function emitEvent<K extends keyof EventMap>(
  type: K,
  payload: EventMap[K],
): void {
  const set = listeners[type];
  if (!set) return;
  for (const listener of set) {
    listener(payload);
  }
}
