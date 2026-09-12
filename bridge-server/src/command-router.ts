import type { AskPayload, ProjectConfig, ProjectResponse } from '../../shared/types.js';
import type { SessionManager } from './session-manager.js';
import type { ProjectStore } from './project-store.js';
import type { Config } from './config.js';
import { buildSystemPrompt, buildUserMessage } from './prompt-builder.js';
import { calculateDeadline, ratingToHours, extendDeadline, pauseForVacation, deadlineFromActiveHours } from './deadline.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const MEMORY_FILES = ['residents.md', 'issues.md', 'decisions.md'];

/** Coerce a parsed JSON object into a ProjectResponse with a guaranteed-string `tldr`.
 *  The model occasionally emits `tldr` as a non-string (object/number/array) — e.g.
 *  `"tldr": {…}` — which would blow up any downstream `.replace`/string op. Normalize
 *  it here so every consumer can treat `tldr` as a string.
 *
 *  Wire format is flat — top-level `decision` (string) + `rating` (number), plus optional
 *  `other_findings` and `assumptions_made` — but every downstream consumer (extractDecision,
 *  ProjectConfig storage, ratingToHours, runProsCons, etc.) expects the pre-existing nested
 *  `{summary, rating}` shape. Reconstruct that here so the wire-format change stays isolated
 *  to this one boundary function. */
function asProjectResponse(parsed: Record<string, unknown>): ProjectResponse {
  const m = parsed.tldr;
  const tldr = typeof m !== 'string'
    ? (m == null ? '' : typeof m === 'object' ? JSON.stringify(m) : String(m))
    : m;

  const rawDecision = parsed.decision;
  const rawRating = parsed.rating;
  let decision: { summary: string; rating: number } | null = null;
  if (typeof rawDecision === 'string' && typeof rawRating === 'number') {
    decision = { summary: rawDecision, rating: rawRating };
  } else if (
    rawDecision && typeof rawDecision === 'object' &&
    typeof (rawDecision as Record<string, unknown>).summary === 'string' &&
    typeof (rawDecision as Record<string, unknown>).rating === 'number'
  ) {
    // Backward-compat: tolerate the legacy nested {summary,rating} shape in case a
    // session's context still recalls the old format before it picks up the new one.
    decision = {
      summary: (rawDecision as Record<string, unknown>).summary as string,
      rating: (rawDecision as Record<string, unknown>).rating as number,
    };
  }

  const rawOther = parsed.other_findings;
  const otherFindings = typeof rawOther === 'string' && rawOther.trim() !== '' ? rawOther : undefined;

  const rawAssumptions = parsed.assumptions_made;
  const assumptionsMade = typeof rawAssumptions === 'string' && rawAssumptions.trim() !== '' ? rawAssumptions : undefined;

  return { tldr, otherFindings, assumptionsMade, decision };
}

