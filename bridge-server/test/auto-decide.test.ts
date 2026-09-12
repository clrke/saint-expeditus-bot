import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandRouter } from '../src/command-router.js';
import { ProjectStore } from '../src/project-store.js';
import type { SessionManager, QueryResult } from '../src/session-manager.js';
import type { Config } from '../src/config.js';
import type { AskPayload } from '../../shared/types.js';

function makeConfig(tmpDir: string): Config {
  return {
    port: 3141,
    model: 'haiku',
    memoryDir: tmpDir,
    systemDir: tmpDir,
    promptFile: path.join(tmpDir, 'prompt.md'),
    maxToolRounds: 5,
    requestTimeoutMs: 180000,
    maxContextMessages: 30,
    maxRequestsPerMinute: 60,
    retryAttempts: 2,
    retryDelayMs: 1000,
    projectsDir: path.join(tmpDir, '.projects'),
    sessionLimit: 0,
    sessionLimitHours: 12,
    defaultProvider: 'claude',
    autoDecideModel: undefined,
  };
}

function makePayload(slug: string, args = 'do something'): AskPayload {
  return {
    trigger: {
      sender: 'Test',
      query: args,
      type: 'inline',
      replyTo: null,
      originalMessage: `/${slug} ${args}`,
    },
    recentMessages: [],
    repliedToMessage: null,
  };
}

/** Build a QueryResult — use toolsUsed to allow auto-decide (single msg + no tools → rating 10) */
function makeQueryResult(message: string, rating: number, summary: string, toolsUsed: string[] = []): QueryResult {
  const json = JSON.stringify({ tldr: message, decision: { summary, rating } });
  return {
    text: json,
    messages: [json],
    toolsUsed,
    sessionId: 'test-session',
    costUsd: 0,
    contextUsedPct: null,
  };
}

/** Shortcut: result with tools (allows auto-decide) */
function makeWorkResult(message: string, rating: number, summary: string): QueryResult {
  return makeQueryResult(message, rating, summary, ['Read', 'Edit']);
}

/** Stub SessionManager with no-op methods — use when session queries aren't under test */
function makeNoopSM(): SessionManager {
  return {
    query: vi.fn(),
    resetSession: vi.fn(),
    loadSession: vi.fn(),
    getSessionId: vi.fn(),
    discoverSession: vi.fn(),
  } as unknown as SessionManager;
}

/** Stub SessionManager with a custom query implementation */
function makeSmWithQuery(queryImpl: SessionManager['query']): SessionManager {
  return {
    query: vi.fn(queryImpl),
    resetSession: vi.fn(),
    loadSession: vi.fn(),
    getSessionId: vi.fn().mockReturnValue(undefined),
    discoverSession: vi.fn().mockResolvedValue(null),
  } as unknown as SessionManager;
}

/** Build a payload for a global command (no args, query: null) */
function makeCommand(command: string): AskPayload {
  return {
    trigger: { type: 'inline', query: null, sender: 'Test', replyTo: null, originalMessage: `/${command}` },
    recentMessages: [],
    repliedToMessage: null,
  };
}

