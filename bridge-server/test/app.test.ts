import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { RepliedTracker } from '../src/replied-tracker.js';
import { ProjectStore } from '../src/project-store.js';
import type { CommandRouter } from '../src/command-router.js';
import type express from 'express';
import { HourlyLimiter } from '../src/hourly-limiter.js';

let tmpDir: string;
let tracker: RepliedTracker;
let projectStore: ProjectStore;
let sseClients: Set<express.Response>;

function mockRouter(response = 'Test response'): CommandRouter {
  return {
    handle: async () => ({ response }),
  } as unknown as CommandRouter;
}

const unlimitedLimiter = new HourlyLimiter({ sessionLimit: 0, activeHours: 12 });

function makeApp(router?: CommandRouter, hourlyLimiter?: HourlyLimiter) {
  return createApp({
    commandRouter: router ?? mockRouter(),
    repliedTracker: tracker,
    projectStore,
    maxRpm: 60,
    sseClients,
    hourlyLimiter: hourlyLimiter ?? unlimitedLimiter,
    sendToMessenger: () => {},
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expeditus-app-'));
  tracker = new RepliedTracker(tmpDir);
  projectStore = new ProjectStore(path.join(tmpDir, '.projects'));
  await projectStore.init();
  sseClients = new Set();
});

describe('GET /health', () => {
  it('returns health status', async () => {
    const app = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.requestsServed).toBe(0);
  });
});

describe('GET /projects', () => {
  it('returns slugs and commands', async () => {
    const app = makeApp();
    const res = await request(app).get('/projects');
    expect(res.status).toBe(200);
    expect(res.body.slugs).toEqual([]);
    expect(res.body.commands).toContain('list');
    expect(res.body.commands).toContain('register');
    expect(res.body.commands).toContain('compact');
    expect(res.body.commands).toContain('nudge');
    expect(res.body.commands).toContain('help');
  });

  it('includes registered project slugs', async () => {
    await projectStore.create({
      title: 'Test', slug: 'test-proj', description: 'x',
      directory: tmpDir, autoDecide: true,
    });
    const app = makeApp();
    const res = await request(app).get('/projects');
    expect(res.body.slugs).toContain('test-proj');
  });
});

