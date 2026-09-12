import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../src/session-manager.js';
import type { Config } from '../src/config.js';
import { EventEmitter, Readable } from 'node:stream';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

function mockConfig(): Config {
  return {
    port: 3141,
    model: 'haiku',
    memoryDir: '/tmp/test',
    systemDir: '/tmp/test',
    promptFile: '/tmp/test/prompt.md',
    maxToolRounds: 5,
    requestTimeoutMs: 180000,
    maxContextMessages: 30,
    maxRequestsPerMinute: 60,
    retryAttempts: 2,
    retryDelayMs: 1000,
    projectsDir: '/tmp/test/.projects',
    sessionLimit: 0,
    sessionLimitHours: 12,
    defaultProvider: 'claude',
    autoDecideModel: undefined,
  };
}

function mockSpawnWithToolUse(blocks: any[]) {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-123' }),
    JSON.stringify({ type: 'assistant', message: { content: blocks } }),
    JSON.stringify({ type: 'result', result: 'done' }),
  ].join('\n') + '\n';

  const stdout = Readable.from([lines]);
  const stderr = Readable.from([]);
  const stdin = new (require('stream').PassThrough)();
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });

  vi.mocked(spawn).mockReturnValue(proc as any);

  // Emit close after stream is consumed
  setTimeout(() => proc.emit('close', 0, null), 50);
}