describe('Auto-decide nudge', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;
  let sessionManager: SessionManager;
  let queryCalls: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-decide-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test prompt');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();

    await projectStore.create({
      title: 'Test Project',
      slug: 'test',
      description: 'test',
      directory: tmpDir,
      autoDecide: true,
    });

    queryCalls = [];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  function mockSessionManager(responses: QueryResult[]): SessionManager {
    let callIndex = 0;
    return {
      query: vi.fn(async (slug: string, prompt: string) => {
        queryCalls.push(prompt);
        return responses[Math.min(callIndex++, responses.length - 1)];
      }),
      resetSession: vi.fn(),
      loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      discoverSession: vi.fn().mockResolvedValue(null),
    } as unknown as SessionManager;
  }

  it('bumps rating to 10 when initial response is single message with no tools', async () => {
    sessionManager = mockSessionManager([
      makeQueryResult('Just chatting', 0, 'continue'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    const { response } = await router.handle(makePayload('test'));

    // Should NOT auto-decide — rating bumped to 10
    const project = await projectStore.load('test');
    expect(project!.decision).not.toBeNull();
    expect(project!.decision!.rating).toBe(10);
    // Only 1 query call (no auto-decide loop)
    expect(queryCalls).toHaveLength(1);
  });

  it('allows auto-decide when initial response used tools', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Did real work', 0, 'continue'),
      makeWorkResult('More work', 5, 'review'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'));

    // Should enter auto-decide loop (2 query calls)
    expect(queryCalls.length).toBeGreaterThan(1);
  });

  it('uses normal prompt when initial response used tools', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Did real work', 0, 'continue'),
      makeWorkResult('Done', 5, 'review'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'));

    // Initial had tools → streak=0 → normal prompt
    expect(queryCalls[1]).toContain('Make an informed decision for me');
  });

  it('bumps to 10 inside auto-decide loop when response has no tools', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Work done', 0, 'next step'),
      makeQueryResult('Just chatting', 0, 'continue'), // no tools → rating 10
    ]);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'));

    const project = await projectStore.load('test');
    expect(project!.decision).not.toBeNull();
    expect(project!.decision!.rating).toBe(10);
  });

  it('resets streak when Claude uses tools', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Start', 0, 'step 1'),
      makeWorkResult('Step 1', 0, 'step 2'),
      makeWorkResult('Done', 5, 'review'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'));

    // All had tools → normal prompt throughout
    expect(queryCalls[1]).toContain('Make an informed decision for me');
    expect(queryCalls[2]).toContain('Make an informed decision for me');
  });

  it('breaks out of loop when same summary repeats 2 times', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Start', 0, 'same thing'),
      makeWorkResult('Again', 0, 'same thing'),
      makeWorkResult('Again', 0, 'same thing'),
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'), (text) => onMessageTexts.push(text));

    expect(onMessageTexts.some(t => t.includes('Stalled'))).toBe(true);

    const project = await projectStore.load('test');
    expect(project!.decision).not.toBeNull();
    expect(project!.decision!.rating).toBe(1);
  });

  it('auto-decide notices are NOT in displayMessages (no double-send)', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Work done', 0, 'continue'),
      makeWorkResult('More work', 5, 'review'),
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    const { response } = await router.handle(
      makePayload('test'),
      (text) => onMessageTexts.push(text),
    );

    expect(onMessageTexts.some(t => t.includes('⚡ **Auto-decided'))).toBe(true);
    expect(response).not.toContain('⚡ **Auto-decided');
  });

  it('kill switch notice is NOT in displayMessages', async () => {
    const responses = Array.from({ length: 31 }, (_, i) =>
      makeWorkResult(`Step ${i}`, 0, `task ${i}`)
    );
    sessionManager = mockSessionManager(responses);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    const { response } = await router.handle(
      makePayload('test'),
      (text) => onMessageTexts.push(text),
    );

    expect(onMessageTexts.some(t => t.includes('🛑 **Kill switch'))).toBe(true);
    expect(response).not.toContain('🛑 **Kill switch');
  });

  it('kill switch pauses project and clears decision', async () => {
    const responses = Array.from({ length: 31 }, (_, i) =>
      makeWorkResult(`Step ${i}`, 0, `task ${i}`)
    );
    sessionManager = mockSessionManager(responses);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'));

    const project = await projectStore.load('test');
    expect(project!.status).toMatch(/^Paused: kill switch after 30/);
    expect(project!.decision).toBeNull();
  });

  it('stall notice is NOT in displayMessages', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Start', 0, 'same thing'),
      makeWorkResult('Again', 0, 'same thing'),
      makeWorkResult('Again', 0, 'same thing'),
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    const { response } = await router.handle(
      makePayload('test'),
      (text) => onMessageTexts.push(text),
    );

    expect(onMessageTexts.some(t => t.includes('⏸️ **Stalled'))).toBe(true);
    expect(response).not.toContain('⏸️ **Stalled');
  });

  it('bumps rating 10 when summary contains "waiting for"', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Need input', 3, 'waiting for chlorine reading'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'));

    const project = await projectStore.load('test');
    expect(project!.decision!.rating).toBe(10);
  });

  it('bumps rating 10 when summary contains "waiting on"', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Need input', 2, 'waiting on user input'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'));

    const project = await projectStore.load('test');
    expect(project!.decision!.rating).toBe(10);
  });

  it('auto-commits when summary contains "should" + "commit"', async () => {
    sessionManager = mockSessionManager([
      makeWorkResult('Changes ready', 3, 'should I commit these changes?'),
      makeWorkResult('Committed', 5, 'review results'),
    ]);

    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'));

    // Should have auto-decided with "Yes, commit."
    expect(queryCalls[1]).toContain('Make an informed decision for me');
  });

  it('nudges immediately when Claude returns a stall phrase like "All tasks complete."', async () => {
    const stallResponse: QueryResult = {
      text: JSON.stringify({ tldr: 'All tasks complete.', decision: { summary: 'done', rating: 5 } }),
      messages: [JSON.stringify({ tldr: 'All tasks complete.', decision: { summary: 'done', rating: 5 } })],
      toolsUsed: ['Read'],
      sessionId: 'test-session',
      costUsd: 0,
    };
    sessionManager = mockSessionManager([
      stallResponse,
      makeWorkResult('Found new tasks', 5, 'review'),
    ]);

    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'), (text) => onMessageTexts.push(text));

    // Should send nudge notice
    expect(onMessageTexts.some(t => t.includes('Nudging'))).toBe(true);
    // Should issue a second query with the nudge prompt
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[1]).toContain('Make an informed decision for me');
  });

  it('skips nudge on stall when vacation mode is active', async () => {
    const stallResponse: QueryResult = {
      text: JSON.stringify({ tldr: 'All tasks complete.', decision: { summary: 'done', rating: 5 } }),
      messages: [JSON.stringify({ tldr: 'All tasks complete.', decision: { summary: 'done', rating: 5 } })],
      toolsUsed: ['Read'],
      sessionId: 'test-session',
      costUsd: 0,
    };
    sessionManager = mockSessionManager([stallResponse]);

    await projectStore.setVacation(true);
    const onMessageTexts: string[] = [];
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test'), (text) => onMessageTexts.push(text));

    // Should NOT nudge on vacation
    expect(onMessageTexts.some(t => t.includes('Nudging'))).toBe(false);
    expect(queryCalls).toHaveLength(1);
    await projectStore.setVacation(false);
  });

  it('cron autoDecide uses the standard prompt', async () => {
    const project = await projectStore.load('test');
    project!.decision = { summary: 'pending task', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    sessionManager = mockSessionManager([makeWorkResult('Auto-decided the thing', 5, 'next step')]);
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.autoDecide(project!);

    expect(queryCalls[0]).toContain('Make an informed decision for me');
  });

  it('autoDecide clears decision and updates project status', async () => {
    const project = await projectStore.load('test');
    project!.decision = { summary: 'pending task', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'next step')]);
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    const result = await router.autoDecide(project!);

    const saved = await projectStore.load('test');
    expect(saved!.decision).toBeNull();
    expect(saved!.status).toContain('auto-decision on "pending task"');
    expect(result).toContain('⚡');
    expect(result).toContain('pending task');
  });

  it('autoDecide updates lastConversationAt so staleness hint resets', async () => {
    const project = await projectStore.load('test');
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    project!.lastConversationAt = staleDate;
    project!.decision = { summary: 'task', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'next step')]);
    const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
    await router.autoDecide(project!);

    const saved = await projectStore.load('test');
    const updatedAt = new Date(saved!.lastConversationAt!).getTime();
    expect(updatedAt).toBeGreaterThan(new Date(staleDate).getTime());
    // Should be within the last 5 seconds
    expect(Date.now() - updatedAt).toBeLessThan(5000);
  });

  describe('staleness hint', () => {
    it('appends hours hint when project was idle for 2 hours', async () => {
      const project = await projectStore.load('test');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      project!.lastConversationAt = twoHoursAgo;
      await projectStore.save(project!);

      sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'review')]);
      const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
      await router.handle(makePayload('test', 'check status'));

      expect(queryCalls[0]).toContain("It's been 2 hours since we last spoke.");
    });

    it('appends days hint when project was idle for 25 hours', async () => {
      const project = await projectStore.load('test');
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      project!.lastConversationAt = twentyFiveHoursAgo;
      await projectStore.save(project!);

      sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'review')]);
      const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
      await router.handle(makePayload('test', 'check status'));

      expect(queryCalls[0]).toContain("It's been 1 day since we last spoke.");
    });

    it('omits hint when project was idle for only 30 minutes', async () => {
      const project = await projectStore.load('test');
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      project!.lastConversationAt = thirtyMinsAgo;
      await projectStore.save(project!);

      sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'review')]);
      const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
      await router.handle(makePayload('test', 'check status'));

      expect(queryCalls[0]).not.toContain("since we last spoke");
    });

    it('omits hint when lastConversationAt is not set', async () => {
      sessionManager = mockSessionManager([makeWorkResult('Done', 5, 'review')]);
      const router = new CommandRouter(sessionManager, projectStore, makeConfig(tmpDir));
      await router.handle(makePayload('test', 'check status'));

      expect(queryCalls[0]).not.toContain("since we last spoke");
    });
  });
});