describe('POST /notify', () => {
  it('pushes to sendToMessenger and returns ok for a registered slug', async () => {
    await projectStore.create({
      title: 'Test', slug: 'test-proj', description: 'x',
      directory: tmpDir, autoDecide: true,
    });
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    const app = createApp({
      commandRouter: mockRouter(),
      repliedTracker: tracker,
      projectStore,
      maxRpm: 60,
      sseClients,
      hourlyLimiter: unlimitedLimiter,
      sendToMessenger: (text, slug, projectDirectory) => { calls.push([text, slug, projectDirectory]); },
    });

    const res = await request(app).post('/notify').send({ slug: 'test-proj', message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(calls).toEqual([['hello', 'test-proj', tmpDir]]);
  });

  it('returns 404 for an unregistered slug', async () => {
    const app = makeApp();
    const res = await request(app).post('/notify').send({ slug: 'nope', message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when slug or message is missing', async () => {
    const app = makeApp();
    const res1 = await request(app).post('/notify').send({ message: 'hi' });
    expect(res1.status).toBe(400);
    const res2 = await request(app).post('/notify').send({ slug: 'test-proj' });
    expect(res2.status).toBe(400);
  });
});

describe('POST /ask', () => {
  it('returns 200 with valid trigger', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/ask')
      .send({
        trigger: {
          sender: 'Test', query: 'hello', type: 'inline',
          replyTo: null, originalMessage: '/expeditus hello',
        },
        recentMessages: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Test response');
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns alreadyReplied for duplicate trigger', async () => {
    const app = makeApp();
    const payload = {
      trigger: { sender: 'Test', query: 'hello', type: 'inline', replyTo: null, originalMessage: '/expeditus hello' },
      recentMessages: [],
    };

    await request(app).post('/ask').send(payload);
    const res = await request(app).post('/ask').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.alreadyReplied).toBe(true);
    expect(res.body.response).toBeNull();
  });

  it('returns 400 when trigger is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/ask').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('trigger');
  });

  it('returns 429 when rate limited', async () => {
    const app = createApp({
      commandRouter: mockRouter(),
      repliedTracker: tracker,
      projectStore,
      maxRpm: 1,
      sseClients,
      hourlyLimiter: unlimitedLimiter,
      sendToMessenger: () => {},
    });

    await request(app)
      .post('/ask')
      .send({
        trigger: { sender: 'A', type: 'inline', query: null, replyTo: null, originalMessage: '/expeditus' },
        recentMessages: [],
      });

    const res = await request(app)
      .post('/ask')
      .send({
        trigger: { sender: 'B', type: 'inline', query: null, replyTo: null, originalMessage: '/expeditus two' },
        recentMessages: [],
      });

    expect(res.status).toBe(429);
  });

  it('returns 500 when router throws', async () => {
    const failingRouter = {
      handle: async () => { throw new Error('API error'); },
    } as unknown as CommandRouter;
    const app = makeApp(failingRouter);

    const res = await request(app)
      .post('/ask')
      .send({
        trigger: { sender: 'Test', type: 'inline', query: 'test', replyTo: null, originalMessage: '/expeditus test' },
        recentMessages: [],
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Technical issue');
  });

  it('tracks stats after successful requests', async () => {
    const app = makeApp();

    await request(app)
      .post('/ask')
      .send({
        trigger: { sender: 'X', type: 'inline', query: 'test', replyTo: null, originalMessage: '/expeditus test' },
        recentMessages: [],
      });

    const health = await request(app).get('/health');
    expect(health.body.stats.requestsServed).toBe(1);
    expect(health.body.stats.avgResponseMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 429 with budget info when hourly limit exceeded', async () => {
    // base=1, effective=2 (2x rollover with no prev hour), so need 3 requests to trigger 429
    const tightLimiter = new HourlyLimiter({ sessionLimit: 1, activeHours: 1 });
    const app = makeApp(undefined, tightLimiter);

    const mkTrigger = (s: string, m: string) => ({ sender: s, type: 'inline', query: null, replyTo: null, originalMessage: m });
    await request(app).post('/ask').send({ trigger: mkTrigger('A', '/expeditus first'), recentMessages: [] });
    await request(app).post('/ask').send({ trigger: mkTrigger('B', '/expeditus second'), recentMessages: [] });

    const res = await request(app).post('/ask').send({
      trigger: mkTrigger('C', '/expeditus third'),
      recentMessages: [],
    });

    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Hourly limit reached');
    expect(res.body.budget).toBeDefined();
  });
});

describe('GET /budget', () => {
  it('returns unlimited status when no session limit', async () => {
    const app = makeApp();
    const res = await request(app).get('/budget');
    expect(res.status).toBe(200);
    expect(res.body.unlimited).toBe(true);
  });

  it('returns budget with upstream tracking and rollover', async () => {
    const limiter = new HourlyLimiter({ sessionLimit: 60, activeHours: 12 });
    const app = makeApp(undefined, limiter);
    const res = await request(app).get('/budget');
    expect(res.status).toBe(200);
    // base=5, effective=10 (2x rollover with no prev hour)
    expect(res.body.hourlyLimit).toBe(10);
    expect(res.body.usedThisHour).toBe(0);
    expect(res.body.remainingThisHour).toBe(10);
    expect(res.body.unlimited).toBe(false);
    expect(res.body.upstream).toBeDefined();
  });

  it('includes cost stats in budget response', async () => {
    const app = makeApp();
    const res = await request(app).get('/budget');
    expect(res.body.cost).toBeDefined();
    expect(res.body.cost.totalUsd).toBe(0);
    expect(res.body.cost.sessionCosts).toBeDefined();
  });

  it('reflects usage after requests', async () => {
    const limiter = new HourlyLimiter({ sessionLimit: 60, activeHours: 12 });
    const app = makeApp(undefined, limiter);

    await request(app).post('/ask').send({
      trigger: { sender: 'X', type: 'inline', query: 'test', replyTo: null, originalMessage: '/expeditus test' },
      recentMessages: [],
    });

    const res = await request(app).get('/budget');
    expect(res.body.usedThisHour).toBe(1);
    // base=5, effective=10 (2x), used 1, remaining 9
    expect(res.body.remainingThisHour).toBe(9);
    expect(res.body.upstream.windowCount).toBe(1);
  });
});

// Helper: parse SSE text into typed events
function parseSSE(body: string): { type: string; [k: string]: unknown }[] {
  return body
    .split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => JSON.parse(l.slice(6)));
}

describe('POST /ask/stream', () => {
  it('streams message events and done', async () => {
    const router = {
      handle: async (_payload: unknown, onMessage?: (t: string) => void) => {
        onMessage?.('Hello from Claude');
        return { response: 'Hello from Claude' };
      },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const msgEvents = events.filter(e => e.type === 'message');
    const doneEvent = events.find(e => e.type === 'done');

    expect(msgEvents.length).toBeGreaterThan(0);
    expect(msgEvents[0].text).toBe('Hello from Claude');
    expect(doneEvent).toBeDefined();
  });

  it('deduplicates parts when stripJsonParts returns duplicate content', async () => {
    // Simulate Claude returning prefix text that matches the JSON message
    const jsonResponse = '{"tldr": "Task done.", "decision": {"summary": "continue", "rating": 0}}';
    const router = {
      handle: async (_payload: unknown, onMessage?: (t: string) => void) => {
        // This raw text has prefix matching the JSON message — would produce duplicate parts
        onMessage?.(`Task done.\n\n${jsonResponse}`);
        return { response: 'Task done.' };
      },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const msgEvents = events.filter(e => e.type === 'message');

    // "Task done." should only appear once despite stripJsonParts returning it twice
    const taskDoneCount = msgEvents.filter(e => e.text === 'Task done.').length;
    expect(taskDoneCount).toBe(1);
  });

  it('sets singleShot=false on done when messages were already streamed', async () => {
    const router = {
      handle: async (_payload: unknown, onMessage?: (t: string) => void) => {
        onMessage?.('Some streamed content');
        return { response: 'Some streamed content' };
      },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent?.singleShot).toBe(false);
  });

  it('sets singleShot=true on done when nothing was streamed', async () => {
    const router = {
      handle: async () => ({ response: 'Static response' }),
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/list', replyTo: null } });

    const events = parseSSE(res.text);
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent?.singleShot).toBe(true);
    expect(doneEvent?.response).toBe('Static response');
  });

  it('returns 429 when RPM limit exceeded on stream endpoint', async () => {
    const router = {
      handle: async () => ({ response: 'ok' }),
    } as unknown as CommandRouter;
    const app = createApp({
      commandRouter: router,
      repliedTracker: tracker,
      projectStore,
      maxRpm: 1,
      sseClients,
      hourlyLimiter: unlimitedLimiter,
      sendToMessenger: () => {},
    });

    const trigger = { type: 'inline', sender: 'X', originalMessage: '/test', replyTo: null };
    const r1 = await request(app).post('/ask/stream').send({ trigger });
    expect(r1.status).toBe(200);

    const r2 = await request(app).post('/ask/stream').send({ trigger });
    expect(r2.status).toBe(429);
  });

  it('RPM counter is shared between /ask and /ask/stream', async () => {
    const router = {
      handle: async () => ({ response: 'ok' }),
    } as unknown as CommandRouter;
    const app = createApp({
      commandRouter: router,
      repliedTracker: tracker,
      projectStore,
      maxRpm: 1,
      sseClients,
      hourlyLimiter: unlimitedLimiter,
      sendToMessenger: () => {},
    });

    const trigger = { type: 'inline', sender: 'X', originalMessage: '/test', replyTo: null };
    const r1 = await request(app).post('/ask').send({ trigger });
    expect(r1.status).toBe(200);

    // Second request to /ask/stream should be rate-limited by shared counter
    const r2 = await request(app).post('/ask/stream').send({ trigger });
    expect(r2.status).toBe(429);
  });

  it('emits error event when handler throws', async () => {
    const router = {
      handle: async () => { throw new Error('Something went wrong'); },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const errEvent = events.find(e => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent?.error).toContain('Something went wrong');
  });

  it('emits aborted event when handler throws with "aborted"', async () => {
    const router = {
      handle: async () => { throw new Error('Request aborted by client'); },
    } as unknown as CommandRouter;

    const res = await request(makeApp(router))
      .post('/ask/stream')
      .send({ trigger: { type: 'text', sender: 'user', originalMessage: '/test', replyTo: null } });

    const events = parseSSE(res.text);
    const abortEvent = events.find(e => e.type === 'aborted');
    expect(abortEvent).toBeDefined();
  });
});