describe('Tool detail formatting', () => {
  let sm: SessionManager;
  let toolDetails: Array<{ name: string; detail: string }>;

  beforeEach(() => {
    sm = new SessionManager(mockConfig());
    toolDetails = [];
  });

  it('formats Edit with old_string and new_string', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: '/src/app.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
    }]);

    await sm.query('test', 'edit something', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails).toHaveLength(1);
    expect(toolDetails[0].name).toBe('Edit');
    expect(toolDetails[0].detail).toContain('/src/app.ts');
    expect(toolDetails[0].detail).toContain('```diff');
    expect(toolDetails[0].detail).toContain('-   1 const x = 1;');
    expect(toolDetails[0].detail).toContain('+   1 const x = 2;');
  });

  it('formats Edit with multiline old/new strings in diff format', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: '/src/index.ts',
        old_string: 'line 1\nline 2\nline 3',
        new_string: 'changed 1\nchanged 2',
      },
    }]);

    await sm.query('test', 'edit', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toContain('- ');
    expect(toolDetails[0].detail).toContain('line 1');
    expect(toolDetails[0].detail).toContain('line 2');
    expect(toolDetails[0].detail).toContain('line 3');
    expect(toolDetails[0].detail).toContain('+ ');
    expect(toolDetails[0].detail).toContain('changed 1');
    expect(toolDetails[0].detail).toContain('changed 2');
  });

  it('shows unchanged lines without +/- prefix', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: '/src/ctx.ts',
        old_string: 'const a = 1;\nconst b = 2;\nconst c = 3;',
        new_string: 'const a = 1;\nconst b = 99;\nconst c = 3;',
      },
    }]);

    await sm.query('test', 'edit ctx', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toContain('1 const a = 1;');
    expect(toolDetails[0].detail).toContain('3 const c = 3;');
    expect(toolDetails[0].detail).toContain('- ');
    expect(toolDetails[0].detail).toContain('const b = 2;');
    expect(toolDetails[0].detail).toContain('+ ');
    expect(toolDetails[0].detail).toContain('const b = 99;');
  });

  it('truncates long Edit strings to 500 chars', async () => {
    const longString = 'a'.repeat(800);
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: '/src/long.ts',
        old_string: longString,
        new_string: 'short',
      },
    }]);

    await sm.query('test', 'edit', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toContain('```diff');
    expect(toolDetails[0].detail).toContain('- ');
    expect(toolDetails[0].detail).toContain('aaaa');
    const oldLines = toolDetails[0].detail.split('\n').filter((l: string) => l.startsWith('-'));
    const oldContent = oldLines.map((l: string) => l.replace(/^-\s*\d+\s*/, '')).join('');
    expect(oldContent.length).toBeLessThanOrEqual(500);
  });

  it('formats Write with file path, content length, and preview', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Write',
      input: {
        file_path: '/src/new-file.ts',
        content: 'export function hello() {\n  return "world";\n}\n',
      },
    }]);

    await sm.query('test', 'write', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].name).toBe('Write');
    expect(toolDetails[0].detail).toContain('/src/new-file.ts');
    expect(toolDetails[0].detail).toContain('46 chars');
    expect(toolDetails[0].detail).toContain('export function hello()');
    // Newlines must pass through verbatim so Discord renders real line breaks inside
    // the ``` fence. Regression: previously \n was escaped to literal "\n".
    expect(toolDetails[0].detail).toContain('export function hello() {\n  return "world";\n}');
    expect(toolDetails[0].detail).not.toMatch(/export function hello\(\) \{\\n/);
  });

  it('Write: defuses triple-backticks so the outer Discord code fence cannot terminate early', async () => {
    const content = 'Use ```bash\necho hi\n``` to run.';
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Write',
      input: { file_path: '/readme.md', content },
    }]);
    await sm.query('test', 'write', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });
    const detail = toolDetails[0].detail;
    expect(detail).toMatch(/^\/readme\.md/);
    // Embedded ``` must each be ZWSP-prefixed so Discord's parser doesn't see them as
    // fence chars. Counted by triples NOT preceded by U+200B — only the outer fence pair.
    expect((detail.match(/(?<!​)```/g) ?? []).length).toBe(2);
    expect(detail).toContain('​```bash');
    expect(detail).toContain('​```');
  });

  it('Edit: defuses triple-backticks in old_string/new_string so the outer diff fence holds', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: '/doc.md',
        old_string: 'see ```python\npass\n```',
        new_string: 'see ```ts\nx\n```',
      },
    }]);
    await sm.query('test', 'edit', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });
    const detail = toolDetails[0].detail;
    // Only the outer ```diff … ``` pair is unprotected; embedded ones are ZWSP-prefixed.
    expect((detail.match(/(?<!​)```/g) ?? []).length).toBe(2);
    expect(detail).toContain('```diff');
    expect(detail).toContain('​```python');
    expect(detail).toContain('​```ts');
  });

  it('formats Bash with command and timeout', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Bash',
      input: {
        command: 'npm test',
        timeout: 30000,
      },
    }]);

    await sm.query('test', 'run test', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('npm test (30s timeout)');
  });

  it('formats Bash without timeout', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'git status' },
    }]);

    await sm.query('test', 'run', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('git status');
  });

  it('formats Read with file path', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/src/config.ts' },
    }]);

    await sm.query('test', 'read', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('/src/config.ts');
  });

  it('formats Read with offset and limit as line range', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/src/app.ts', offset: 50, limit: 20 },
    }]);

    await sm.query('test', 'read range', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('/src/app.ts:50-70');
  });

  it('formats Read with only offset', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/src/app.ts', offset: 100 },
    }]);

    await sm.query('test', 'read offset', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('/src/app.ts:100');
  });

  it('formats Grep with pattern and path', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Grep',
      input: { pattern: 'TODO', path: './src' },
    }]);

    await sm.query('test', 'grep', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('"TODO" in ./src');
  });

  it('formats Glob with pattern', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Glob',
      input: { pattern: '**/*.ts' },
    }]);

    await sm.query('test', 'glob', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('**/*.ts');
  });

  it('formats WebFetch with URL', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'WebFetch',
      input: { url: 'https://example.com/api' },
    }]);

    await sm.query('test', 'fetch', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('https://example.com/api');
  });

  it('formats WebSearch with query', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'WebSearch',
      input: { query: 'unity VR performance' },
    }]);

    await sm.query('test', 'search', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toBe('unity VR performance');
  });

  it('collects multiple tool uses in order', async () => {
    mockSpawnWithToolUse([
      { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts', old_string: 'old', new_string: 'new' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]);

    await sm.query('test', 'do stuff', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails).toHaveLength(3);
    expect(toolDetails[0].name).toBe('Read');
    expect(toolDetails[1].name).toBe('Edit');
    expect(toolDetails[2].name).toBe('Bash');
  });

  it('Edit diff uses ```diff code block for Discord syntax coloring', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: '/src/test.ts',
        old_string: 'const old = true;',
        new_string: 'const old = false;',
      },
    }]);

    await sm.query('test', 'edit', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].detail).toContain('```diff');
    expect(toolDetails[0].detail).toContain('- ');
    expect(toolDetails[0].detail).toContain('const old = true;');
    expect(toolDetails[0].detail).toContain('+ ');
    expect(toolDetails[0].detail).toContain('const old = false;');
    const lines = toolDetails[0].detail.split('\n');
    expect(lines[0]).toBe('/src/test.ts');
  });

  it('handles unknown tools with JSON preview', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'CustomTool',
      input: { foo: 'bar', baz: 123 },
    }]);

    await sm.query('test', 'custom', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].name).toBe('CustomTool');
    expect(toolDetails[0].detail).toContain('foo');
    expect(toolDetails[0].detail).toContain('bar');
  });

  it('formats MultiEdit with per-file line counts', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'MultiEdit',
      input: {
        edits: [
          { file_path: '/src/a.ts', old_string: 'line1\nline2', new_string: 'replaced' },
          { file_path: '/src/b.ts', old_string: 'x', new_string: 'y\nz\nw' },
        ],
      },
    }]);

    await sm.query('test', 'multi-edit', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].name).toBe('MultiEdit');
    expect(toolDetails[0].detail).toContain('/src/a.ts');
    expect(toolDetails[0].detail).toContain('/src/b.ts');
    expect(toolDetails[0].detail).toContain('-2 +1');
    expect(toolDetails[0].detail).toContain('-1 +3');
  });

  it('formats Agent with description and subagent_type', async () => {
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'Agent',
      input: { description: 'Review codebase', subagent_type: 'general-purpose', prompt: 'A very long prompt that should not appear in the detail...' },
    }]);

    await sm.query('test', 'spawn agent', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].name).toBe('Agent');
    const parsed = JSON.parse(toolDetails[0].detail);
    expect(parsed.description).toBe('Review codebase');
    expect(parsed.subagent_type).toBe('general-purpose');
    expect(parsed.prompt).toContain('A very long prompt');
  });

  it('formats AskUserQuestion with full payload (no 300-char truncation)', async () => {
    const longQuestion = 'a'.repeat(800); // would be cut off by the default 300-char slice
    mockSpawnWithToolUse([{
      type: 'tool_use',
      name: 'AskUserQuestion',
      input: {
        questions: [{
          header: 'Window strategy',
          question: longQuestion,
          multiSelect: false,
          options: [
            { label: 'Render existing', description: 'Keep all four walls' },
            { label: 'Reduce to north only', description: 'Drop east+west+south' },
          ],
        }],
      },
    }]);

    await sm.query('test', 'ask', {
      cwd: '/tmp',
      onToolUse: (name, detail) => toolDetails.push({ name, detail }),
    });

    expect(toolDetails[0].name).toBe('AskUserQuestion');
    const parsed = JSON.parse(toolDetails[0].detail);
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0].header).toBe('Window strategy');
    expect(parsed.questions[0].question).toBe(longQuestion); // not truncated
    expect(parsed.questions[0].options).toHaveLength(2);
    expect(parsed.questions[0].options[0].label).toBe('Render existing');
  });
});

