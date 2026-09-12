/**
 * One-time OAuth 2.0 setup for Meta (Facebook + Instagram) uploads.
 *
 * Reads ~/.saint-expeditus/meta-app-credentials.json:
 *   { "app_id": "...", "app_secret": "..." }
 *   (from Meta Developer Portal → Your App → Settings → Basic)
 *
 * Obtains:
 *   - Long-lived Page Access Token (never expires)
 *   - Facebook Page ID
 *   - Instagram Business/Creator User ID (if linked)
 *
 * Writes ~/.saint-expeditus/meta-token.json (chmod 600).
 *
 * Run once:
 *   npx --prefix discord-bot tsx src/meta-auth.ts
 *
 * Re-run only if the token is revoked or you change scopes.
 *
 * Prerequisites:
 *   1. Create a Meta app at developers.facebook.com (type: Business or Consumer)
 *   2. Add products: "Facebook Login" + "Instagram Graph API"
 *   3. In Facebook Login settings, add `http://localhost:8889` as a Valid OAuth Redirect URI
 *   4. Save App ID + App Secret to ~/.saint-expeditus/meta-app-credentials.json
 *   5. Request these permissions in App Review (required to use with non-test users):
 *        pages_show_list, pages_manage_posts, pages_read_engagement,
 *        instagram_basic, instagram_content_publish
 */
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { META_CREDENTIALS_PATH, META_TOKEN_PATH } from './meta-uploader.js';

const PORT = 8889;
const REDIRECT_URI = `http://localhost:${PORT}`;
const GRAPH_VERSION = 'v21.0';
const SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
].join(',');
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const credsRaw = await fs.readFile(META_CREDENTIALS_PATH, 'utf-8').catch(() => {
    throw new Error(
      `Missing credentials file.\nCreate ~/.saint-expeditus/meta-app-credentials.json:\n  { "app_id": "...", "app_secret": "..." }\n(from developers.facebook.com → Your App → Settings → Basic)`,
    );
  });
  const creds = JSON.parse(credsRaw) as { app_id: string; app_secret: string };
  const { app_id, app_secret } = creds;
  if (!app_id || !app_secret) throw new Error('app_id or app_secret missing in credentials file');

  const authUrl = new URL('https://www.facebook.com/dialog/oauth');
  authUrl.searchParams.set('client_id', app_id);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('response_type', 'code');

  console.log('\n📘 Meta OAuth setup');
  console.log('──────────────────────');
  console.log('Opening browser for consent. If it does not open, copy this URL manually:\n');
  console.log(authUrl.toString());
  console.log('');

  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  exec(`${opener} "${authUrl.toString()}"`, () => {});

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Auth timed out after ${AUTH_TIMEOUT_MS / 1000}s`));
    }, AUTH_TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      const errorParam = url.searchParams.get('error');
      const codeParam = url.searchParams.get('code');
      if (errorParam) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>❌ Auth failed: ${errorParam}</h1>`);
        clearTimeout(timer); server.close(); reject(new Error(`OAuth error: ${errorParam}`));
        return;
      }
      if (!codeParam) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✅ Auth complete</h1><p>You can close this window.</p>');
      clearTimeout(timer); server.close(); resolve(codeParam);
    });
    server.listen(PORT, () => console.log(`Listening on ${REDIRECT_URI} for the OAuth redirect…\n`));
    server.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  // Exchange code → short-lived user token
  console.log('✓ Got authorization code, exchanging for user token…');
  const tokenRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app_id, client_secret: app_secret, redirect_uri: REDIRECT_URI, code }),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const shortToken = await tokenRes.json() as { access_token: string };

  // Exchange short-lived → long-lived user token (60 days)
  console.log('✓ Exchanging for long-lived user token…');
  const longTokenRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${app_id}&client_secret=${app_secret}&fb_exchange_token=${shortToken.access_token}`,
  );
  if (!longTokenRes.ok) throw new Error(`Long-lived token exchange failed: ${await longTokenRes.text()}`);
  const longToken = await longTokenRes.json() as { access_token: string };

  // Get Pages the user manages
  console.log('✓ Fetching managed Pages…');
  const pagesRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?access_token=${longToken.access_token}`,
  );
  if (!pagesRes.ok) throw new Error(`Failed to fetch pages: ${await pagesRes.text()}`);
  const pages = await pagesRes.json() as { data: Array<{ id: string; name: string; access_token: string }> };

  if (!pages.data || pages.data.length === 0) {
    throw new Error('No Facebook Pages found. You must administer at least one Page.');
  }

  let page = pages.data[0];
  if (pages.data.length > 1) {
    console.log('\nFound multiple Pages:');
    pages.data.forEach((p, i) => console.log(`  [${i}] ${p.name} (${p.id})`));
    console.log('\nUsing first Page:', page.name);
  } else {
    console.log(`✓ Page: ${page.name} (${page.id})`);
  }

  // Get Instagram Business/Creator account linked to this Page
  console.log('✓ Checking for linked Instagram account…');
  const igRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`,
  );
  let igUserId: string | null = null;
  if (igRes.ok) {
    const igData = await igRes.json() as { instagram_business_account?: { id: string } };
    igUserId = igData.instagram_business_account?.id ?? null;
  }
  if (igUserId) {
    console.log(`✓ Instagram account linked: ${igUserId}`);
  } else {
    console.log('⚠ No Instagram Business/Creator account linked to this Page — Instagram uploads will be skipped');
  }

  await fs.writeFile(
    META_TOKEN_PATH,
    JSON.stringify({ pageAccessToken: page.access_token, pageId: page.id, igUserId, obtainedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );

  console.log(`\n✅ Saved token to ${META_TOKEN_PATH}`);
  console.log(`   Facebook Page: ${page.name} (${page.id})`);
  console.log(`   Instagram:     ${igUserId ?? 'not linked'}`);
  console.log('\nMeta auto-upload is now configured. Restart discord-bot to pick up.\n');
}

main().catch((err) => {
  console.error('\n❌ Auth failed:', (err as Error).message);
  process.exit(1);
});
