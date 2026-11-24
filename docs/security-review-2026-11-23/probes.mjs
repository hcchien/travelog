/**
 * Offline review probes; Node >= 22.13. No dependencies or network calls.
 * These assert the vulnerable behavior observed on 2026-11-23, not desired behavior.
 * Source fragments are executed after TypeScript removal. Browser/fetch/ORM are mocked;
 * this is NOT a full API, browser, TLS, DNS, PostgreSQL or SDK integration test.
 * Run from any directory: node docs/security-review-2026-11-23/probes.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const results = [];
const between = (source, start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Source anchors missing: ${start}`);
  return source.slice(a, b);
};
const run = (source, context = {}) => vm.runInNewContext(
  stripTypeScriptTypes(source, { mode: 'strip' }),
  { URL, URLSearchParams, AbortSignal, ...context },
);

// SEC-01: unsolicited URL fragment replaces an existing session's refresh token.
{
  const src = read('apps/web/src/lib/api.ts');
  const fragment = between(src, 'function takeHashRefreshToken', 'export function getStoredRefreshToken');
  const data = new Map([['travelog:rt', 'existing-user-refresh-token']]);
  let replaced;
  const rt = run(`const RT_KEY = 'travelog:rt';\n${fragment}\ntakeHashRefreshToken();`, {
    localStorage: { setItem: (k, v) => data.set(k, v) },
    window: {
      location: { hash: '#tl_rt=attacker-owned-refresh-token', pathname: '/trips', search: '' },
      history: { replaceState: (_a, _b, url) => { replaced = url; } },
    },
  });
  assert.equal(rt, 'attacker-owned-refresh-token');
  assert.equal(data.get('travelog:rt'), rt);
  assert.equal(replaced, '/trips');
  results.push({ id: 'SEC-01', observed: 'Unsolicited fragment overwrote an existing refresh token and removed itself from the address.' });
}

// SEC-03: intercept fetch, never connect to any internal or external host.
{
  const src = read('apps/api/src/oauth/clients.ts');
  const fragment = between(src, 'const PRIVATE_HOST', 'const CIMD_REFRESH_MS')
    .replace('export const fetchClientMetadataOverHttps', 'const fetchClientMetadataOverHttps');
  const fetched = [];
  const fetchMetadata = run(`${fragment}\nfetchClientMetadataOverHttps;`, {
    fetch: async (url) => {
      fetched.push(String(url));
      return { ok: true, text: async () => '{}' };
    },
  });
  await assert.rejects(fetchMetadata('https://127.0.0.1/client.json'));
  const bypasses = [
    'https://[::ffff:127.0.0.1]/client.json',
    'https://[fc00::1]/client.json',
    'https://[fe80::1]/client.json',
    'https://internal.example/client.json',
  ];
  for (const url of bypasses) await fetchMetadata(url);
  assert.equal(fetched.length, 4);
  results.push({ id: 'SEC-03', observed: 'Loopback IPv4 blocked; mapped IPv6, ULA, link-local IPv6, and DNS names reached mocked fetch.', targets: fetched, limitation: 'Does not demonstrate real DNS resolution, TLS trust, internal reachability, or metadata access.' });
}

// SEC-04: exercise the exact range predicate and date generator without a huge allocation.
{
  const src = read('packages/schema/src/trips.ts');
  const max = src.match(/export const MAX_TRIP_DAYS = (\d+);/);
  assert(max);
  const fragment = between(src, 'function dayCount', 'const rangeMessage');
  const validRange = run(`const MAX_TRIP_DAYS = ${max[1]};\n${fragment}\nvalidRange;`);
  assert.equal(validRange({ startDate: '2026-01-01', endDate: '2026-04-01' }), false);
  assert.equal(validRange({ endDate: '2026-04-01' }), true);
  assert.equal(validRange({ endDate: '9999-12-31' }), true);
  const days = run(read('apps/api/src/trips/days.ts').replace('export function', 'function') + '\ndatesBetween;');
  assert.equal(days('2026-01-01', '2026-04-01').length, 91);
  const projected = (Date.parse('9999-12-31T00:00:00Z') - Date.parse('2026-01-01T00:00:00Z')) / 86400000 + 1;
  results.push({ id: 'SEC-04', observed: 'A partial date update passes the predicate; datesBetween generates 91 days.', projectedDaysFor9999: projected, limitation: 'Large date range was calculated arithmetically, not allocated or sent to a database.' });
}

// SEC-07: execute hasActiveGrant against a small in-memory ORM predicate fixture.
{
  const src = read('apps/api/src/auth/tokens.ts');
  const method = between(src, '  async hasActiveGrant(', '  private async insertRefreshToken(');
  const rows = [];
  const clock = new Date('2026-11-23T00:00:00Z');
  const columns = Object.fromEntries(['id', 'userId', 'clientId', 'revokedAt', 'expiresAt'].map(k => [k, k]));
  const db = { select: () => ({ from: () => ({ where: predicate => ({ limit: async n => rows.filter(predicate).slice(0, n) }) }) }) };
  const grantCheck = run(`class Probe { ${method} }\nnew Probe();`, {
    schema: { refreshTokens: columns },
    eq: (k, v) => row => row[k] === v,
    gt: (k, v) => row => row[k] > v,
    isNull: k => row => row[k] == null,
    and: (...predicates) => row => predicates.every(p => p(row)),
  });
  grantCheck.db = db;
  grantCheck.now = () => clock;
  const old = { id: 'old', userId: 'user', clientId: 'client', scope: 'trips:read trips:write', revokedAt: null, expiresAt: new Date('2027-01-01') };
  rows.push(old);
  assert.equal(await grantCheck.hasActiveGrant('user', 'client'), true);
  old.revokedAt = clock;
  assert.equal(await grantCheck.hasActiveGrant('user', 'client'), false);
  rows.push({ ...old, id: 'new', scope: 'trips:read', revokedAt: null });
  assert.equal(await grantCheck.hasActiveGrant('user', 'client'), true);
  results.push({ id: 'SEC-07', observed: 'Grant gate changes true -> false -> true after revocation followed by a new read-only grant for the same client.', limitation: 'Uses the exact query method with mocked ORM predicates; JWT signing and the MCP HTTP route were not run.' });
}

console.log(JSON.stringify({
  date: '2026-11-23',
  root: fileURLToPath(root),
  runtime: process.version,
  probeGroups: results.length,
  results,
}, null, 2));
