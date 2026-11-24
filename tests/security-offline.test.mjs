/** Dependency-free behavior regressions, Node >=22.13. Source is executed with explicit
 * boundary doubles. These do not replace API/DB/browser/GCS integration tests. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { BlockList, isIP } from 'node:net';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
class ApiError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}
function evaluate(path, exports, globals = {}) {
  const source = read(path).replace(/^import[\s\S]*?;\n/gm, '').replace(/export class ApiError[\s\S]*?\n}\n/, '').replace(/\bexport (?=(?:async |const |let |function |class |interface |type ))/g, '');
  return vm.runInNewContext(stripTypeScriptTypes(source, {mode: 'strip'}) + `\n;({${exports}})`, {
    URL, URLSearchParams, AbortSignal, Buffer, Request, Response, Headers, process: {env: {}},
    ApiError, console, setTimeout, clearTimeout, ...globals,
  });
}

const dates = evaluate('apps/api/src/trips/days.ts', 'datesBetween', {MAX_TRIP_DAYS: 60});
test('SEC-04: inclusive 60 days accepted; 61 days and year 9999 rejected', () => {
  assert.equal(dates.datesBetween('2026-01-01', '2026-03-01').length, 60);
  for (const [a,b] of [['2026-01-01','2026-03-02'], ['2026-01-01','9999-12-31'], ['2026-03-01','2026-01-01'], ['invalid','2026-01-01']])
    assert.throws(() => dates.datesBetween(a,b), e => e.status === 400);
});

function httpsHarness(addresses, response = {}) {
  const calls = [];
  const m = evaluate('apps/api/src/lib/public-https.ts', 'isPublicAddress,readPublicJson', {
    BlockList, isIP,
    lookup: async () => addresses,
    request: (url, options, callback) => {
      calls.push({url, options});
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter();
        res.headers = response.headers ?? {};
        res.statusCode = response.status ?? 200;
        res.destroy = () => { res.destroyed = true; };
        callback(res);
        for (const chunk of response.chunks ?? [Buffer.from('{"ok":true}')]) {
          if (!res.destroyed) res.emit('data', chunk);
        }
        if (!res.destroyed) res.emit('end');
      });
      return req;
    },
  });
  return {...m, calls};
}
test('SEC-03: special IPv4, IPv6 and mapped forms rejected', () => {
  const {isPublicAddress} = httpsHarness([]);
  for (const ip of ['0.0.0.0','127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','172.16.1.2','192.168.1.1','192.0.2.1','198.18.0.1','224.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::','3fff::1'])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});
test('SEC-03: a single private DNS result rejects entire mixed DNS set', async () => {
  const h = httpsHarness([{address:'8.8.8.8',family:4},{address:'::1',family:6}]);
  await assert.rejects(h.readPublicJson('https://client.example/metadata'));
  assert.equal(h.calls.length, 0);
});
test('SEC-03: validated DNS is pinned to the actual TLS connection', async () => {
  const h = httpsHarness([{address:'8.8.8.8',family:4}]);
  assert.equal((await h.readPublicJson('https://client.example/metadata')).ok, true);
  assert.equal(h.calls[0].url.hostname, 'client.example'); // TLS verifies original hostname.
  h.calls[0].options.lookup('rebound.example', {}, (error, ip, family) => {
    assert.equal(error, null); assert.equal(ip, '8.8.8.8'); assert.equal(family, 4);
  });
  assert.equal(h.calls[0].options.agent, false);
});
test('SEC-03/05: redirects, credentials, nonstandard ports, encoded bodies, oversized streams rejected', async () => {
  for (const url of ['http://example.com','https://user:pass@example.com','https://example.com:8443','https://example.com/#x','https://[::ffff:127.0.0.1]'])
    await assert.rejects(httpsHarness([]).readPublicJson(url));
  for (const response of [{status:302}, {headers:{'content-encoding':'gzip'}}, {chunks:[Buffer.alloc(65536),Buffer.from('x')]}])
    await assert.rejects(httpsHarness([{address:'8.8.8.8',family:4}], response).readPublicJson('https://example.com'));
});

const limits = evaluate('apps/api/src/lib/limits.ts', 'assertJsonComplexity,inputLimits', {createMiddleware: fn => fn});
test('SEC-05: rejects excessive JSON depth and element count', () => {
  limits.assertJsonComplexity({details:{text:'okay'}});
  assert.throws(() => limits.assertJsonComplexity(Array(10001).fill(0)), e => e.status === 413);
  let deep = {}; for (let i=0;i<34;i++) deep = {nested:deep};
  assert.throws(() => limits.assertJsonComplexity(deep), e => e.status === 413);
});
async function limited(body, headers = {}, path = '/mcp') {
  const req = new Request('https://app.test'+path, {method:'POST',headers,body});
  let passed = false;
  await limits.inputLimits()({req:{path,raw:req,header: name => req.headers.get(name)}}, async () => {passed = true;});
  return passed;
}
test('SEC-05: counts actual bytes, including a dishonest Content-Length', async () => {
  await assert.rejects(limited('x'.repeat(262145), {'content-type':'application/json','content-length':'1'}), e => e.status === 413);
  assert.equal(await limited('{"jsonrpc":"2.0"}', {'content-type':'application/json; charset=utf-8'}), true);
});
test('SEC-05: wrong MIME cannot bypass JSON complexity checks; OAuth forms still work', async () => {
  await assert.rejects(limited('{}', {'content-type':'text/plain'}), e => e.status === 415);
  await assert.rejects(limited('{', {'content-type':'application/json'}), e => e.status === 400);
  assert.equal(await limited('grant_type=refresh_token', {'content-type':'application/x-www-form-urlencoded'}, '/oauth/token'), true);
});

function browser(fetch) {
  const values = new Map([['travelog:rt','old-refresh']]);
  const urls = [];
  const localStorage = {removeItem:k=>values.delete(k), getItem:k=>values.get(k)??null, setItem:(k,v)=>values.set(k,v)};
  const api = evaluate('apps/web/src/lib/api.ts', 'refreshAccessToken,setAccessToken,getAccessToken,bindSessionUser,sessionScope,sameSession,api,OfflineError,ApiError', {
    fetch, localStorage,
    window:{location:{hash:'#tl_rt=attacker-token',pathname:'/trips',search:''},history:{replaceState:(_a,_b,url)=>urls.push(url)}},
  });
  return {api,values,urls,localStorage};
}
test('SEC-01: ignores URL bearer credentials and uses only the same-origin cookie endpoint', async () => {
  const calls = [];
  const h = browser(async (...args) => {calls.push(args); return Response.json({accessToken:'legitimate'});});
  assert.equal(await h.api.refreshAccessToken(), 'legitimate');
  assert.equal(h.values.has('travelog:rt'), false);
  assert.equal(h.urls[0], '/trips');
  assert.equal(calls[0][0], '/session/refresh');
  assert.equal(calls[0][1].body, '{}');
  assert.equal(JSON.stringify(calls).includes('attacker'), false);
});
test('SEC-09: delayed refresh cannot restore a logged-out session', async () => {
  let resolve;
  const h = browser(() => new Promise(r=>{resolve=r;}));
  const pending = h.api.refreshAccessToken();
  h.api.setAccessToken(null);
  resolve(Response.json({accessToken:'stale-user'}));
  assert.equal(await pending, null);
  assert.equal(h.api.getAccessToken(), null);
});
test('SEC-09: delayed API response is discarded after account switch', async () => {
  let resolve;
  const h = browser(() => new Promise(r=>{resolve=r;}));
  h.api.bindSessionUser('A');
  const pending = h.api.api('GET','/v1/trips');
  h.api.bindSessionUser('B');
  resolve(Response.json({trips:['A-private']}));
  await assert.rejects(pending);
});
test('SEC-09: permission errors purge offline snapshot; only network failure permits fallback', async () => {
  const cache = new Map();
  let failure;
  const scope = {epoch:1,userId:'A'};
  const errorClasses = browser(()=>{}).api;
  const offline = evaluate('apps/web/src/lib/offline.ts','refreshSnapshot,snapshotWithOfflineFallback', {
    ...errorClasses, sessionScope:()=>scope, sameSession:s=>s.epoch===scope.epoch,
    api:async()=>{throw failure;},
    localStorage:{getItem:k=>cache.get(k)??null, removeItem:k=>cache.delete(k),setItem:(k,v)=>cache.set(k,v)},
  });
  const key='travelog:snapshot:A:trip';
  for (const status of [401,403,404]) {
    cache.set(key, JSON.stringify({private:'A'}));
    failure=new errorClasses.ApiError(status,'/denied','denied',{});
    await assert.rejects(offline.snapshotWithOfflineFallback('trip'));
    assert.equal(cache.has(key),false);
  }
  cache.set(key,JSON.stringify({private:'A'})); failure=new errorClasses.OfflineError();
  assert.equal((await offline.snapshotWithOfflineFallback('trip')).data.private,'A');
});
test('SEC-09: mobile generations isolate account transitions', () => {
  const s=evaluate('apps/mobile/src/lib/session.ts','sessionScope,bindSessionUser,invalidateSession,assertSession');
  s.bindSessionUser('A'); const old=s.sessionScope();
  s.invalidateSession(); s.bindSessionUser('B');
  assert.throws(()=>s.assertSession(old));
  assert.equal(s.sessionScope().userId,'B');
});

test('SEC-01: BFF refuses cross-site POST, arbitrary paths, and refresh token injection', async () => {
  const src = read('apps/web/src/app/session/[...path]/route.ts')
    .replace(/^import[^\n]+\n/, '').replace(/^export /gm, '').replace(/\{ proxy as GET, proxy as POST \};/, '');
  const calls=[];
  const proxy=vm.runInNewContext(stripTypeScriptTypes(src, {mode:'strip'})+'\n;proxy', {
    URL, Buffer, Response, Headers, AbortSignal,
    process:{env:{NODE_ENV:'production',APP_ORIGIN:'https://web.test',API_ORIGIN:'https://api.test'}},
    fetch:async(url, init)=>{ calls.push({url,init});return Response.json({accessToken:'valid'}); },
  });
  const invoke = async (path, body, origin='https://web.test') => {
    const req=new Request(`https://web.test/session/${path}`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
    req.nextUrl=new URL(req.url);
    return proxy(req,{params:Promise.resolve({path:path.split('/')})});
  };
  assert.equal((await invoke('refresh', {}, 'https://evil.test')).status,403);
  assert.equal((await invoke('refresh', {refreshToken:'attacker'})).status,400);
  assert.equal((await invoke('https://evil.test', {})).status,404);
  assert.equal(calls.length,0);
  assert.equal((await invoke('refresh', {})).status,200);
  assert.equal(String(calls[0].url),'https://api.test/v1/auth/refresh');
  assert.equal(calls[0].init.headers.get('Origin'),'https://web.test');
});
