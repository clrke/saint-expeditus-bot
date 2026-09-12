import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleToolCall } from '../src/tools.js';

describe('handleToolCall', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expeditus-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('read_memory returns empty message for nonexistent file', async () => {
    const result = await handleToolCall('read_memory', { file: 'issues.md' }, tmpDir);
    expect(result).toContain('empty');
  });

  it('write_memory creates file and read_memory retrieves it', async () => {
    await handleToolCall(
      'write_memory',
      { file: 'issues.md', content: '# Water supply\nNo water in Block 5' },
      tmpDir,
    );
    const result = await handleToolCall('read_memory', { file: 'issues.md' }, tmpDir);
    expect(result).toBe('# Water supply\nNo water in Block 5');
  });

  it('write_memory rejects content over 50KB', async () => {
    const bigContent = 'x'.repeat(51_000);
    const result = await handleToolCall(
      'write_memory',
      { file: 'issues.md', content: bigContent },
      tmpDir,
    );
    expect(result).toContain('too large');
  });

  it('rejects invalid file names', async () => {
    const result = await handleToolCall(
      'read_memory',
      { file: '../../../etc/passwd' },
      tmpDir,
    );
    expect(result).toContain('invalid file');
  });

  it('rejects file names not in the allowlist', async () => {
    const result = await handleToolCall(
      'read_memory',
      { file: 'secrets.md' },
      tmpDir,
    );
    expect(result).toContain('invalid file');
  });

  it('returns error for unknown tool name', async () => {
    const result = await handleToolCall(
      'delete_memory',
      { file: 'issues.md' },
      tmpDir,
    );
    expect(result).toContain('Unknown tool');
  });

  it('write_memory creates directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'memory');
    await handleToolCall(
      'write_memory',
      { file: 'residents.md', content: '# Residents' },
      nestedDir,
    );
    const content = await fs.readFile(
      path.join(nestedDir, 'residents.md'),
      'utf-8',
    );
    expect(content).toBe('# Residents');
  });

  it('overwrites existing file content', async () => {
    await handleToolCall(
      'write_memory',
      { file: 'decisions.md', content: 'v1' },
      tmpDir,
    );
    await handleToolCall(
      'write_memory',
      { file: 'decisions.md', content: 'v2' },
      tmpDir,
    );
    const result = await handleToolCall(
      'read_memory',
      { file: 'decisions.md' },
      tmpDir,
    );
    expect(result).toBe('v2');
  });
});
