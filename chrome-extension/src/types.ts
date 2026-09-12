export type { ParsedMessage, Trigger, AskPayload, AskResponse } from '../../shared/types.js';

export interface ExtensionState {
  active: boolean;
  bridgeConnected: boolean;
  messagesLoaded: number;
  lastTriggerAt: number | null;
  chatName: string | null;
}
