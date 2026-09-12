import { Agent } from 'undici';
import { debug, describeError } from './debug.js';

const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://localhost:3141';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const authHeader = (): Record<string, string> =>
  BRIDGE_TOKEN ? { Authorization: `Bearer ${BRIDGE_TOKEN}` } : {};

// Node's global `fetch` (undici) defaults to a 300s bodyTimeout. Claude CLI turns routinely
// run past that (10-15min is common on complex ones) with no bytes on the wire in between,
// so the plain global fetch trips UND_ERR_BODY_TIMEOUT well before the bridge is actually
// done — which then gets misread downstream as "the bridge restarted." The bridge process
// is fine; only the client socket gave up. Same fix already used in youtube-uploader.ts for
// large uploads: a dedicated dispatcher with a much longer headers/body timeout.
const BRIDGE_DISPATCHER = new Agent({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 });

export interface BridgeAskPayload {
  trigger: {
    type: 'inline';
    query: string | null;
    sender: string;
    replyTo: string | null;
    originalMessage: string;
  };
  recentMessages: Array<{
    sender: string;
    message: string;
    timestamp: string | null;
    replyTo: string | null;
    type: 'text';
  }>;
  repliedToMessage: null;
}

export interface StreamCallbacks {
  onMessage: (text: string) => void;
  onToolUse?: (name: string, detail: string) => void;
  onMeta?: (meta: { projectDirectory?: string }) => void;
  /** Fires once when the bridge has finished assembling the user prompt (post staleness/subagent-hint append). */
  onFinalPrompt?: (text: string) => void;
}

export interface StreamResult {
  response: string | null;
  contextUsedPct: number | null;
  projectDirectory: string | null;
  /** True when this call only parked a "For later:" task (no query, no tool calls) rather
   *  than running a real turn — the actual deferred turn happens later, in a separate
   *  sendBridgeRequest call. Callers must not treat an empty tool-use history from a parked
   *  call as "nothing was referenced" for cleanup purposes. */
  parked: boolean;
}

/** Stream bridge response — calls onMessage for each intermediate Claude message */
export async function askBridgeStream(
  payload: BridgeAskPayload,
  callbacks: StreamCallbacks,
): Promise<StreamResult> {
  // Logged before the fetch: if this line is absent from the bot log while an error is
  // present, the failure happened upstream of the bridge entirely (see sendTyping).
  const started = Date.now();
  debug('bridge', `POST ${BRIDGE_URL}/ask/stream <- "${payload.trigger.originalMessage.slice(0, 60).replace(/\n/g, ' ')}"`);
  const res = await fetch(`${BRIDGE_URL}/ask/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(payload),
    dispatcher: BRIDGE_DISPATCHER,
  } as RequestInit & { dispatcher: Agent }).catch((err: unknown) => {
    debug('bridge', `fetch threw after ${Date.now() - started}ms: ${describeError(err)}`);
    throw err;
  });
  debug('bridge', `<- HTTP ${res.status} in ${Date.now() - started}ms`);

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const budget = data.budget;
    if (budget) {
      throw new Error(`Hourly limit reached (${budget.usedThisHour}/${budget.hourlyLimit}). Try again in ~${60 - new Date().getMinutes()} min.`);
    }
    throw new Error('Rate limited. Try again in a minute.');
  }
  if (!res.ok) throw new Error(`Bridge error: ${res.status}`);
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: string | null = null;
  let contextUsedPct: number | null = null;
  let projectDirectory: string | null = null;
  let parked = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from buffer
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        continue; // skip unparseable lines
      }
      if (data.type === 'message') {
        callbacks.onMessage(data.text as string);
      } else if (data.type === 'tool') {
        callbacks.onToolUse?.(data.name as string, (data.detail as string) ?? '');
      } else if (data.type === 'meta') {
        if (data.projectDirectory) projectDirectory = data.projectDirectory as string;
        callbacks.onMeta?.({ projectDirectory: data.projectDirectory as string | undefined });
      } else if (data.type === 'final_prompt') {
        callbacks.onFinalPrompt?.(data.text as string);
      } else if (data.type === 'done') {
        if (data.singleShot) callbacks.onMessage(data.response as string);
        finalResponse = data.response as string;
        if (data.contextUsedPct != null) contextUsedPct = data.contextUsedPct as number;
        if (data.projectDirectory) projectDirectory = data.projectDirectory as string;
        if (data.parked === true) parked = true;
      } else if (data.type === 'error') {
        throw new Error(data.error as string);
      } else if (data.type === 'aborted') {
        throw new Error('Request aborted by client');
      }
    }
  }

  return { response: finalResponse, contextUsedPct, projectDirectory, parked };
}

/**
 * Force-stop the in-flight turn for a slug. Short timeout on purpose — the whole point
 * is a fast escape hatch, and the bridge answers synchronously (it just signals the pid).
 * Throws on transport/HTTP failure so the caller can say "couldn't reach the bridge"
 * rather than silently implying the session was stopped.
 */
export async function stopBridgeSession(slug: string): Promise<{ stopped: boolean; reason: string }> {
  const res = await fetch(`${BRIDGE_URL}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ slug }),
    signal: AbortSignal.timeout(5000),
  }).catch((err: unknown) => {
    debug('bridge', `POST /stop threw: ${describeError(err)}`);
    throw err;
  });
  if (!res.ok) throw new Error(`Bridge error: ${res.status}`);
  return res.json() as Promise<{ stopped: boolean; reason: string }>;
}

/**
 * Emergency full reset for a slug: kills whatever's running AND discards the session in
 * one call — the panic-button counterpart to `stopBridgeSession`, for when a session is
 * stuck (compaction spiral, wedged tool call) rather than just slow. Same short-timeout
 * reasoning as stop: it's an escape hatch, it needs to answer fast.
 */
export async function emergencyResetSession(slug: string): Promise<{ stopped: boolean; stopReason: string; projectReset: boolean }> {
  const res = await fetch(`${BRIDGE_URL}/emergency-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ slug }),
    signal: AbortSignal.timeout(5000),
  }).catch((err: unknown) => {
    debug('bridge', `POST /emergency-reset threw: ${describeError(err)}`);
    throw err;
  });
  if (!res.ok) throw new Error(`Bridge error: ${res.status}`);
  return res.json() as Promise<{ stopped: boolean; stopReason: string; projectReset: boolean }>;
}

export interface ProjectInfo {
  slugs: string[];
  commands: string[];
}

export async function fetchProjects(): Promise<ProjectInfo> {
  const res = await fetch(`${BRIDGE_URL}/projects`, { headers: { ...authHeader() } });
  if (!res.ok) return { slugs: [], commands: [] };
  return res.json();
}

export interface BudgetStatus {
  hourlyLimit: number;
  usedThisHour: number;
  remainingThisHour: number;
  currentHour: string;
  unlimited: boolean;
  upstream: {
    windowCount: number;
    windowStart: string;
    windowMinutesLeft: number;
    estimatedUpstreamLimit: number;
    usagePercent: number;
  };
}

export async function fetchBudget(): Promise<BudgetStatus | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/budget`, {
      headers: { ...authHeader() },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<BudgetStatus>;
  } catch {
    return null;
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, {
      headers: { ...authHeader() },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

