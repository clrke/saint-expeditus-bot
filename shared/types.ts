export interface ParsedMessage {
  sender: string;
  message: string;
  timestamp: string | null;
  replyTo: string | null;
  type: 'text' | 'sticker' | 'photo';
  receivedAt?: number;
}

export interface Trigger {
  type: 'inline' | 'reply';
  query: string | null;
  sender: string;
  replyTo: string | null;
  originalMessage: string;
}

export interface AskPayload {
  trigger: Trigger;
  recentMessages: ParsedMessage[];
  repliedToMessage: ParsedMessage | null;
  chatId?: string;
}

/** Body for POST /notify — pushes a proactive message into a project's Discord thread. */
export interface NotifyPayload {
  slug: string;
  message: string;
}

export interface AskResponse {
  response: string;
  timestamp: string;
  toolsUsed?: string[];
}

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  uptime: number;
  stats: {
    requestsServed: number;
    avgResponseMs: number;
    lastError: string | null;
  };
}

export interface ProjectConfig {
  title: string;
  slug: string;
  description: string;
  directory: string;
  sessionId: string | null;
  status: string;
  decision: {
    summary: string;
    rating: number;
    deadline: string;
    pausedRemaining: number | null;
  } | null;
  autoDecide: boolean;
  createdAt: string;
  lastConversationAt?: string;
  /** Last known context window usage (0-100%), from CLI init event */
  contextUsedPct?: number | null;
}

export interface ProjectResponse {
  tldr: string;
  /** Optional secondary findings/details separate from the core tldr (wire field: other_findings). */
  otherFindings?: string;
  /** Optional list of assumptions made while answering, surfaced separately from tldr/decision (wire field: assumptions_made). */
  assumptionsMade?: string;
  decision: { summary: string; rating: number } | null;
}
