/**
 * One-time OAuth 2.0 setup for YouTube uploads.
 *
 * Reads ~/.saint-expeditus/youtube-client-secret.json (the Desktop-app OAuth client
 * config downloaded from Google Cloud Console), opens a browser for consent on the
 * `youtube.upload` scope, captures the authorization code via a local HTTP loopback
 * server, exchanges it for a refresh token, and writes the result to
 * ~/.saint-expeditus/youtube-token.json (chmod 600).
 *
 * Run once:
 *   npx --prefix discord-bot tsx src/youtube-auth.ts
 *
 * Re-run only if the refresh token is revoked or scopes change.
 */
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { CLIENT_SECRET_PATH, TOKEN_PATH } from './youtube-uploader.js';

const PORT = 8888;
// upload = insert videos; force-ssl = manage (list/delete) own videos, needed by the
// abandoned-draft cleanup. Requesting both keeps uploads working AND enables delete.
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to consent

async function main(): Promise<void> {
  const secretRaw = await fs.readFile(CLIENT_SECRET_PATH, 'utf-8');
  const secret = JSON.parse(secretRaw);
  const clientId: string = secret.installed?.client_id ?? secret.web?.client_id;
  const clientSecret: string = secret.installed?.client_secret ?? secret.web?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error(`client_id/client_secret missing in ${CLIENT_SECRET_PATH}`);
  }

  const redirectUri = `http://localhost:${PORT}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // force refresh_token even on re-auth

  console.log('\n📺 YouTube OAuth setup');
  console.log('───────────────────────');
  console.log('Opening browser for consent. If it does not open, copy this URL manually:\n');
  console.log(authUrl.toString());
  console.log('');

  // Best-effort browser open (macOS `open`, Linux `xdg-open`, Windows `start`)
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  exec(`${opener} "${authUrl.toString()}"`, () => { /* swallow — user can copy URL */ });

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Auth timed out after ${AUTH_TIMEOUT_MS / 1000}s`));
    }, AUTH_TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      const errorParam = url.searchParams.get('error');
      const codeParam = url.searchParams.get('code');
      if (errorParam) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>❌ Auth failed: ${errorParam}</h1><p>You can close this window.</p>`);
        clearTimeout(timer);
        server.close();
        reject(new Error(`OAuth error: ${errorParam}`));
        return;
      }
      if (!codeParam) {
        // Favicon, etc. — ignore
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✅ Auth complete</h1><p>You can close this window and return to the terminal.</p>');
      clearTimeout(timer);
      server.close();
      resolve(codeParam);
    });
    server.listen(PORT, () => {
      console.log(`Listening on ${redirectUri} for the OAuth redirect…\n`);
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  console.log('✓ Got authorization code, exchanging for tokens…');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokens = (await tokenRes.json()) as { refresh_token?: string; access_token?: string; scope?: string };
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token in response. Revoke this app at https://myaccount.google.com/permissions and re-run.',
    );
  }

  await fs.writeFile(
    TOKEN_PATH,
    JSON.stringify(
      {
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        obtainedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(`\n✅ Saved refresh token to ${TOKEN_PATH}`);
  console.log('YouTube auto-upload is now configured. Restart the discord-bot to pick up.\n');
}

main().catch((err) => {
  console.error('\n❌ Auth failed:', (err as Error).message);
  process.exit(1);
});