describe('Vacation mode', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vacation-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test prompt');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
    await projectStore.create({ title: 'Beta', slug: 'beta', description: 'b', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  function makeRouter() {
    const sm = makeNoopSM();
    return new CommandRouter(sm, projectStore, makeConfig(tmpDir));
  }

  it('pauses auto-decide deadlines on vacation', async () => {
    const alpha = await projectStore.load('alpha');
    alpha!.decision = { summary: 'pending', rating: 5, deadline: new Date(Date.now() + 36 * 3600_000).toISOString(), pausedRemaining: null };
    await projectStore.save(alpha!);

    const router = makeRouter();
    const { response } = await router.handle(makeCommand('vacation'));
    expect(response).toContain('Vacation mode ON');

    const saved = await projectStore.load('alpha');
    expect(saved!.decision!.deadline).toBe('');
    expect(saved!.decision!.pausedRemaining).toBeGreaterThan(0);
  });

  it('returns early if already on vacation', async () => {
    const router = makeRouter();
    await router.handle(makeCommand('vacation'));
    const { response } = await router.handle(makeCommand('vacation'));
    expect(response).toContain('Already on vacation');
  });

  it('restores deadlines on unvacation', async () => {
    const alpha = await projectStore.load('alpha');
    alpha!.decision = { summary: 'pending', rating: 3, deadline: new Date(Date.now() + 5 * 3600_000).toISOString(), pausedRemaining: null };
    await projectStore.save(alpha!);

    const router = makeRouter();
    await router.handle(makeCommand('vacation'));
    await router.handle(makeCommand('unvacation'));

    const restored = await projectStore.load('alpha');
    expect(restored!.decision!.deadline).not.toBe('');
    expect(restored!.decision!.pausedRemaining).toBeNull();
  });

  it('returns early if not on vacation', async () => {
    const router = makeRouter();
    const { response } = await router.handle(makeCommand('unvacation'));
    expect(response).toContain('Not in vacation mode');
  });
});

describe('Register', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'register-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test prompt');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('returns clear error when REGISTER payload is malformed JSON', async () => {
    const sm = {
      query: vi.fn().mockResolvedValue({ text: 'REGISTER::{bad json}', messages: [], toolsUsed: [], sessionId: '', costUsd: 0 }),
      resetSession: vi.fn(), loadSession: vi.fn(), getSessionId: vi.fn(), discoverSession: vi.fn(),
    } as unknown as SessionManager;
    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const { response } = await router.handle({ trigger: { type: 'inline', query: 'register my project', sender: 'Test', replyTo: null, originalMessage: '/register my project' }, recentMessages: [], repliedToMessage: null });
    expect(response).toContain('Registration failed');
    expect(response).not.toContain('{bad json}');
  });
});

