import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../src/session-manager.js';
import type { Config } from '../src/config.js';
import { EventEmitter, Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

let tmpDir: string;

function mockConfig(): Config {
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
  };
}

function mockGeminiSpawn(output: string) {
  const stdout = Readable.from([output]);
  const stderr = Readable.from([]);
  const stdin = new (require('stream').PassThrough)();
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });

  vi.mocked(spawn).mockReturnValue(proc as any);
  setTimeout(() => proc.emit('close', 0, null), 50);
}

/** Queues one claude CLI spawn outcome (success or failure) for the NEXT spawn() call only. */
function queueClaudeSpawn(outcome: { sessionId: string; text: string } | { failCode: number; stderr: string }) {
  const lines: string[] = [];
  let stderrText = '';
  let code = 0;
  if ('failCode' in outcome) {
    code = outcome.failCode;
    stderrText = outcome.stderr;
  } else {
    lines.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: outcome.sessionId }));
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: outcome.text }] } }));
    lines.push(JSON.stringify({ type: 'result', result: outcome.text, cost_usd: 0, session_id: outcome.sessionId }));
  }
  const stdout = Readable.from(lines.length ? [lines.join('\n') + '\n'] : []);
  const stderr = Readable.from(stderrText ? [stderrText] : []);
  const stdin = new (require('stream').PassThrough)();
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });

  vi.mocked(spawn).mockImplementationOnce(() => {
    setTimeout(() => proc.emit('close', code, null), 20);
    return proc as any;
  });
}

describe('SessionManager with Gemini Provider', () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
    sm = new SessionManager(mockConfig());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns gemini CLI with -p and -y flags', async () => {
    mockGeminiSpawn('Gemini response here');

    await sm.query('test', 'Hello Gemini', { cwd: '/tmp', provider: 'gemini' });

    expect(spawn).toHaveBeenCalledOnce();
    const [command, args] = vi.mocked(spawn).mock.calls[0];
    // Gemini is spawned via node with the script path
    expect(command).toBe('node');
    expect(args.some((a: string) => a.includes('gemini'))).toBe(true);
    expect(args).toContain('-p');
    expect(args).toContain('-y');
  });

  it('passes model flag when specified', async () => {
    mockGeminiSpawn('Response');

    await sm.query('test', 'Hello', { cwd: '/tmp', provider: 'gemini', model: 'gemini-2.5-flash' });

    const [, args] = vi.mocked(spawn).mock.calls[0];
    expect(args).toContain('-m');
    expect(args).toContain('gemini-2.5-flash');
  });

  it('returns plain text response', async () => {
    mockGeminiSpawn('Here is the answer to your question.');

    const result = await sm.query('test', 'Question', { cwd: '/tmp', provider: 'gemini' });

    expect(result.text).toBe('Here is the answer to your question.');
    expect(result.messages).toEqual(['Here is the answer to your question.']);
    expect(result.costUsd).toBe(0);
  });

  it('includes all output including [INFO] lines', async () => {
    mockGeminiSpawn('[INFO] Model switched to gemini-2.5-flash\nActual response');

    const result = await sm.query('test', 'Question', { cwd: '/tmp', provider: 'gemini' });

    expect(result.text).toContain('Actual response');
  });

  it('streams lines via onMessage', async () => {
    mockGeminiSpawn('Line 1\nLine 2\nLine 3');

    const messages: string[] = [];
    await sm.query('test', 'Hello', {
      cwd: '/tmp',
      provider: 'gemini',
      onMessage: (text) => messages.push(text),
    });

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it('does not use session resume for gemini', async () => {
    mockGeminiSpawn('First response');
    await sm.query('test-resume', 'First', { cwd: '/tmp', provider: 'gemini' });

    mockGeminiSpawn('Second response');
    await sm.query('test-resume', 'Second', { cwd: '/tmp', provider: 'gemini' });

    // Neither call should have --resume
    for (const call of vi.mocked(spawn).mock.calls) {
      expect(call[1]).not.toContain('--resume');
    }
  });

  it('persists gemini history to disk after query', async () => {
    mockGeminiSpawn('Answer');
    await sm.query('myproject', 'Question', { cwd: '/tmp', provider: 'gemini' });

    const historyFile = path.join(tmpDir, '.gemini-history.json');
    expect(fs.existsSync(historyFile)).toBe(true);

    const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    expect(data['myproject']).toBeDefined();
    expect(data['myproject'].length).toBeGreaterThan(0);
  });

  it('new SessionManager loads persisted gemini history', async () => {
    mockGeminiSpawn('First answer');
    await sm.query('myproject', 'First question', { cwd: '/tmp', provider: 'gemini' });

    // Create a fresh SM instance — should reload history from disk
    const sm2 = new SessionManager(mockConfig());

    mockGeminiSpawn('Second answer');
    await sm2.query('myproject', 'Second question', { cwd: '/tmp', provider: 'gemini' });

    // The second call's prompt should include history from the first session
    const [, args] = vi.mocked(spawn).mock.calls[1];
    const promptIdx = (args as string[]).indexOf('-p') + 1;
    const promptArg = (args as string[])[promptIdx] ?? '';
    expect(promptArg).toContain('First question');
  });

  it('resetSession clears gemini history from disk', async () => {
    mockGeminiSpawn('Answer');
    await sm.query('myproject', 'Question', { cwd: '/tmp', provider: 'gemini' });

    sm.resetSession('myproject');

    const historyFile = path.join(tmpDir, '.gemini-history.json');
    const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    expect(data['myproject']).toBeUndefined();
  });
});

describe('SessionManager with Claude Provider', () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
    sm = new SessionManager(mockConfig());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retries fresh specifically when a loaded (persisted) session ID is stale', async () => {
    // Simulates the production bug: a project loaded with a persisted sessionId (e.g.
    // from .projects/finance.md after being dormant long enough for the CLI to prune
    // it) attempts --resume, and the CLI rejects it with the real-world error text —
    // which notably does NOT contain the word "resume", so the fix must match on the
    // actual message content, not a naive substring check on "resume" alone.
    sm.loadSession('finance', 'dead-beef-0000');

    queueClaudeSpawn({ failCode: 1, stderr: 'No conversation found with session ID: dead-beef-0000' });
    queueClaudeSpawn({ sessionId: 'new-session-456', text: 'Recovered reply' });

    const result = await sm.query('finance', 'hello', { cwd: '/tmp', provider: 'claude' });

    expect(result.text).toBe('Recovered reply');
    expect(spawn).toHaveBeenCalledTimes(2);
    const [, firstArgs] = vi.mocked(spawn).mock.calls[0];
    expect(firstArgs).toContain('--resume');
    expect(firstArgs).toContain('dead-beef-0000');
    const [, secondArgs] = vi.mocked(spawn).mock.calls[1];
    expect(secondArgs).not.toContain('--resume');
  });

  it('does not swallow non-resume-related claude failures', async () => {
    sm.loadSession('finance', 'dead-beef-0000');
    queueClaudeSpawn({ failCode: 1, stderr: 'Something unrelated went wrong' });

    await expect(sm.query('finance', 'hello', { cwd: '/tmp', provider: 'claude' }))
      .rejects.toThrow('Something unrelated went wrong');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
