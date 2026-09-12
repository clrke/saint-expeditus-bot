import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../bridge-server/src/app.js';
import { handleToolCall } from '../bridge-server/src/tools.js';
import { buildUserMessage } from '../bridge-server/src/prompt-builder.js';
import { RepliedTracker } from '../bridge-server/src/replied-tracker.js';
import { ProjectStore } from '../bridge-server/src/project-store.js';
import { HourlyLimiter } from '../bridge-server/src/hourly-limiter.js';
import type { CommandRouter } from '../bridge-server/src/command-router.js';
import type { AskPayload } from '../shared/types.js';
import type express from 'express';

describe('E2E: Full pipeline', () => {
  let tmpDir: string;
  let tracker: RepliedTracker;
  let projectStore: ProjectStore;
  let sseClients: Set<express.Response>;
  const unlimitedLimiter = new HourlyLimiter({ sessionLimit: 0, activeHours: 12 });

  function mockRouter(handler?: (p: AskPayload) => Promise<{ text: string; toolsUsed: string[] }>): CommandRouter {
    return {
      handle: async (payload: AskPayload) => {
        if (handler) {
          const result = await handler(payload);
          return { response: result.text };
        }
        return { response: 'ok' };
      },
    } as unknown as CommandRouter;
  }

  function makeApp(router: CommandRouter) {
    return createApp({
      commandRouter: router,
      repliedTracker: tracker,
      projectStore,
      maxRpm: 60,
      sseClients,
      hourlyLimiter: unlimitedLimiter,
    });
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
    tracker = new RepliedTracker(tmpDir);
    projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
    await projectStore.init();
    sseClients = new Set();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('processes a trigger through the full bridge pipeline', async () => {
    const payload: AskPayload = {
      trigger: {
        type: 'inline',
        query: 'anong status ng water?',
        sender: 'Bheck',
        replyTo: null,
        originalMessage: '/expeditus anong status ng water?',
      },
      recentMessages: [
        {
          sender: 'Emva',
          message: 'Walang tubig since kahapon',
          timestamp: '1/23/26 09:10',
          replyTo: null,
          type: 'text',
        },
      ],
      repliedToMessage: null,
    };

    const userMessage = buildUserMessage(payload, 30);
    expect(userMessage).toContain('Walang tubig');
    expect(userMessage).toContain('Bheck asked:');

    const router = mockRouter(async (p) => {
      const memContent = await handleToolCall('read_memory', { file: 'issues.md' }, tmpDir);
      await handleToolCall(
        'write_memory',
        { file: 'issues.md', content: '# Water Supply\n- No water in subdivision since 1/22/26' },
        tmpDir,
      );
      return {
        text: `Tungkol po sa water supply issue, nabanggit po ni ${p.recentMessages[0]?.sender} na walang tubig. I-monitor po natin.`,
        toolsUsed: ['read_memory', 'write_memory'],
      };
    });

    const app = makeApp(router);
    const res = await request(app).post('/ask').send(payload);

    expect(res.status).toBe(200);
    expect(res.body.response).toContain('water supply');

    const savedIssues = await fs.readFile(path.join(tmpDir, 'issues.md'), 'utf-8');
    expect(savedIssues).toContain('Water Supply');
  });

  it('handles rate limiting in pipeline', async () => {
    const app = createApp({
      commandRouter: mockRouter(),
      repliedTracker: tracker,
      projectStore,
      maxRpm: 1,
      sseClients,
      hourlyLimiter: unlimitedLimiter,
    });

    const payload: AskPayload = {
      trigger: { type: 'inline', query: 'test', sender: 'X', replyTo: null, originalMessage: '/expeditus test' },
      recentMessages: [],
      repliedToMessage: null,
    };

    const r1 = await request(app).post('/ask').send(payload);
    expect(r1.status).toBe(200);

    const r2 = await request(app).post('/ask').send({
      ...payload,
      trigger: { ...payload.trigger, originalMessage: '/expeditus test2' },
    });
    expect(r2.status).toBe(429);
  });

  it('health endpoint reports stats after requests', async () => {
    const app = makeApp(mockRouter());

    const payload: AskPayload = {
      trigger: { type: 'inline', query: 'test', sender: 'X', replyTo: null, originalMessage: '/expeditus test' },
      recentMessages: [],
      repliedToMessage: null,
    };

    const agent = request.agent(app);
    await agent.post('/ask').send(payload);
    // Second request needs different message to avoid dedup
    await agent.post('/ask').send({
      ...payload,
      trigger: { ...payload.trigger, originalMessage: '/expeditus test2', sender: 'Y' },
    });

    const health = await agent.get('/health');
    expect(health.body.status).toBe('ok');
    expect(health.body.stats.requestsServed).toBe(2);
  });

  it('returns 429 when hourly budget is exceeded', async () => {
    // base=1, effective=2 (2x rollover with no prev hour), so 3rd request triggers 429
    const tightLimiter = new HourlyLimiter({ sessionLimit: 1, activeHours: 1 });
    const app = createApp({
      commandRouter: mockRouter(),
      repliedTracker: tracker,
      projectStore,
      maxRpm: 60,
      sseClients,
      hourlyLimiter: tightLimiter,
    });

    const mk = (s: string, m: string): AskPayload => ({
      trigger: { type: 'inline', query: 'test', sender: s, replyTo: null, originalMessage: m },
      recentMessages: [],
      repliedToMessage: null,
    });

    await request(app).post('/ask').send(mk('A', '/expeditus first'));
    await request(app).post('/ask').send(mk('B', '/expeditus second'));

    const r3 = await request(app).post('/ask').send(mk('C', '/expeditus third'));
    expect(r3.status).toBe(429);
    expect(r3.body.error).toContain('Hourly limit reached');
  });
});