describe('handleList', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'list-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  function makeRouter() {
    const sm = makeNoopSM();
    return new CommandRouter(sm, projectStore, makeConfig(tmpDir));
  }

  it('returns no-projects message when empty', async () => {
    const { response } = await makeRouter().handle(makeCommand('list'));
    expect(response).toContain('No projects registered');
  });

  it('lists all projects with status', async () => {
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
    await projectStore.create({ title: 'Beta', slug: 'beta', description: 'b', directory: tmpDir, autoDecide: false });
    const { response } = await makeRouter().handle(makeCommand('list'));
    expect(response).toContain('Alpha');
    expect(response).toContain('Beta');
  });

  it('shows ⏳ decision summary with countdown for auto-decidable ratings', async () => {
    const proj = await projectStore.create({ title: 'Test', slug: 'test', description: 'x', directory: tmpDir, autoDecide: true });
    proj.decision = {
      summary: 'pick a framework',
      rating: 5,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(), // 3h from now
      pausedRemaining: null,
    };
    await projectStore.save(proj);
    const { response } = await makeRouter().handle(makeCommand('list'));
    expect(response).toContain('⏳');
    expect(response).toContain('pick a framework');
    expect(response).toMatch(/in \d+h/); // countdown
  });

  it('shows "waiting for you" for rating-10 decisions (no auto-decide)', async () => {
    const proj = await projectStore.create({ title: 'Test', slug: 'test', description: 'x', directory: tmpDir, autoDecide: true });
    proj.decision = {
      summary: 'critical decision',
      rating: 10,
      deadline: '9999-12-31T23:59:59Z',
      pausedRemaining: null,
    };
    await projectStore.save(proj);
    const { response } = await makeRouter().handle(makeCommand('list'));
    expect(response).toContain('⏳');
    expect(response).toContain('critical decision');
    expect(response).toContain('waiting for you');
    expect(response).not.toMatch(/in \d+[hmd]/); // no countdown for rating 10
  });
});