describe('Cost tracking', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(mockConfig());
  });

  it('includes costUsd in query result', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cost-test' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', result: 'done', cost_usd: 0.0042 }),
    ].join('\n') + '\n';

    const stdout = Readable.from([lines]);
    const stderr = Readable.from([]);
    const stdin = new (require('stream').PassThrough)();
    const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(proc as any);
    setTimeout(() => proc.emit('close', 0, null), 50);

    const result = await sm.query('cost-test', 'test', { cwd: '/tmp' });
    expect(result.costUsd).toBe(0.0042);
  });

  it('returns 0 cost when not provided', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'no-cost' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ].join('\n') + '\n';

    const stdout = Readable.from([lines]);
    const stderr = Readable.from([]);
    const stdin = new (require('stream').PassThrough)();
    const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(proc as any);
    setTimeout(() => proc.emit('close', 0, null), 50);

    const result = await sm.query('no-cost', 'test', { cwd: '/tmp' });
    expect(result.costUsd).toBe(0);
  });
});

describe('Spawn queue', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(mockConfig());
    // The module-level `spawn` mock accumulates call history across every test in this
    // file (no global clearMocks) — reset it so per-test call-count assertions are scoped
    // to this test alone.
    vi.mocked(spawn).mockClear();
  });

  it('queues a second query behind an in-flight one for the same slug instead of killing it', async () => {
    const linesFor = (text: string) => [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'lock-test' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
      JSON.stringify({ type: 'result', result: text }),
    ].join('\n') + '\n';

    // First query: set up a proc that doesn't close immediately
    const stdout1 = Readable.from([linesFor('first-done')]);
    const stderr1 = Readable.from([]);
    const stdin1 = new (require('stream').PassThrough)();
    const proc1 = Object.assign(new EventEmitter(), { stdout: stdout1, stderr: stderr1, stdin: stdin1, kill: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(proc1 as any);

    // Start first query but don't let it finish
    const q1 = sm.query('locked', 'first', { cwd: '/tmp' });

    const stdout2 = Readable.from([linesFor('second-done')]);
    const stderr2 = Readable.from([]);
    const stdin2 = new (require('stream').PassThrough)();
    const proc2 = Object.assign(new EventEmitter(), { stdout: stdout2, stderr: stderr2, stdin: stdin2, kill: vi.fn() });
    vi.mocked(spawn).mockReturnValueOnce(proc2 as any);

    const q2 = sm.query('locked', 'second', { cwd: '/tmp' });

    // Second query must NOT spawn (or touch proc1) while the first is still in flight.
    await new Promise(r => setTimeout(r, 10));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(proc1.kill).not.toHaveBeenCalled();

    // First proc completes normally.
    proc1.emit('close', 0, null);
    const result1 = await q1;
    expect(result1.text).toBe('first-done');
    expect(proc1.kill).not.toHaveBeenCalled();

    // Only now should the second query's process spawn.
    await new Promise(r => setTimeout(r, 10));
    expect(spawn).toHaveBeenCalledTimes(2);
    proc2.emit('close', 0, null);

    const result2 = await q2;
    expect(result2.text).toBe('second-done');
  });
});
