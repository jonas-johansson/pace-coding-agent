import { randomUUID } from "crypto";

let currentSessionId = randomUUID();

export function getSessionId(): string {
  return currentSessionId;
}

export function resetSession(): string {
  currentSessionId = randomUUID();
  return currentSessionId;
}