describe('handleReset', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('resets session and clears decision', async () => {
    const alpha = await projectStore.load('alpha');
    alpha!.decision = { summary: 'pending', rating: 3, deadline: new Date().toISOString(), pausedRemaining: null };
    alpha!.sessionId = 'old-session-id';
    await projectStore.save(alpha!);

    const resetSession = vi.fn();
    const sm = { query: vi.fn(), resetSession, loadSession: vi.fn(), getSessionId: vi.fn(), discoverSession: vi.fn() } as unknown as SessionManager;
    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const { response } = await router.handle({ trigger: { type: 'inline', query: 'alpha', sender: 'Test', replyTo: null, originalMessage: '/reset alpha' }, recentMessages: [], repliedToMessage: null });

    expect(response).toContain('Reset session');
    expect(resetSession).toHaveBeenCalledWith('alpha');
    const saved = await projectStore.load('alpha');
    expect(saved!.decision).toBeNull();
    expect(saved!.sessionId).toBeNull();
  });

  it('returns error for unknown slug', async () => {
    const sm = makeNoopSM();
    const { response } = await new CommandRouter(sm, projectStore, makeConfig(tmpDir)).handle({ trigger: { type: 'inline', query: 'nope', sender: 'Test', replyTo: null, originalMessage: '/reset nope' }, recentMessages: [], repliedToMessage: null });
    expect(response).toContain('not found');
  });

  it('returns usage hint when no slug given', async () => {
    const sm = makeNoopSM();
    const { response } = await new CommandRouter(sm, projectStore, makeConfig(tmpDir)).handle({ trigger: { type: 'inline', query: '', sender: 'Test', replyTo: null, originalMessage: '/reset' }, recentMessages: [], repliedToMessage: null });
    expect(response).toContain('Usage');
  });
});

describe('handleAutoDecideExtend', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extend-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  function makeRouter() {
    const sm = makeNoopSM();
    return new CommandRouter(sm, projectStore, makeConfig(tmpDir));
  }

  it('returns no-projects message when none have decisions', async () => {
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
    const { response } = await makeRouter().handle(makeCommand('auto-decide-extend'));
    expect(response).toContain('No projects have pending decisions');
  });

  it('extends deadline when exactly one project has a decision', async () => {
    await projectStore.create({ title: 'Alpha', slug: 'alpha', description: 'a', directory: tmpDir, autoDecide: true });
    const alpha = await projectStore.load('alpha');
    const originalDeadline = new Date(Date.now() + 2 * 3600_000).toISOString();
    alpha!.decision = { summary: 'pending', rating: 3, deadline: originalDeadline, pausedRemaining: null };
    await projectStore.save(alpha!);

    const { response } = await makeRouter().handle(makeCommand('auto-decide-extend'));
    expect(response).toContain('Extended Alpha');

    const saved = await projectStore.load('alpha');
    expect(new Date(saved!.decision!.deadline) > new Date(originalDeadline)).toBe(true);
  });

  it('requires slug when multiple projects have decisions', async () => {
    for (const slug of ['alpha', 'beta']) {
      await projectStore.create({ title: slug, slug, description: '', directory: tmpDir, autoDecide: true });
      const p = await projectStore.load(slug);
      p!.decision = { summary: 'pending', rating: 3, deadline: new Date(Date.now() + 3600_000).toISOString(), pausedRemaining: null };
      await projectStore.save(p!);
    }
    const { response } = await makeRouter().handle(makeCommand('auto-decide-extend'));
    expect(response).toContain('Multiple projects');
  });

  it('returns not-found message for invalid slug when multiple projects have decisions', async () => {
    for (const slug of ['alpha', 'beta']) {
      await projectStore.create({ title: slug, slug, description: '', directory: tmpDir, autoDecide: true });
      const p = await projectStore.load(slug);
      p!.decision = { summary: 'pending', rating: 3, deadline: new Date(Date.now() + 3600_000).toISOString(), pausedRemaining: null };
      await projectStore.save(p!);
    }
    const payload: AskPayload = {
      trigger: { type: 'inline', query: 'gamma', sender: 'Test', replyTo: null, originalMessage: '/auto-decide-extend gamma' },
      recentMessages: [], repliedToMessage: null,
    };
    const { response } = await makeRouter().handle(payload);
    expect(response).toContain('not found');
  });
});