/** Parse a Claude response that may contain JSON with tldr and decision fields */
export function parseJsonResponse(text: string): ProjectResponse | null {
  const trimmed = text.trim();

  // 1. Try markdown code fence first: ```json { ... } ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed.tldr !== undefined) return asProjectResponse(parsed);
    } catch { /* fall through */ }
  }

  // 2. Try raw JSON: { ... }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.tldr !== undefined) return asProjectResponse(parsed);
    } catch { /* fall through */ }
  }

  // 3. Try to find {"tldr" later in the text and parse from there
  const jsonStart = trimmed.indexOf('{"tldr"');
  if (jsonStart > 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart));
      if (parsed.tldr !== undefined) return asProjectResponse(parsed);
    } catch { /* fall through */ }
  }

  // 4. Lenient fallback: truncated JSON ({"tldr": "...) where the streamed
  // response was cut off mid-string (max output tokens, network drop, etc).
  // Pull the tldr field as far as it goes; decision is unrecoverable so null.
  const lenientStart = trimmed.indexOf('{"tldr"');
  if (lenientStart >= 0) {
    const slice = trimmed.slice(lenientStart);
    const m = slice.match(/^\{"tldr"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (m) {
      try {
        // JSON.parse handles all valid escape sequences (\n, \", \\, \uXXXX, etc.)
        const tldr = JSON.parse(`"${m[1]}"`);
        return { tldr, decision: null };
      } catch {
        // Couldn't unescape (probably broken mid-escape) — return raw chars; better than showing the JSON wrapper
        return { tldr: m[1], decision: null };
      }
    }
  }

  return null;
}

/** Strips the JSON envelope from a Claude response, leaving only the human-readable tldr.
 *  Pre-JSON preamble (if any) is kept as the first part; the extracted tldr is last. */
export function stripJsonParts(text: string): string[] {
  const trimmed = text.trim();
  const parsed = parseJsonResponse(trimmed);
  if (!parsed) return [text];

  const jsonStart = trimmed.indexOf('{"tldr"');
  const fenceStart = trimmed.search(/```(?:json)?\s*\{/);
  const cutPoint = fenceStart >= 0 ? fenceStart : jsonStart;

  const parts: string[] = [];
  if (cutPoint > 0) {
    const prefix = trimmed.slice(0, cutPoint).trim();
    if (prefix) parts.push(prefix);
  }
  if (parsed.tldr) {
    // Strip legacy TLDR prefixes Claude may have cached in session memory
    const clean = parsed.tldr.replace(/^(?:__\*\*TLDR\*\*__|#+\s*TLDR)\s*/i, '').trim();
    parts.push(`# TLDR\n${clean}`);
  }
  if (parsed.otherFindings) {
    parts.push(`# Other Findings\n${parsed.otherFindings}`);
  }
  if (parsed.assumptionsMade) {
    parts.push(`# Assumptions Made\n${parsed.assumptionsMade}`);
  }
  return parts.length > 0 ? parts : [text];
}

export function stripJson(text: string): string {
  return stripJsonParts(text).join('\n\n');
}

/** Wrap arbitrary text in a single backtick code span for the ⏳/⏸️ notices below — but
 *  only when the text itself contains no backticks. A decision summary that already
 *  contains its own inline code spans (e.g. "Merge with `gh pr merge 80`") would
 *  otherwise close the outer span at its first backtick, splitting the notice into a
 *  broken jumble of alternating code/plain-text fragments instead of one readable line.
 *  Falls back to the raw, unwrapped text so any inner code spans render correctly. */
function safeBacktickWrap(text: string): string {
  return text.includes('`') ? text : `\`${text}\``;
}

/** Convert markdown tables to key-value format for Discord (preserves links) */
export function formatForDiscord(text: string): string {
  // Cell parser that honors `\|` (escape syntax) and pipes inside `…` (inline
  // code spans) as LITERAL, not as delimiters. The naive `row.split('|')` shreds
  // any cell whose code sample contains pipes — exactly what produced the
  // mangled output when a 3-col table had a backticked example with `\|` in it
  // (cells beyond the header count fell through as orphan bare lines).
  const parseRow = (row: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let inBacktick = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      // Escaped pipe: consume both chars, emit literal '|' into the cell
      if (c === '\\' && row[i + 1] === '|') {
        cur += '|';
        i++;
        continue;
      }
      // Backtick toggles "inside inline code span" state
      if (c === '`') {
        inBacktick = !inBacktick;
        cur += c;
        continue;
      }
      // Pipe acts as a delimiter ONLY outside backtick spans
      if (c === '|' && !inBacktick) {
        cells.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    cells.push(cur);
    // Drop the leading/trailing empties that come from the outer `|`s, then trim each cell
    return cells.slice(1, -1).map(c => c.trim());
  };

  // Pass 1: standard headed tables (header + separator + data rows).
  let out = text.replace(
    /((?:^|\n)\|.+\|(?:\n\|[-:| ]+\|)(?:\n\|.+\|)+)/g,
    (table) => {
      const lines = (table.startsWith('\n') ? table.slice(1) : table).split('\n');
      const headers = parseRow(lines[0]);
      const dataRows = lines.slice(2).map(parseRow);

      // Defensive: if any data row's cell count doesn't match the header count,
      // the parser couldn't disambiguate something (most often: an unbalanced
      // backtick that left `inBacktick` stuck on, swallowing later pipes).
      // Leave the table alone rather than emit garbled output.
      if (dataRows.some(r => r.length !== headers.length)) return table;

      return '\n' + dataRows.map(cells =>
        cells.map((cell, i) => {
          const header = headers[i];
          return header ? `**${header}:** ${cell}` : cell;
        }).join('\n')
      ).join('\n\n');
    },
  );

  // Pass 2: header-less 2-column tables. Markdown requires a separator row, so
  // `| key | val |\n| key | val |` (no `| --- | --- |`) renders verbatim with
  // ugly literal pipes. Treat it as a key:value list — each row → `**key:** val`.
  // Constraints:
  //   - exactly 2 cells per row (3+ columns can't be unambiguously key:value'd)
  //   - non-empty cells (so `| | |` doesn't match)
  //   - ≥ 2 rows (so a stray `| a | b |` line in prose doesn't get rewritten)
  //   - bail out if any row looks like a markdown separator (all `-`/`:`/space) —
  //     that indicates a malformed headed table we shouldn't touch
  out = out.replace(
    /((?:^|\n)\|[^\n|]+\|[^\n|]+\|(?:\n\|[^\n|]+\|[^\n|]+\|)+)/g,
    (table) => {
      const block = table.startsWith('\n') ? table.slice(1) : table;
      const lines = block.split('\n');
      const parseRow = (row: string) => row.split('|').slice(1, -1).map(c => c.trim());
      const rows = lines.map(parseRow);
      // If any row is a separator (e.g. `| --- | --- |`), this is a malformed
      // headed table — leave it alone for the human to fix.
      if (rows.some(r => r.every(c => /^[-:\s]+$/.test(c) && c.length > 0))) return table;
      return '\n' + rows.map(([k, v]) => `**${k}:** ${v}`).join('\n');
    },
  );

  // Pass 3: auto-linkify emails and international phone numbers so they're tappable
  // in the Discord mobile app. URLs are skipped — Discord auto-linkifies plain
  // http(s) URLs without help. Content inside code spans, fenced blocks, and
  // existing markdown links is protected from transformation.
  out = autoLinkifyForDiscord(out);

  return out;
}

/**
 * Wrap emails and international phone numbers (those starting with `+`) in
 * markdown links so the Discord mobile app makes them tappable. Skips content
 * inside code spans, fenced code blocks, and existing markdown links — those
 * are either explicit code or already-formatted links and shouldn't be touched.
 *
 * Phone constraint: must start with `+` (E.164-ish) AND have 8–15 digits total.
 * Bare numbers like `555-1234` are ambiguous (could be a date, version, ID, etc.)
 * and stay alone. URLs are not wrapped — Discord handles them natively, and
 * wrapping `[https://x](https://x)` adds noise without changing behavior.
 */
function autoLinkifyForDiscord(text: string): string {
  const PROTECTED: string[] = [];
  const placeholder = (i: number) => ` PROT${i} `;
  let processed = text;

  const protect = (re: RegExp) => {
    processed = processed.replace(re, (match) => {
      const i = PROTECTED.length;
      PROTECTED.push(match);
      return placeholder(i);
    });
  };

  // Order matters: fenced blocks first (longest match wins), then inline code,
  // then existing markdown links. Each pass operates on already-redacted text.
  protect(/```[\s\S]*?```/g);
  protect(/`[^`\n]+`/g);
  protect(/\[[^\]]+\]\([^)]+\)/g);

  // Emails: standard local@domain.tld shape; word boundaries prevent gobbling
  // trailing punctuation ("foo@bar.com." → leaves the trailing period alone).
  processed = processed.replace(
    /\b([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\b/g,
    (m) => `[${m}](mailto:${m})`,
  );

  // International phones: must start with `+`, must end on a digit (so we don't
  // gobble a trailing `)` from "(+1-555-1234)"), and total digit count must be
  // 8–15 (E.164 spec). Anything outside that range is treated as not-a-phone.
  processed = processed.replace(
    /\+\d[\d\s().\-]{5,18}\d/g,
    (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) return m;
      return `[${m}](tel:+${digits})`;
    },
  );

  // Restore protected regions in their original positions.
  return processed.replace(/ PROT(\d+) /g, (_, idx) => PROTECTED[Number(idx)]);
}

export function extractDecision(text: string): { summary: string; rating: number } | null {
  const parsed = parseJsonResponse(text);
  return parsed?.decision ?? null;
}

function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Returns wall-clock time remaining until a deadline fires (e.g. "in 3h", "in 45m", "overdue"). */
export function timeUntil(deadline: string): string {
  const diffMs = new Date(deadline).getTime() - Date.now();
  if (diffMs <= 0) return 'overdue';
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}

const PROJECT_SYSTEM_PROMPT = `IMPORTANT: Your response MUST be valid JSON in this exact format:
{"tldr": "your response here", "other_findings": "secondary details/context not central to the tldr, or empty string if none", "assumptions_made": "assumptions you made while answering, or empty string if none", "decision": "what to do next", "rating": 0}

Formatting: Output is displayed in Discord. Markdown tables are fine — they will be post-processed into key-value format. When listing local file paths you want auto-uploaded to Discord (e.g. generated assets, output files), do NOT wrap them in a triple-backtick code fence — fenced blocks are treated as example code and are stripped before the auto-uploader scans for paths, so fenced paths silently never upload. List them as plain lines instead.

decision is NEVER null/empty. After completing any work, ALWAYS suggest what to do next and rate its impact.

Rate decisions 0-10:
- 0: trivial continuation of the current task (e.g. "continue translating the rest?", "proceed with commit?"). System auto-continues immediately.
- 1-3: low impact, needs brief user input (variable naming, minor config choices)
- 4-6: moderate impact, needs details (which approach to refactor, feature design)
- 7-9: high impact, needs human judgment (architecture, framework choice, API design)
- 10: critical, irreversible (breaking changes, data migration, deleting data)

If multiple decisions needed, combine into one question.
Document the user's response to .saint-expeditus/PROJECT_DECISIONS.md if needed.`;

const SUBAGENT_HINT = '\n\nUse subagents if necessary. Use sonnet model for subagents.';
const AUTO_DECIDE_PROMPT = `Make an informed decision for me${SUBAGENT_HINT}`;
const AUTO_DECIDE_NUDGE = `Make an informed decision for me${SUBAGENT_HINT}`;
const PROMPT_TOO_LONG_MARKER = 'prompt is too long';

/** True for the two documented JSON-free response shapes: the bare `NO_CONS` token and the
 *  strict `PROS:`/`CONS:` bullet format, both used by the "why are you asking me — real cons?"
 *  behavioural test (see PROJECT_SYSTEM_PROMPT's sibling instruction). Both are intentionally
 *  JSON-free, so the missing-envelope reprompt below must never fire on them. */
export function isJsonEnvelopeExempt(text: string): boolean {
  const trimmed = text.trim();
  if (/^NO_CONS$/.test(trimmed)) return true;
  return /^PROS:/m.test(trimmed) && /^CONS:/m.test(trimmed);
}

/** Sent once when a response has no parseable {tldr, decision} JSON at all (and isn't one
 *  of the exempt shapes above) — asks Claude to resend in the required format and reminds it
 *  to keep including it going forward. */
const MISSING_JSON_ENVELOPE_REPROMPT =
  'Your last reply did not include the required `{"tldr": "...", "other_findings": "...", "assumptions_made": "...", "decision": "...", "rating": 0-10}` ' +
  'JSON envelope. Please resend your last answer wrapped in that exact JSON format now, and remember to include it ' +
  'in every reply going forward.';

/** Responses that mean the bot is idle — nudge immediately instead of waiting */
const STALL_RESPONSES = [
  'All tasks complete.',
  'All done.',
  'Nothing to do.',
  'Waiting for instructions.',
];

/** Exported so cron.ts can use the same thresholds without duplicating them */
export const COMPACT_THRESHOLD_PCT = 75;
export const COMPACT_IDLE_MINUTES = 60;
// A session this full can't compact itself (the /compact turn deadlocks on a maxed
// context), so compaction can't recover it. Above this, auto-roll over instead:
// snapshot → reset → reseed from HANDOFF.md. See proactiveRollover / rolloverSession.
export const CRITICAL_ROLLOVER_PCT = 92;

/** Handover rollover: written to the DYING session to snapshot state before reset. */
const HANDOVER_WRITE_PROMPT =
  'We are about to roll this session over into a fresh one to reclaim context. ' +
  'FIRST, create or update HANDOFF.md for this project (reuse the existing one if there is one — try `find . -name HANDOFF.md`; otherwise create it in the project root) capturing everything a brand-new session with ZERO memory needs to continue seamlessly: current objective, in-progress tasks, key decisions and constraints, important file paths, and the immediate next steps. Be thorough but tight, and overwrite stale sections. Streamline this moving forward. Drop any obsolete documentation. Save the file with Write/Edit. ' +
  'Your entire reply must be the literal token HANDOFF_SAVED on its own line — no JSON, nothing else.';

/** Handover rollover: written to the FRESH session so it self-seeds from the handoff. */
const HANDOVER_RESEED_PROMPT =
  'You are resuming this project in a FRESH session with no prior conversation memory. ' +
  'Locate and read HANDOFF.md for this project (`find . -name HANDOFF.md`, check the project root and subdirectories), plus any files it points you to, so you are fully caught up on state and next steps. ' +
  'Also read .saint-expeditus/PROJECT_DECISIONS.md if it exists — it holds durable decisions that outlive any single session and HANDOFF.md may not repeat. ' +
  'Then give a brief TLDR of where things stand and the immediate next step. ' +
  'Your ENTIRE reply MUST be a single valid JSON object in exactly this format — nothing before or after it:\n' +
  '{"tldr": "your TLDR here", "other_findings": "", "assumptions_made": "", "decision": "the immediate next step", "rating": 0-10}\n' +
  'decision is NEVER null/empty. Put the TLDR in "tldr" and the next step + its impact rating in "decision"/"rating" (rate per the 0-10 scale in your system prompt).';

const REGISTER_PROMPT_PREFIX = `The user wants to register a new project for multi-project management.
Help them provide: project title, absolute directory path, and a URL-safe slug.
If the directory seems wrong, search for the correct one using Bash or Glob.
When all details are confirmed by the user, output EXACTLY this on its own line:
REGISTER::{"title":"...","slug":"...","directory":"...","description":"..."}
Do not output REGISTER:: until the user confirms.`;

// "For later:" (+ aliases) — a message a user parks while the bot is mid-work.
// Held at the bridge (never triggers a query, which would kill the in-flight
// process) until the current run pauses (auto-decide loop ends: real pros/cons or
// a rating > 0 decision), then injected with this reframe so Claude documents the
// pause, then works the parked item next (not immediately mid-stream). Any of these
// colon-prefixes trigger it.
const FOR_LATER_RE =
  /^\s*(?:for\s+later|later|todo|to-do|backlog|defer|parking\s+lot|park(?:\s+this)?|queue(?:\s+this)?|not\s+now)\s*:\s*([\s\S]*)$/i;
const FOR_LATER_RESUME_PREFIX =
  "Hold off on this for now and document it so we can resume later. Streamline this moving forward. Drop any obsolete documentation. After you're done with that, work on this next:\n\n";
// Several "For later:" tasks queued during one run are released together as one turn
// (one doc pass, one decision) rather than N noisy turns. Body is a numbered list.
const FOR_LATER_RESUME_PREFIX_PLURAL =
  "Hold off on these for now and document them so we can resume later. Streamline this moving forward. Drop any obsolete documentation. After you're done with that, work on these next:\n\n";

export class CommandRouter {
  /** Slugs with a project turn currently running (used to hold "For later:" messages). */
  private inFlight = new Set<string>();
  /** Per-slug queue of parked "For later:" tasks, drained when the in-flight run pauses. */
  private deferredTasks = new Map<string, string[]>();

  constructor(
    private sessionManager: SessionManager,
    private projectStore: ProjectStore,
    private config: Config,
  ) {}

  async handle(
    payload: AskPayload,
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
    onFinalPrompt?: (text: string) => void,
  ): Promise<{ response: string; projectSlug?: string; parked?: boolean }> {
    const text = payload.trigger.originalMessage.trim();
    const { command, args } = this.parseCommand(text);

    switch (command) {
      case 'list': return this.handleList();
      case 'details':
      case 'info': return this.handleDetails(args);
      case 'register': return this.handleRegister(args, payload, onMessage, onToolUse);
      case 'update': return this.handleUpdate(args, payload, onMessage, onToolUse);
      case 'vacation': return this.handleVacation();
      case 'unvacation': return this.handleUnvacation();
      case 'auto-decide-extend': return this.handleAutoDecideExtend(args);
      case 'reset': return this.handleReset(args);
      case 'compact': return this.handleCompact(args, onMessage, onToolUse);
      case 'handover':
      case 'rollover': return this.handleHandover(args, onMessage, onToolUse);
      case 'nudge': return this.handleNudge(args, onMessage, onToolUse, onFinalPrompt);
      case 'help': return this.handleHelp();
      case 'expeditus': return this.handleExpeditus(payload, onMessage, onToolUse, onFinalPrompt);
      default: {
        const project = await this.projectStore.load(command);
        if (project) return this.handleProject(project, args, onMessage, onToolUse, onFinalPrompt);
        return { response: `Unknown command: /${command}` };
      }
    }
  }

  private parseCommand(text: string): { command: string; args: string } {
    const match = text.match(/^\/([a-z0-9-]+)\s*([\s\S]*)$/i);
    if (!match) return { command: '', args: text };
    return { command: match[1].toLowerCase(), args: match[2].trim() };
  }

  private async handleList(): Promise<{ response: string }> {
    const projects = await this.projectStore.loadAll();
    if (projects.length === 0) return { response: 'No projects registered. Use /register to add one.' };

    const lines = projects.map(p => {
      const idle = p.lastConversationAt ? ` · ${relativeTime(new Date(p.lastConversationAt))}` : '';
      const ctx = p.contextUsedPct != null ? ` · ctx ${p.contextUsedPct}%` : '';
      let statusLine: string;
      if (p.decision) {
        // Decision pending — lead with the decision; skip the verbose status
        const summary = p.decision.summary.slice(0, 60);
        const countdown = p.decision.rating < 10 && p.decision.deadline
          ? ` · ${timeUntil(p.decision.deadline)}`
          : ' · waiting for you';
        statusLine = `⏳ *${summary}*${countdown}`;
      } else {
        statusLine = p.status.length > 70 ? p.status.slice(0, 67) + '…' : p.status;
      }
      return `**${p.title}** /${p.slug}\n${statusLine}${idle}${ctx}`;
    });
    return { response: lines.join('\n\n') };
  }

  private async handleDetails(filter?: string): Promise<{ response: string }> {
    let projects = await this.projectStore.loadAll();
    if (projects.length === 0) return { response: 'No projects registered.' };
    if (filter) {
      const slug = filter.trim().toLowerCase();
      projects = projects.filter(p => p.slug === slug);
      if (projects.length === 0) return { response: `Project "${slug}" not found. Use /list to see all projects.` };
    }

    const sections = projects.map(p => {
      const lastActive = p.lastConversationAt
        ? relativeTime(new Date(p.lastConversationAt))
        : 'never';
      const lines = [
        `**${p.title}**`,
        `Command: /${p.slug}`,
        `Directory: ${p.directory}`,
        `Description: ${p.description}`,
        `Status: ${p.status}`,
        `Auto-decide: ${p.autoDecide ? 'yes' : 'no'}`,
        `Context: ${p.contextUsedPct != null ? `${p.contextUsedPct}% used` : 'unknown'}`,
        `Session: ${p.sessionId ? `active (${p.sessionId.slice(0, 8)}…)` : 'none'}`,
        `Last active: ${lastActive}`,
      ];
      if (p.decision) {
        lines.push(`Decision: ${p.decision.summary} (rating: ${p.decision.rating})`);
        lines.push(`Deadline: ${p.decision.deadline}`);
      }
      return lines.join('\n');
    });
    return { response: sections.join('\n\n') };
  }

  private async handleRegister(args: string, _payload: AskPayload, onMessage?: (text: string) => void, onToolUse?: (name: string, detail: string) => void): Promise<{ response: string }> {
    const prompt = args
      ? `${REGISTER_PROMPT_PREFIX}\n\nUser says: ${args}`
      : REGISTER_PROMPT_PREFIX;

    const result = await this.querySession('_register', prompt, onMessage, onToolUse);

    const registerMatch = result.text.match(/REGISTER::(\{[\s\S]*?\})/);
    if (registerMatch) {
      try {
        const data = JSON.parse(registerMatch[1]);
        const project = await this.projectStore.create({
          title: data.title,
          slug: data.slug,
          description: data.description,
          directory: data.directory,
          autoDecide: true,
        });
        const confirmation = result.text.replace(/REGISTER::\{[\s\S]*?\}/, '').trim();
        return {
          response: `${confirmation}\n\nProject registered!\nTitle: ${project.title}\nCommand: /${project.slug}\nDirectory: ${project.directory}`.trim(),
        };
      } catch (err) {
        console.error(`[CommandRouter] register: failed to parse REGISTER payload: ${(err as Error).message}`);
        return { response: 'Registration failed — could not parse project data. Please try again.' };
      }
    }

    return { response: result.text };
  }

  private async handleUpdate(args: string, _payload: AskPayload, onMessage?: (text: string) => void, onToolUse?: (name: string, detail: string) => void): Promise<{ response: string }> {
    const projects = await this.projectStore.loadAll();
    const projectList = projects.map(p => `- /${p.slug}: ${p.title} (${p.directory})`).join('\n');
    const prompt = `The user wants to update project details. Current projects:\n${projectList}\n\nUser says: ${args || 'show me the projects'}`;
    const result = await this.querySession('_update', prompt, onMessage, onToolUse);
    return { response: result.text };
  }

  private async handleVacation(): Promise<{ response: string }> {
    if (await this.projectStore.isVacation()) {
      return { response: 'Already on vacation mode.' };
    }

    const projects = await this.projectStore.loadAll();
    const now = new Date();

    for (const project of projects) {
      if (project.decision?.deadline) {
        project.decision.pausedRemaining = pauseForVacation(project.decision.deadline, now);
        project.decision.deadline = '';
        await this.projectStore.save(project);
      }
    }

    await this.projectStore.setVacation(true);
    return { response: 'Vacation mode ON. All auto-decide timers paused.' };
  }

  private async handleUnvacation(): Promise<{ response: string }> {
    if (!(await this.projectStore.isVacation())) {
      return { response: 'Not in vacation mode.' };
    }

    const projects = await this.projectStore.loadAll();
    const now = new Date();

    for (const project of projects) {
      if (project.decision?.pausedRemaining != null) {
        project.decision.deadline = deadlineFromActiveHours(project.decision.pausedRemaining, now);
        project.decision.pausedRemaining = null;
        await this.projectStore.save(project);
      }
    }

    await this.projectStore.setVacation(false);
    return { response: 'Vacation mode OFF. Auto-decide timers resumed.' };
  }

  private async handleAutoDecideExtend(args: string): Promise<{ response: string }> {
    const projects = await this.projectStore.loadAll();
    const withDecisions = projects.filter(p => p.decision?.deadline);

    if (withDecisions.length === 0) {
      return { response: 'No projects have pending decisions to extend.' };
    }

    let target: ProjectConfig;
    if (withDecisions.length === 1) {
      target = withDecisions[0];
    } else if (args) {
      const found = withDecisions.find(p => p.slug === args.trim().toLowerCase());
      if (!found) return { response: `Project "${args}" not found or has no pending decision. Options: ${withDecisions.map(p => p.slug).join(', ')}` };
      target = found;
    } else {
      return { response: `Multiple projects have pending decisions. Specify one: ${withDecisions.map(p => `/${p.slug}`).join(', ')}` };
    }

    const WEEK_ACTIVE_HOURS = 84;
    target.decision!.deadline = extendDeadline(target.decision!.deadline, WEEK_ACTIVE_HOURS);
    const dl = formatTimestamp(new Date(target.decision!.deadline));
    await this.projectStore.save(target);

    return { response: `Extended ${target.title} auto-decide to ${dl}` };
  }

  private async handleReset(args: string): Promise<{ response: string }> {
    const slug = args.trim().toLowerCase();
    if (!slug) return { response: 'Usage: /reset <project-slug>' };

    const project = await this.projectStore.load(slug);
    if (!project) return { response: `Project "${slug}" not found.` };

    this.sessionManager.resetSession(slug);
    project.sessionId = null;
    project.status = 'Awaiting first message';
    project.decision = null;
    project.contextUsedPct = null;
    delete (project as Partial<typeof project>).lastConversationAt;
    await this.projectStore.save(project);

    return { response: `Reset session for ${project.title}. Next message will start a fresh conversation.` };
  }

  private async handleCompact(args: string, onMessage?: (text: string) => void, onToolUse?: (name: string, detail: string) => void): Promise<{ response: string; projectSlug?: string }> {
    const slug = args.trim().toLowerCase();
    if (!slug) return { response: 'Usage: /compact <project-slug>' };

    const project = await this.projectStore.load(slug);
    if (!project) return { response: `Project "${slug}" not found.` };
    if (!project.sessionId) return { response: `${project.title} has no active session to compact.` };

    const before = project.contextUsedPct;
    console.log(`[CommandRouter] ${slug}: manual compact (context ${before ?? '?'}% used)`);

    await this.sessionManager.query(project.slug, '/compact', {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      onMessage,
      onToolUse,
    });

    // Follow-up to verify context shrank (no streaming — just a check)
    const check = await this.sessionManager.query(project.slug, 'Acknowledge.', {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      maxTurns: 1,
    });

    if (check.contextUsedPct != null) project.contextUsedPct = check.contextUsedPct;
    if (check.sessionId) project.sessionId = check.sessionId;
    await this.projectStore.save(project);

    const beforeStr = before != null ? `${before}%` : '?%';
    const afterStr = check.contextUsedPct != null ? `${check.contextUsedPct}%` : '?%';
    return { response: `🗜️ Compacted **${project.title}**: ${beforeStr} → ${afterStr}`, projectSlug: slug };
  }

  /**
   * Roll a project's session over into a fresh one WITHOUT losing continuity:
   *   1. Ask the current (possibly context-maxed) session to write/update HANDOFF.md — best-effort.
   *   2. Reset the session (wipe context).
   *   3. Reseed a fresh session that reads the handoff + required context and resumes normally.
   * Unlike /compact (which deadlocks once the session is too full to summarise itself), this
   * always yields a working fresh session — falling back to the last-saved HANDOFF.md if the
   * live write fails. Triggered by /handover <slug> or the ♻️ reaction.
   */
  private async handleHandover(args: string, onMessage?: (text: string) => void, onToolUse?: (name: string, detail: string) => void): Promise<{ response: string; projectSlug?: string }> {
    const slug = args.trim().toLowerCase();
    if (!slug) return { response: 'Usage: /handover <project-slug>' };

    const project = await this.projectStore.load(slug);
    if (!project) return { response: `Project "${slug}" not found.` };

    const response = await this.rolloverSession(project, onMessage, onToolUse);
    return { response, projectSlug: slug };
  }

  /**
   * Core rollover: snapshot state into HANDOFF.md (best-effort), reset the session,
   * then reseed a fresh one from the handoff. Shared by the /handover command / ♻️
   * reaction (handleHandover) and the automatic critical-context fallback
   * (proactiveRollover). Always yields a working fresh session.
   */
  private async rolloverSession(
    project: ProjectConfig,
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
  ): Promise<string> {
    const slug = project.slug;
    console.log(`[CommandRouter] ${slug}: handover rollover (context ${project.contextUsedPct ?? '?'}% used)`);

    // 1. Best-effort: snapshot state into HANDOFF.md via the current session before we wipe it.
    //    If the session is already maxed (deadlocked → empty/143), this throws; we log and
    //    roll over anyway, reseeding from whatever HANDOFF.md was last saved.
    let handoffWritten = false;
    if (project.sessionId) {
      onMessage?.('📝 Snapshotting state into HANDOFF.md before rollover…');
      try {
        await this.sessionManager.query(slug, HANDOVER_WRITE_PROMPT, {
          cwd: project.directory,
          systemPrompt: PROJECT_SYSTEM_PROMPT,
          onToolUse,
        });
        handoffWritten = true;
      } catch (err) {
        console.warn(`[CommandRouter] ${slug}: handover write failed (session likely maxed): ${(err as Error).message}`);
        onMessage?.('⚠️ Live handover write failed (session maxed) — rolling over from the last saved HANDOFF.md.');
      }
    }

    // 2. Reset the session (context → 0). Persist the wipe to disk IMMEDIATELY, before the
    //    reseed — if the catch-up query below throws (e.g. it also returns empty), we must not
    //    leave the maxed sessionId on disk, or every cron tick reloads it and repeats forever.
    //    A cleared session simply starts fresh on the next message.
    this.sessionManager.resetSession(slug);
    project.sessionId = null;
    project.contextUsedPct = null;
    await this.projectStore.save(project);

    // 3. Reseed a fresh session: read the handoff + required context, resume in normal format.
    onMessage?.('♻️ Fresh session catching up on the handover…');
    const seed = await this.sessionManager.query(slug, HANDOVER_RESEED_PROMPT, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      onToolUse,
    });
    if (seed.sessionId) project.sessionId = seed.sessionId;
    if (seed.contextUsedPct != null) project.contextUsedPct = seed.contextUsedPct;
    project.lastConversationAt = new Date().toISOString();

    // The reseed prompt forces the JSON envelope, so the fresh session ends with a
    // {message, decision} — extract it and set it as a real pending decision so the
    // rollover behaves exactly like a normal turn (deadline + auto-decide apply).
    const decision = extractDecision(seed.messages[seed.messages.length - 1] ?? seed.text);
    let decisionSuffix = '';
    if (decision) {
      const deadline = calculateDeadline(decision.rating);
      const dl = formatTimestamp(deadline);
      project.status = `Rolled over at ${formatTimestamp(new Date())}. Awaiting decision: ${decision.summary}. Auto-decides at ${dl}.`;
      project.decision = { summary: decision.summary, rating: decision.rating, deadline: deadline.toISOString(), pausedRemaining: null };
      const autoDecideText = decision.rating >= 10 ? '' : ` — auto-decides at ${dl}`;
      decisionSuffix = `\n\n⏳ **Decision needed (rating ${decision.rating}):** ${safeBacktickWrap(decision.summary)}${autoDecideText}`;
    } else {
      project.status = `Rolled over at ${formatTimestamp(new Date())}`;
    }
    await this.projectStore.save(project);

    const ctxStr = seed.contextUsedPct != null ? `${seed.contextUsedPct}%` : '?%';
    const writeStr = handoffWritten ? 'handoff updated' : 'used last-saved handoff';
    const caughtUp = stripJson(seed.text) || '(fresh session ready — send a message to continue)';
    // Emit the full summary (header + TLDR + decision) via onMessage so it always posts:
    // the progress lines above make singleShot false, so the returned value alone would be
    // dropped by the client. Return it too, for upload path-scanning + cron logging.
    const summary = `♻️ **Rolled over ${project.title}** (${writeStr}) · ctx ${ctxStr}\n\n${caughtUp}${decisionSuffix}`;
    onMessage?.(summary);
    return summary;
  }

  /**
   * Automatic fallback for a critically-full session (≥ CRITICAL_ROLLOVER_PCT) that
   * compaction can't recover. Same idle/session guards as proactiveCompact so we never
   * interrupt active work. Returns a notice on rollover, else null. Called by cron after
   * a proactive compact fails to bring context below the critical line.
   */
  async proactiveRollover(
    project: ProjectConfig,
    idleMinutes = COMPACT_IDLE_MINUTES,
    criticalThreshold = CRITICAL_ROLLOVER_PCT,
    onMessage?: (text: string) => void,
  ): Promise<string | null> {
    if (project.contextUsedPct == null || project.contextUsedPct < criticalThreshold) return null;
    if (!project.sessionId) return null;
    if (!project.lastConversationAt) return null;
    const idleMs = Date.now() - new Date(project.lastConversationAt).getTime();
    if (idleMs < idleMinutes * 60_000) return null;

    console.log(`[CommandRouter] ${project.slug}: critical context ${project.contextUsedPct}% — auto-rollover (compaction can't recover)`);
    return this.rolloverSession(project, onMessage);
  }

  private handleHelp(): { response: string } {
    const lines = [
      '**Saint Expeditus — Commands**',
      '',
      '**Projects**',
      '`/list` — all projects with status, decision & ctx%',
      '`/details [slug]` — full details (optional: one project)',
      '`/<slug> <message>` — send message to a project session',
      '`/nudge <slug>` — immediately trigger auto-decide',
      '`/compact <slug>` — compact the session context window',
      '`/reset <slug>` — wipe session and start fresh',
      '`/register` — register a new project',
      '`/update` — edit project details',
      '',
      '**Scheduling**',
      '`/vacation` — pause all auto-decide timers',
      '`/unvacation` — resume timers',
      '`/auto-decide-extend [slug]` — extend deadline by 1 week',
      '`/budget` — current hourly session budget and upstream usage',
      '',
      '**In project threads:** `/compact` and `/nudge` (no args) apply to that project.',
    ];
    return { response: lines.join('\n') };
  }

  private async handleNudge(
    args: string,
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
    onFinalPrompt?: (text: string) => void,
  ): Promise<{ response: string; projectSlug?: string }> {
    const slug = args.trim().toLowerCase();
    if (!slug) return { response: 'Usage: /nudge <project-slug>' };

    const project = await this.projectStore.load(slug);
    if (!project) return { response: `Project "${slug}" not found.` };

    console.log(`[CommandRouter] ${slug}: manual nudge`);
    // Let autoDecide read and clear project.decision — preserves the summary label in the response
    const response = await this.autoDecide(project, onMessage, onToolUse, onFinalPrompt);
    return { response, projectSlug: slug };
  }

  private async handleExpeditus(
    payload: AskPayload,
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
    onFinalPrompt?: (text: string) => void,
  ): Promise<{ response: string; projectSlug?: string }> {
    const systemPrompt = await buildSystemPrompt(this.config.promptFile);
    const userMessage = buildUserMessage(payload, this.config.maxContextMessages);

    // Only include memory files on fresh sessions (no session ID yet)
    // Resumed sessions already have memory in context
    const hasSession = !!this.sessionManager.getSessionId('expeditus');
    const fullPrompt = hasSession
      ? userMessage
      : `${await this.readMemoryFiles()}\n\n${userMessage}`;

    onFinalPrompt?.(fullPrompt);

    const result = await this.sessionManager.query('expeditus', fullPrompt, {
      cwd: path.resolve(this.config.memoryDir, '..'),
      systemPrompt,
      allowedTools: ['WebFetch', 'WebSearch', 'Read(./memory/*)', 'Write(./memory/*)'],
      model: this.config.model,
      onMessage,
      onToolUse,
    });

    return { response: result.text, projectSlug: 'expeditus' };
  }

  private async handleProject(
    project: ProjectConfig,
    args: string,
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
    onFinalPrompt?: (text: string) => void,
  ): Promise<{ response: string; projectSlug: string; parked?: boolean }> {
    const slug = project.slug;

    // "For later:" — if a run is already in flight for this project, DON'T start a
    // query (session-manager would kill the running process). Park the task and ack;
    // it's drained after the current run pauses. See FOR_LATER_RESUME_PREFIX.
    //
    // `parked: true` (added 2026-08-03) lets discord-bot know this call never ran a real
    // turn — no query, no tool calls — so any attachment downloaded for THIS message must
    // not be cleaned up on the strength of this call's (empty) referencedAttachments: the
    // actual deferred turn runs later, inside a DIFFERENT sendBridgeRequest invocation (the
    // one for whichever message was in flight), which has no knowledge of this attachment at
    // all. Real incident: an image sent alongside a "For later:" message was deleted within
    // moments of download because this call resolves near-instantly once queued, long before
    // the drained turn could ever Read it. See sweepStaleAttachments() in discord-bot for the
    // eventual cleanup of anything left behind by a parked call.
    const forLater = args.match(FOR_LATER_RE);
    if (forLater && this.inFlight.has(slug)) {
      const task = forLater[1].trim();
      const q = this.deferredTasks.get(slug) ?? [];
      q.push(task);
      this.deferredTasks.set(slug, q);
      const depth = q.length > 1 ? ` (${q.length} queued)` : '';
      const notice = `⏳ **Held for later**${depth} — will resume when the current work pauses:\n> ${task.slice(0, 300)}`;
      return { response: notice, projectSlug: slug, parked: true };
    }

    if (project.decision) {
      project.status = `Operational with user response: ${args.slice(0, 80)} at ${formatTimestamp()}`;
      project.decision = null;
      await this.projectStore.save(project);
    }

    // No sessionId → start a FRESH session. We deliberately do not "discover" and adopt the
    // newest session in this project's directory: that hijacked unrelated sessions (a human's
    // interactive `claude` in the same repo) and defeated /reset by re-adopting the wiped session.

    // Check for provider prefix: "gemini: do something" or "claude: do something"
    let provider: 'claude' | 'gemini' = this.config.defaultProvider;
    let cleanArgs = args;
    const providerMatch = args.match(/^(gemini|claude):\s*([\s\S]*)$/i);
    if (providerMatch) {
      provider = providerMatch[1].toLowerCase() as 'claude' | 'gemini';
      cleanArgs = providerMatch[2].trim();
    }

    // "For later:" with nothing in flight — nothing to wait for, so reframe and run now.
    if (forLater) {
      cleanArgs = FOR_LATER_RESUME_PREFIX + forLater[1].trim();
    }

    this.inFlight.add(slug);
    try {
      let { response } = await this.runTurn(project, cleanArgs, provider, onMessage, onToolUse, onFinalPrompt);

      // Drain "For later:" tasks parked while this run was in flight. The run just
      // paused (auto-decide loop ended), so it's safe to inject them now — as a
      // "document the pause, then work these next" batch, released together in one
      // turn rather than N noisy turns. Anything that arrives DURING that turn is
      // picked up by the next while iteration.
      while ((this.deferredTasks.get(slug)?.length ?? 0) > 0) {
        const q = this.deferredTasks.get(slug)!;
        const batch = q.splice(0, q.length);
        this.deferredTasks.delete(slug);
        const multi = batch.length > 1;
        const listNotice = batch.map(t => `> ${t.slice(0, 200)}`).join('\n');
        onMessage?.(`♻️ **Resuming ${batch.length} held task${multi ? 's' : ''}:**\n${listNotice}`);
        const body = multi
          ? batch.map((t, i) => `${i + 1}. ${t}`).join('\n')
          : batch[0];
        const prefix = multi ? FOR_LATER_RESUME_PREFIX_PLURAL : FOR_LATER_RESUME_PREFIX;
        const extra = await this.runTurn(
          project, prefix + body, provider, onMessage, onToolUse, onFinalPrompt,
        );
        response += `\n\n${extra.response}`;
      }

      return { response, projectSlug: slug };
    } finally {
      this.inFlight.delete(slug);
    }
  }

  /** Run a single project turn: query Claude, then drive the auto-decide loop. */
  private async runTurn(
    project: ProjectConfig,
    cleanArgs: string,
    provider: 'claude' | 'gemini',
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
    onFinalPrompt?: (text: string) => void,
  ): Promise<{ response: string; projectSlug: string }> {
    // Always tell Claude the current wall-clock time. Optionally pair with elapsed-time
    // staleness when ≥1h has passed since the last conversation, so reasoning that depends
    // on "what time is it" or "how long has it been" doesn't have to guess.
    const nowFormatted = formatTimestamp();
    let timeHint = `\n\n(Current time: ${nowFormatted}.)`;
    if (project.lastConversationAt) {
      const elapsedHours = (Date.now() - new Date(project.lastConversationAt).getTime()) / (1000 * 60 * 60);
      if (elapsedHours >= 1) {
        const elapsedDays = Math.round(elapsedHours / 24);
        const staleness = elapsedHours >= 20
          ? `${elapsedDays} day${elapsedDays !== 1 ? 's' : ''}`
          : `${Math.round(elapsedHours)} hour${Math.round(elapsedHours) !== 1 ? 's' : ''}`;
        timeHint = `\n\n(Current time: ${nowFormatted}. It's been ${staleness} since we last spoke.)`;
      }
    }

    const subagentHint = provider === 'claude' ? '\n\nUse subagents if necessary. Use sonnet model for subagents.' : '';
    const userPrompt = (cleanArgs || 'Continue') + timeHint + subagentHint;
    onFinalPrompt?.(userPrompt);
    const result = await this.queryWithCompact(project.slug, userPrompt, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      provider,
      onMessage,
      onToolUse,
    });

    project.lastConversationAt = new Date().toISOString();
    if (result.contextUsedPct != null) project.contextUsedPct = result.contextUsedPct;
    if (result.sessionId && result.sessionId !== project.sessionId) {
      project.sessionId = result.sessionId;
    }
    await this.projectStore.save(project);

    // Collect all display messages (intermediate + final)
    const displayMessages: string[] = [];
    for (const msg of result.messages) {
      const cleaned = stripJson(msg);
      if (cleaned) displayMessages.push(cleaned);
    }
    if (displayMessages.length === 0) {
      displayMessages.push(stripJson(result.text) || result.text);
    }

    // If the response is a stall phrase, nudge immediately (unless on vacation)
    // Check raw message (pre-TLDR) to avoid prefix interference
    const lastRaw = result.messages[result.messages.length - 1] ?? result.text;
    const lastRawMessage = parseJsonResponse(lastRaw)?.tldr?.trim() ?? '';
    const isStalled = STALL_RESPONSES.some(s => lastRawMessage === s);
    let nudgeResult: { text: string; messages: string[]; toolsUsed: string[] } | null = null;
    if (isStalled && !(await this.projectStore.isVacation())) {
      const notice = `⚡ **Nudging:** "${lastRawMessage}"`;
      onMessage?.(notice);

      onFinalPrompt?.(AUTO_DECIDE_NUDGE);
      nudgeResult = await this.queryWithCompact(project.slug, AUTO_DECIDE_NUDGE, {
        cwd: project.directory,
        systemPrompt: PROJECT_SYSTEM_PROMPT,
        provider,
        onMessage,
        onToolUse,
      });

      for (const msg of nudgeResult.messages) {
        const cleaned = stripJson(msg);
        if (cleaned) displayMessages.push(cleaned);
      }
      if (nudgeResult.messages.length === 0) {
        displayMessages.push(stripJson(nudgeResult.text) || nudgeResult.text);
      }
    }

    // Try to extract decision from the last raw message
    let decisionSuffix = '';
    let decisionSource = result.messages[result.messages.length - 1] ?? result.text;
    if (isStalled && nudgeResult) {
      decisionSource = nudgeResult.messages[nudgeResult.messages.length - 1] ?? nudgeResult.text;
    }
    const decision = await this.enforceJsonEnvelope(
      project, decisionSource, displayMessages, { provider }, onMessage, onToolUse, onFinalPrompt,
    );

    if (decision) {
      let { summary, rating } = decision;

      // If Claude is waiting for anything, never auto-decide
      const summaryLower = summary.toLowerCase();
      if (summaryLower.includes('waiting for') || summaryLower.includes('waiting on')) {
        console.log(`[CommandRouter] ${project.slug}: bumped rating ${rating}→10 (waiting: "${summary.slice(0, 60)}")`);
        rating = 10;
      }

      // Single message + no tools = Claude didn't do real work, don't auto-decide
      if (result.messages.length <= 1 && result.toolsUsed.length === 0 && rating < 10) {
        console.log(`[CommandRouter] ${project.slug}: bumped rating ${rating}→10 (single message, no tools)`);
        rating = 10;
      }

      // Auto-commit: if Claude asks "should I commit", just say yes
      if (summaryLower.includes('should') && summaryLower.includes('commit')) {
        console.log(`[CommandRouter] ${project.slug}: auto-answering commit question with yes`);
        rating = 0;
        summary = 'Yes, commit.';
      }

      // Question-shaped decisions: re-prompt for pros/cons. NO_CONS → auto-yes (rating 0
      // → enters the loop below); otherwise rating stays and decision goes to user.
      ({ summary, rating } = await this.runProsCons(project, summary, rating, onMessage, onToolUse, onFinalPrompt));

      const hours = ratingToHours(rating);

      if (hours === 0) {
        const MAX_AUTO_DECIDES = 30;
        let autoCount = 0;

        // Streak only counts within the loop. We must NOT carry over a "1-message + no-tools"
        // signal from the pre-loop response: when entering via NO_CONS / auto-commit rewrite,
        // the original was just a question (no work yet), but real work happens INSIDE the loop.
        // Starting streak at 1 there would fire AUTO_DECIDE_NUDGE on iter #1 prematurely.
        let singleMessageStreak = 0;
        let lastSummary = '';
        let repeatCount = 0;
        const MAX_REPEAT_SUMMARIES = 2;
        let lastLoopContextPct: number | null = null;
        // Echo the auto-decide prompt only when it CHANGES (PROMPT ↔ NUDGE) so we
        // don't spam the same '📨 sent to Claude:' block 30 times across iterations.
        let lastEchoedPrompt: string | null = null;

        while (autoCount < MAX_AUTO_DECIDES) {
          autoCount++;
          const notice = `⚡ **Auto-decided (${autoCount}/${MAX_AUTO_DECIDES}):** \`${summary}\``;
          onMessage?.(notice);

          // If Claude keeps responding with just 1 message (no tool use), nudge it to batch more
          const prompt = singleMessageStreak >= 1 ? AUTO_DECIDE_NUDGE : AUTO_DECIDE_PROMPT;
          if (prompt !== lastEchoedPrompt) {
            onFinalPrompt?.(prompt);
            lastEchoedPrompt = prompt;
          }

          const autoResult = await this.queryWithCompact(project.slug, prompt, {
            cwd: project.directory,
            systemPrompt: PROJECT_SYSTEM_PROMPT,
            model: this.config.autoDecideModel,
            onMessage,
            onToolUse,
          });

          // Track single-message turns (1 message, no tools = probably not doing much)
          if (autoResult.messages.length <= 1 && autoResult.toolsUsed.length === 0) {
            singleMessageStreak++;
          } else {
            singleMessageStreak = 0;
          }

          if (autoResult.contextUsedPct != null) lastLoopContextPct = autoResult.contextUsedPct;
          project.status = `Operational with auto-decision on "${summary}" at ${formatTimestamp()}`;
          project.decision = null;
          await this.projectStore.save(project);

          for (const msg of autoResult.messages) {
            const cleaned = stripJson(msg);
            if (cleaned) displayMessages.push(cleaned);
          }
          if (autoResult.messages.length === 0) {
            displayMessages.push(stripJson(autoResult.text) || autoResult.text);
          }

          // Check if the auto-decide response also has a rating 0 decision
          const nextDecision = await this.enforceJsonEnvelope(
            project,
            autoResult.messages[autoResult.messages.length - 1] ?? autoResult.text,
            displayMessages,
            { model: this.config.autoDecideModel },
            onMessage, onToolUse, onFinalPrompt,
          );

          // If Claude is waiting for anything, bump to rating 10
          if (nextDecision) {
            const nextLower = nextDecision.summary.toLowerCase();
            if (nextLower.includes('waiting for') || nextLower.includes('waiting on')) {
              console.log(`[CommandRouter] ${project.slug}: bumped auto-decide rating ${nextDecision.rating}→10 (waiting: "${nextDecision.summary.slice(0, 60)}")`);
              nextDecision.rating = 10;
            }

            // Single message + no tools = didn't do real work
            if (autoResult.messages.length <= 1 && autoResult.toolsUsed.length === 0 && nextDecision.rating < 10) {
              console.log(`[CommandRouter] ${project.slug}: bumped auto-decide rating ${nextDecision.rating}→10 (single message, no tools)`);
              nextDecision.rating = 10;
            }

            // Auto-commit: if Claude asks "should I commit", just say yes
            if (nextLower.includes('should') && nextLower.includes('commit')) {
              console.log(`[CommandRouter] ${project.slug}: auto-answering commit question with yes`);
              nextDecision.rating = 0;
              nextDecision.summary = 'Yes, commit.';
            }
          }

          // Question-shaped auto-decides: re-prompt for pros/cons (helper at runProsCons).
          // NO_CONS → rating 0 (loop continues); cons exist → rating stays, defers to user.
          if (nextDecision) {
            const updated = await this.runProsCons(project, nextDecision.summary, nextDecision.rating, onMessage, onToolUse, onFinalPrompt);
            nextDecision.summary = updated.summary;
            nextDecision.rating = updated.rating;
          }

          if (!nextDecision || nextDecision.recovered || ratingToHours(nextDecision.rating) > 0) {
            // Not rating 0, or the rating-0 decision only came back after a reprompt (session
            // already under strain) — break the loop rather than licensing another lap.
            if (nextDecision) {
              const nextDeadline = calculateDeadline(nextDecision.rating);
              const dl = formatTimestamp(nextDeadline);
              project.status = `Awaiting decision regarding ${nextDecision.summary}. Auto-decides at ${dl}.`;
              project.decision = {
                summary: nextDecision.summary,
                rating: nextDecision.rating,
                deadline: nextDeadline.toISOString(),
                pausedRemaining: null,
              };
              await this.projectStore.save(project);
              const autoDecideText = nextDecision.rating >= 10 ? '' : ` — auto-decides at ${dl}`;
              const innerNotice = `⏳ **Decision needed (rating ${nextDecision.rating}):** ${safeBacktickWrap(nextDecision.summary)}${autoDecideText}`;
              decisionSuffix = `\n\n${innerNotice}`;
              onMessage?.(innerNotice);
            }
            break;
          }
          // Rating 0 again — check for spinning (same summary repeating)
          if (nextDecision.summary === lastSummary) {
            repeatCount++;
            if (repeatCount >= MAX_REPEAT_SUMMARIES) {
              const stallNotice = `⏸️ **Stalled:** ${safeBacktickWrap(nextDecision.summary)} repeated ${repeatCount} times — needs human input.`;
              onMessage?.(stallNotice);
              // Set as rating 1 so it doesn't auto-decide immediately
              const stallDeadline = calculateDeadline(1);
              const dl = formatTimestamp(stallDeadline);
              project.status = `Stalled on "${nextDecision.summary}". Auto-decides at ${dl}.`;
              project.decision = {
                summary: nextDecision.summary,
                rating: 1,
                deadline: stallDeadline.toISOString(),
                pausedRemaining: null,
              };
              await this.projectStore.save(project);
              break;
            }
          } else {
            repeatCount = 1;
          }
          lastSummary = nextDecision.summary;
          summary = nextDecision.summary;
        }

        if (autoCount >= MAX_AUTO_DECIDES) {
          const killNotice = `🛑 **Kill switch activated:** ${MAX_AUTO_DECIDES} consecutive auto-decides. Pausing project.`;
          onMessage?.(killNotice);
          project.status = `Paused: kill switch after ${MAX_AUTO_DECIDES} auto-decides at ${formatTimestamp()}`;
          project.decision = null;
          await this.projectStore.save(project);
        }

        // Refresh timestamp and context% to reflect when the loop actually finished
        project.lastConversationAt = new Date().toISOString();
        if (lastLoopContextPct != null) project.contextUsedPct = lastLoopContextPct;
        await this.projectStore.save(project);

        const response = displayMessages.join('\n\n') + decisionSuffix;
        return { response, projectSlug: project.slug };
      }

      const deadline = calculateDeadline(rating);
      const dl = formatTimestamp(deadline);
      project.status = `Awaiting decision regarding ${summary}. Auto-decides at ${dl}.`;
      project.decision = {
        summary,
        rating,
        deadline: deadline.toISOString(),
        pausedRemaining: null,
      };
      await this.projectStore.save(project);
      const autoDecideText = rating >= 10 ? '' : ` — auto-decides at ${dl}`;
      const decisionNotice = `⏳ **Decision needed (rating ${rating}):** ${safeBacktickWrap(summary)}${autoDecideText}`;
      decisionSuffix = `\n\n${decisionNotice}`;
      onMessage?.(decisionNotice);
    } else {
      // No JSON decision found — update status to reflect interaction
      project.status = `Operational at ${formatTimestamp()}`;
      await this.projectStore.save(project);
    }

    const response = displayMessages.join('\n\n') + decisionSuffix;
    return { response, projectSlug: project.slug };
  }

  /** Passthrough so cron.ts can force-stop a slug's in-flight turn without reaching into SessionManager directly. */
  stopSlug(slug: string): { stopped: boolean; reason: string } {
    return this.sessionManager.stop(slug);
  }

  /** Passthrough so cron.ts's quiet-window watcher can check for zero in-flight turns
   *  without reaching into SessionManager directly. */
  anySessionRunning(): boolean {
    return this.sessionManager.anyRunning();
  }

  async autoDecide(
    project: ProjectConfig,
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
    onFinalPrompt?: (text: string) => void,
  ): Promise<string> {
    onFinalPrompt?.(AUTO_DECIDE_PROMPT);
    const result = await this.queryWithCompact(project.slug, AUTO_DECIDE_PROMPT, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      onMessage,
      onToolUse,
    });

    const responseText = stripJson(result.text);

    const decidedSummary = project.decision?.summary ?? 'unknown';
    project.status = `Operational with auto-decision on "${decidedSummary}" at ${formatTimestamp()}`;
    project.decision = null;
    project.lastConversationAt = new Date().toISOString();
    if (result.contextUsedPct != null) project.contextUsedPct = result.contextUsedPct;
    if (result.sessionId) project.sessionId = result.sessionId;
    await this.projectStore.save(project);

    return `⚡ **[${project.title}] Auto-decided:** \`${decidedSummary}\`\n\n${responseText}`;
  }

  async cleanupDecisions(project: ProjectConfig): Promise<void> {
    const decisionsPath = path.join(project.directory, '.saint-expeditus', 'PROJECT_DECISIONS.md');
    try {
      await fs.access(decisionsPath);
    } catch {
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cleanup timed out after 5 minutes')), 5 * 60 * 1000);
    });
    try {
      await Promise.race([
        this.queryWithCompact(project.slug,
          'Review and refactor .saint-expeditus/PROJECT_DECISIONS.md. Remove irrelevant/outdated info, compress for context efficiency. Keep active decisions.',
          { cwd: project.directory, systemPrompt: PROJECT_SYSTEM_PROMPT },
        ).finally(() => clearTimeout(timer!)),
        timeout,
      ]);
    } catch (err) {
      console.error(`[CommandRouter] ${project.slug}: cleanup timed out`);
    }
  }

  /** Proactively compact a project session if context usage is high and it's been idle */
  async proactiveCompact(project: ProjectConfig, idleMinutes = COMPACT_IDLE_MINUTES, usageThreshold = COMPACT_THRESHOLD_PCT): Promise<string | null> {
    if (project.contextUsedPct == null) return null;
    if (project.contextUsedPct < usageThreshold) return null;
    if (!project.sessionId) return null;

    // Check idle time — skip if unknown (conservative)
    if (!project.lastConversationAt) return null;
    const idleMs = Date.now() - new Date(project.lastConversationAt).getTime();
    if (idleMs < idleMinutes * 60_000) return null;

    const beforePct = project.contextUsedPct;
    console.log(`[CommandRouter] ${project.slug}: proactive compact (context ${beforePct}% used, idle)`);

    await this.sessionManager.query(project.slug, '/compact', {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
    });

    // Follow-up to get a fresh context reading (compact result event may lack usage)
    const check = await this.sessionManager.query(project.slug, 'Acknowledge.', {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      maxTurns: 1,
    });
    const afterPct = check.contextUsedPct ?? null;
    if (afterPct != null) project.contextUsedPct = afterPct;
    if (check.sessionId) project.sessionId = check.sessionId;
    // Always update lastConversationAt so idle timer resets (prevents re-compact on next tick)
    project.lastConversationAt = new Date().toISOString();
    await this.projectStore.save(project);

    if (afterPct != null && afterPct >= beforePct) {
      console.log(`[CommandRouter] ${project.slug}: compact did not reduce context (${beforePct}% → ${afterPct}%)`);
      return null;
    }
    return `🗜️ **[${project.title}]** Proactive compact: ${beforePct}% → ${afterPct ?? '?'}%`;
  }

  /**
   * If the decision summary ends with '?' and would otherwise defer to the user
   * (rating > 0), fetch pros/cons from Claude and surface them. On the NO_CONS
   * marker, return a rewritten summary and rating 0 so the caller's auto-yes
   * path picks it up. Otherwise return the input unchanged.
   */
  private async runProsCons(
    project: ProjectConfig,
    summary: string,
    rating: number,
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
    onFinalPrompt?: (text: string) => void,
  ): Promise<{ summary: string; rating: number }> {
    // Any '?' anywhere in the summary means Claude is asking something — trigger pros/cons.
    // (Was endsWith('?'), which missed questions that trail off, e.g. "…do X or Y? I lean X.")
    if (!summary.includes('?')) return { summary, rating };
    if (ratingToHours(rating) === 0) return { summary, rating };

    console.log(`[CommandRouter] ${project.slug}: question-shaped decision — fetching pros/cons for "${summary.slice(0, 60)}"`);
    // Header up front; the body streams from Claude into Discord via onMessage during the
    // queryWithCompact call below. We do NOT re-emit the body afterwards (used to, which
    // caused the body + TLDR to appear twice).
    onMessage?.(`💭 **Pros/Cons** for \`${summary}\``);
    const prosConsPrompt =
      `Re: "${summary}"\n\n` +
      `Why are you asking me? Are there real cons to this approach? If not, your entire response must be the literal token NO_CONS on its own line — nothing else.\n\n` +
      `Before answering, investigate the relevant code/files/config/runtime state with Read, Bash, Grep, Glob — or spawn subagents in parallel for separate areas. Cons must be grounded in evidence you actually checked. No speculation.\n\n` +
      `If there ARE cons, list pros and cons. Format strictly:\n\n` +
      `PROS:\n- ...\n\n` +
      `CONS:\n- ...\n\n` +
      `Be concise — one short line per item. Do NOT include a JSON decision block in this response.` +
      SUBAGENT_HINT;
    // Echo the bridge-assembled re-prompt back to the user (same channel as the initial
    // prompt echo) so the pros/cons framing isn't a black box.
    onFinalPrompt?.(prosConsPrompt);
    const prosCons = await this.queryWithCompact(project.slug, prosConsPrompt, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      model: this.config.autoDecideModel,
      onMessage,
      onToolUse,
    });
    const prosConsText = stripJson(prosCons.text) || prosCons.text;
    if (/^\s*NO_CONS\s*$/m.test(prosConsText)) {
      console.log(`[CommandRouter] ${project.slug}: NO_CONS detected — auto-yes on "${summary.slice(0, 60)}"`);
      return { summary: `Auto-yes (no cons): ${summary}`, rating: 0 };
    }
    // Real cons were raised — don't leave the human to ask the obvious follow-up themselves
    // every time. Auto-reprompt once for a concrete recommendation; it streams to the user
    // via onMessage the same way the pros/cons body did.
    console.log(`[CommandRouter] ${project.slug}: cons found — asking "Then what do you suggest?"`);
    const suggestPrompt = `Then what do you suggest?${SUBAGENT_HINT}`;
    onFinalPrompt?.(suggestPrompt);
    const suggestion = await this.queryWithCompact(project.slug, suggestPrompt, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      model: this.config.autoDecideModel,
      onMessage,
      onToolUse,
    });
    // BUG (found 2026-08-05, live on aura-primera-villa): the suggestion turn almost always
    // ends its own {tldr, decision} envelope with a refined, re-framed decision (e.g. "build a
    // table instead of a heatmap") — discarding it and returning the ORIGINAL summary/rating
    // left the persisted decision stuck asking the stale pre-suggestion question forever, even
    // though the conversation had already moved past it. Prefer the suggestion's own decision
    // when it parsed one; only fall back to the original if it didn't.
    const suggestedDecision = extractDecision(suggestion.text);
    if (suggestedDecision) {
      console.log(`[CommandRouter] ${project.slug}: suggestion produced a refined decision — using it`);
      return suggestedDecision;
    }
    return { summary, rating };
  }

  /**
   * Guarantee a {tldr, other_findings, assumptions_made, decision, rating} JSON envelope was attempted for
   * `decisionSource`. If
   * `extractDecision` found nothing and the text isn't one of the documented JSON-free
   * exemptions (NO_CONS / PROS-CONS), reprompt once asking Claude to resend in the required
   * format and to remember it going forward. Appends whatever the retry says to
   * `displayMessages` (same convention as the rest of runTurn/autoDecide). Gives up after one
   * retry — falls back to returning null (today's "no decision found" behavior) rather than
   * looping.
   *
   * A decision recovered via the reprompt is flagged `recovered: true`. Callers inside the
   * auto-decide while-loop must treat a recovered rating-0 decision as a reason to BREAK the
   * loop rather than continue it — a session that needed reprompting to produce valid JSON is
   * already showing strain, and every reprompt costs an extra full query. Left unflagged, a
   * repeatedly-reprompted rating-0 decision doubles the loop's context growth per iteration and
   * can blow past a safe context budget well before the MAX_AUTO_DECIDES kill switch trips
   * (confirmed live 2026-07-30: 7 reprompts over ~9 iterations, ctx 53%→111%).
   */
  private async enforceJsonEnvelope(
    project: ProjectConfig,
    decisionSource: string,
    displayMessages: string[],
    queryOpts: { provider?: 'claude' | 'gemini'; model?: string },
    onMessage?: (text: string) => void,
    onToolUse?: (name: string, detail: string) => void,
    onFinalPrompt?: (text: string) => void,
  ): Promise<{ summary: string; rating: number; recovered?: boolean } | null> {
    const decision = extractDecision(decisionSource);
    if (decision || isJsonEnvelopeExempt(decisionSource)) return decision;

    console.log(`[CommandRouter] ${project.slug}: response had no JSON envelope — reprompting once`);
    onFinalPrompt?.(MISSING_JSON_ENVELOPE_REPROMPT);
    const retry = await this.queryWithCompact(project.slug, MISSING_JSON_ENVELOPE_REPROMPT, {
      cwd: project.directory,
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      ...queryOpts,
      onMessage,
      onToolUse,
    });

    for (const msg of retry.messages) {
      const cleaned = stripJson(msg);
      if (cleaned) displayMessages.push(cleaned);
    }
    if (retry.messages.length === 0) {
      displayMessages.push(stripJson(retry.text) || retry.text);
    }

    const retrySource = retry.messages[retry.messages.length - 1] ?? retry.text;
    const retryDecision = extractDecision(retrySource);
    if (!retryDecision) {
      console.log(`[CommandRouter] ${project.slug}: still no JSON envelope after reprompt — giving up, passing raw text through`);
      return null;
    }
    return { ...retryDecision, recovered: true };
  }

  /** Run a query, compacting the session and retrying once if the prompt is too long. */
  private async queryWithCompact(
    slug: string,
    prompt: string,
    opts: Parameters<SessionManager['query']>[2],
  ): Promise<Awaited<ReturnType<SessionManager['query']>>> {
    let result = await this.sessionManager.query(slug, prompt, opts);
    if (result.text.toLowerCase().includes(PROMPT_TOO_LONG_MARKER)) {
      console.log(`[CommandRouter] ${slug}: prompt too long, compacting session and retrying`);
      opts.onMessage?.('🔄 Session context too long — compacting and retrying...');
      await this.sessionManager.query(slug, '/compact', { cwd: opts.cwd, systemPrompt: opts.systemPrompt, provider: opts.provider });
      result = await this.sessionManager.query(slug, prompt, opts);
    }
    return result;
  }

  private async readMemoryFiles(): Promise<string> {
    const parts: string[] = ['=== YOUR MEMORY ==='];
    for (const file of MEMORY_FILES) {
      try {
        const content = await fs.readFile(path.join(this.config.memoryDir, file), 'utf-8');
        parts.push(`\n--- ${file} ---\n${content}`);
      } catch {
        parts.push(`\n--- ${file} ---\n(empty)`);
      }
    }
    return parts.join('\n');
  }

  /** For /register and /update — separate sessions, no subdivision bot personality */
  private async querySession(slug: string, prompt: string, onMessage?: (text: string) => void, onToolUse?: (name: string, detail: string) => void) {
    return this.sessionManager.query(slug, prompt, {
      cwd: path.resolve(this.config.memoryDir, '..'),
      systemPrompt: 'You are a project management assistant. Help the user register and manage dev projects. Be concise and direct. Respond in English.',
      allowedTools: ['Bash', 'Glob', 'Read', 'Write'],
      onMessage,
      onToolUse,
    });
  }
}