describe('handleDetails / handleInfo', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'details-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  function makeRouter() {
    return new CommandRouter(makeNoopSM(), projectStore, makeConfig(tmpDir));
  }

  it('returns "No projects" when none registered', async () => {
    const { response } = await makeRouter().handle(makeCommand('details'));
    expect(response).toContain('No projects registered.');
  });

  it('/info is an alias for /details', async () => {
    const r1 = await makeRouter().handle(makeCommand('details'));
    const r2 = await makeRouter().handle(makeCommand('info'));
    expect(r1.response).toBe(r2.response);
  });

  it('includes project fields in response', async () => {
    await projectStore.create({
      title: 'My Project',
      slug: 'myproj',
      description: 'A test project',
      directory: tmpDir,
      autoDecide: true,
    });

    const { response } = await makeRouter().handle(makeCommand('details'));
    expect(response).toContain('My Project');
    expect(response).toContain('/myproj');
    expect(response).toContain(tmpDir);
    expect(response).toContain('A test project');
  });

  it('includes decision info when project has pending decision', async () => {
    await projectStore.create({ title: 'Decide Me', slug: 'dm', description: '', directory: tmpDir, autoDecide: true });
    const p = await projectStore.load('dm');
    p!.decision = { summary: 'which DB', rating: 7, deadline: new Date(Date.now() + 7200_000).toISOString(), pausedRemaining: null };
    await projectStore.save(p!);

    const { response } = await makeRouter().handle(makeCommand('details'));
    expect(response).toContain('which DB');
    expect(response).toContain('rating: 7');
  });

  it('lists all projects with blank line separator', async () => {
    for (const slug of ['alpha', 'beta']) {
      await projectStore.create({ title: slug, slug, description: '', directory: tmpDir, autoDecide: true });
    }
    const { response } = await makeRouter().handle(makeCommand('details'));
    expect(response).toContain('alpha');
    expect(response).toContain('beta');
    expect(response).toContain('\n\n'); // sections separated by blank line
  });
});

describe('handleRegister happy path', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'register-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('creates project when session returns REGISTER:: payload', async () => {
    const sm = makeSmWithQuery(async () => ({
      text: `Sure! REGISTER::{"title":"Test","slug":"testproj","description":"A project","directory":"${tmpDir}"}`,
      messages: [],
      toolsUsed: [],
      sessionId: 'reg-session',
      costUsd: 0,
    }));

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const { response } = await router.handle({
      trigger: { type: 'inline', query: 'register my new project', sender: 'Test', replyTo: null, originalMessage: '/register register my new project' },
      recentMessages: [],
      repliedToMessage: null,
    });

    expect(response).toContain('Project registered!');
    expect(response).toContain('/testproj');

    const project = await projectStore.load('testproj');
    expect(project).not.toBeNull();
    expect(project!.title).toBe('Test');
    expect(project!.autoDecide).toBe(true);
  });

  it('returns session text verbatim when no REGISTER:: marker', async () => {
    const sm = makeSmWithQuery(async () => ({
      text: 'Please provide more details about your project.',
      messages: [],
      toolsUsed: [],
      sessionId: 'reg-session',
      costUsd: 0,
    }));

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const { response } = await router.handle(makeCommand('register'));
    expect(response).toBe('Please provide more details about your project.');
  });
});

describe('Provider prefix parsing', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Test', slug: 'test', description: '', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('passes gemini provider when args start with "gemini:"', async () => {
    const queryCalls: Array<{ slug: string; opts: Record<string, unknown> }> = [];
    const sm = makeSmWithQuery(async (slug, _prompt, opts) => {
      queryCalls.push({ slug, opts: opts as Record<string, unknown> });
      return makeWorkResult('done', 5, 'review');
    });

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test', 'gemini: summarize the repo'));

    expect(queryCalls[0].opts.provider).toBe('gemini');
  });

  it('strips provider prefix from the prompt', async () => {
    const prompts: string[] = [];
    const sm = makeSmWithQuery(async (_slug, prompt) => {
      prompts.push(prompt);
      return makeWorkResult('done', 5, 'review');
    });

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test', 'gemini: summarize the repo'));

    expect(prompts[0]).not.toContain('gemini:');
    expect(prompts[0]).toContain('summarize the repo');
  });

  it('defaults to config provider when no prefix', async () => {
    const queryCalls: Array<{ opts: Record<string, unknown> }> = [];
    const sm = makeSmWithQuery(async (_slug, _prompt, opts) => {
      queryCalls.push({ opts: opts as Record<string, unknown> });
      return makeWorkResult('done', 5, 'review');
    });

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test', 'do some work'));

    // Default from config is 'claude'
    expect(queryCalls[0].opts.provider).toBe('claude');
  });
});

describe('queryWithCompact retry', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Test', slug: 'test', description: '', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('retries with /compact when response contains "prompt is too long"', async () => {
    const prompts: string[] = [];
    const sm = makeSmWithQuery(async (_slug, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        // First call: prompt too long
        return { text: 'Error: prompt is too long', messages: [], toolsUsed: ['Read'], sessionId: 'x', costUsd: 0 };
      }
      if (prompt === '/compact') {
        return { text: 'Compacted.', messages: [], toolsUsed: [], sessionId: 'x', costUsd: 0 };
      }
      // Retry succeeds
      return makeWorkResult('done', 5, 'review');
    });

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const onMessageTexts: string[] = [];
    await router.handle(makePayload('test', 'do work'), (t) => onMessageTexts.push(t));

    // Should have called: original, /compact, retry
    expect(prompts).toContain('/compact');
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    expect(onMessageTexts.some(t => t.includes('compacting'))).toBe(true);
  });
});

describe('cleanupDecisions', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Test', slug: 'test', description: '', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('skips query when PROJECT_DECISIONS.md does not exist', async () => {
    const sm = makeNoopSM();
    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const project = (await projectStore.load('test'))!;

    await router.cleanupDecisions(project);

    expect(sm.query).not.toHaveBeenCalled();
  });

  it('calls queryWithCompact when PROJECT_DECISIONS.md exists', async () => {
    const decisionsDir = path.join(tmpDir, '.saint-expeditus');
    await fs.mkdir(decisionsDir, { recursive: true });
    await fs.writeFile(path.join(decisionsDir, 'PROJECT_DECISIONS.md'), '# Old decisions');

    const queriedPrompts: string[] = [];
    const sm: SessionManager = {
      query: vi.fn(async (_slug: string, prompt: string) => {
        queriedPrompts.push(prompt);
        return { text: '{"tldr":"cleaned","decision":{"summary":"done","rating":0}}', messages: [], toolsUsed: [], sessionId: 'x', costUsd: 0 };
      }),
      resetSession: vi.fn(),
      loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('x'),
      discoverSession: vi.fn().mockResolvedValue(null),
    } as unknown as SessionManager;

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const project = (await projectStore.load('test'))!;

    await router.cleanupDecisions(project);

    expect(queriedPrompts[0]).toContain('PROJECT_DECISIONS.md');
  });
});

describe('handleProject decision-clearing', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-clear-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), '');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Test', slug: 'test', description: '', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('clears decision and updates status when user replies while decision is pending', async () => {
    const project = await projectStore.load('test');
    project!.decision = { summary: 'pick a framework', rating: 7, deadline: new Date(Date.now() + 3600_000).toISOString(), pausedRemaining: null };
    await projectStore.save(project!);

    // Capture intermediate saves to verify the decision-clear save happened
    const savedSnapshots: Array<{ status: string; decision: unknown }> = [];
    const origSave = projectStore.save.bind(projectStore);
    vi.spyOn(projectStore, 'save').mockImplementation(async (p) => {
      savedSnapshots.push({ status: p.status, decision: p.decision });
      return origSave(p);
    });

    const sm: SessionManager = {
      query: vi.fn().mockResolvedValue(makeWorkResult('Done', 5, 'continue')),
      resetSession: vi.fn(),
      loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('s1'),
      discoverSession: vi.fn().mockResolvedValue(null),
    } as unknown as SessionManager;

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test', 'use React'));

    // First save should have cleared the decision and set "user response" status
    const clearSave = savedSnapshots.find(s => s.status.includes('user response'));
    expect(clearSave).toBeDefined();
    expect(clearSave!.decision).toBeNull();
    expect(clearSave!.status).toContain('use React');

    vi.restoreAllMocks();
  });

  it('does not mutate status when no decision is pending', async () => {
    const project = await projectStore.load('test');
    project!.status = 'Operational';
    project!.decision = null;
    await projectStore.save(project!);

    const sm: SessionManager = {
      query: vi.fn().mockResolvedValue(makeWorkResult('Done', 0, 'continue')),
      resetSession: vi.fn(),
      loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('s1'),
      discoverSession: vi.fn().mockResolvedValue(null),
    } as unknown as SessionManager;

    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    await router.handle(makePayload('test', 'continue'));

    const saved = await projectStore.load('test');
    // Status should not say "user response" — no decision was pending
    expect(saved!.status).not.toContain('user response');
  });
});

describe('/help command', () => {
  it('returns a list of all commands without hitting session manager', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'help-'));
    try {
      const store = new ProjectStore(path.join(tmpDir, '.projects'));
      await store.init();
      const router = new CommandRouter(makeNoopSM(), store, makeConfig(tmpDir));
      const { response } = await router.handle(makeCommand('help'));
      expect(response).toContain('/list');
      expect(response).toContain('/nudge');
      expect(response).toContain('/compact');
      expect(response).toContain('/reset');
      expect(response).toContain('/vacation');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe('/nudge command', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nudge-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    await projectStore.create({ title: 'Test', slug: 'test', description: 'x', directory: tmpDir, autoDecide: true });
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('returns usage message when no slug given', async () => {
    const router = new CommandRouter(makeNoopSM(), projectStore, makeConfig(tmpDir));
    const { response } = await router.handle(makeCommand('nudge'));
    expect(response).toContain('Usage: /nudge');
  });

  it('returns not-found message for unknown slug', async () => {
    const router = new CommandRouter(makeNoopSM(), projectStore, makeConfig(tmpDir));
    const payload: AskPayload = { trigger: { type: 'inline', query: 'ghost', sender: 'U', replyTo: null, originalMessage: '/nudge ghost' }, recentMessages: [], repliedToMessage: null };
    const { response } = await router.handle(payload);
    expect(response).toContain('"ghost" not found');
  });

  it('calls autoDecide and returns projectSlug for context% footer', async () => {
    const sm: SessionManager = {
      query: vi.fn().mockResolvedValue(makeWorkResult('Did some work', 5, 'review results')),
      resetSession: vi.fn(), loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('s1'), discoverSession: vi.fn().mockResolvedValue(null),
    } as unknown as SessionManager;
    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const payload: AskPayload = { trigger: { type: 'inline', query: 'test', sender: 'U', replyTo: null, originalMessage: '/nudge test' }, recentMessages: [], repliedToMessage: null };
    const result = await router.handle(payload);
    expect(result.projectSlug).toBe('test');
    expect(result.response).toContain('Auto-decided');
  });
});

describe('/compact command', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-cmd-'));
    await fs.writeFile(path.join(tmpDir, 'prompt.md'), 'test');
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    const proj = await projectStore.create({ title: 'Test', slug: 'test', description: 'x', directory: tmpDir, autoDecide: true });
    proj.sessionId = 'existing-session';
    proj.contextUsedPct = 80;
    await projectStore.save(proj);
  });

  afterEach(async () => { await fs.rm(tmpDir, { recursive: true }); });

  it('returns usage message when no slug given', async () => {
    const router = new CommandRouter(makeNoopSM(), projectStore, makeConfig(tmpDir));
    const { response } = await router.handle(makeCommand('compact'));
    expect(response).toContain('Usage: /compact');
  });

  it('returns no-session message when project has no session', async () => {
    const proj = await projectStore.load('test');
    proj!.sessionId = null;
    await projectStore.save(proj!);
    const router = new CommandRouter(makeNoopSM(), projectStore, makeConfig(tmpDir));
    const payload: AskPayload = { trigger: { type: 'inline', query: 'test', sender: 'U', replyTo: null, originalMessage: '/compact test' }, recentMessages: [], repliedToMessage: null };
    const { response } = await router.handle(payload);
    expect(response).toContain('no active session');
  });

  it('returns before/after context% and projectSlug', async () => {
    const ackResult: QueryResult = { text: 'ok', messages: ['ok'], toolsUsed: [], sessionId: 'new-session', costUsd: 0, contextUsedPct: 25 };
    const sm: SessionManager = {
      query: vi.fn()
        .mockResolvedValueOnce(makeQueryResult('Compacted!', 0, '', []))
        .mockResolvedValueOnce(ackResult),
      resetSession: vi.fn(), loadSession: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('existing-session'), discoverSession: vi.fn().mockResolvedValue(null),
    } as unknown as SessionManager;
    const router = new CommandRouter(sm, projectStore, makeConfig(tmpDir));
    const payload: AskPayload = { trigger: { type: 'inline', query: 'test', sender: 'U', replyTo: null, originalMessage: '/compact test' }, recentMessages: [], repliedToMessage: null };
    const result = await router.handle(payload);
    expect(result.projectSlug).toBe('test');
    expect(result.response).toContain('80%');
    expect(result.response).toContain('25%');
  });
});
