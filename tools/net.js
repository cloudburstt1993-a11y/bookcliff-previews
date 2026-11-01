// Best-effort, bounded HTTP for the preview builder. Every request has its own timeout, a byte cap
// and a content-type check, and shares one overall deadline (the "budget"). Redirects are followed by
// hand so each hop is checked: only http/https, no credentials in the URL, and no private, loopback or
// link-local addresses (the builder runs in CI, so it must not be steered at internal endpoints).
// Callers treat every throw as "source unavailable" and fall back; nothing here is fatal to a build.
'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const UA = 'Mozilla/5.0 (compatible; BookcliffPreview/1.0; +https://bookcliffweb.com)';
const PER_REQUEST_MS = 8000;

class SourceError extends Error {}

function createBudget(ms) {
  return { signal: AbortSignal.timeout(ms) };
}

// Parse an outside URL. Returns a URL only for http(s) without user:pass, otherwise null.
function httpUrl(input, base) {
  if (typeof input !== 'string' || input.length > 4096) return null;
  try {
    const u = new URL(input.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateV4(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new SourceError('private address');
    return;
  }
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/i.test(host)) throw new SourceError('local host name');
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new SourceError('private address');
}

// GET (or POST) a URL with caps. Returns { url, status, contentType, buffer }.
// opts: budget (required), maxBytes, accept (RegExp on content-type), method, headers, body,
//       headersOnly (stop after headers), okOnly (default true: throw on non-2xx).
async function fetchCapped(input, opts) {
  const { budget, maxBytes = 2 * 1024 * 1024, accept, method = 'GET', headers = {}, body, headersOnly = false, okOnly = true } = opts;
  let current = httpUrl(String(input));
  if (!current) throw new SourceError('not an http(s) URL');
  for (let hop = 0; hop <= 5; hop++) {
    if (budget.signal.aborted) throw new SourceError('time budget used up');
    await assertPublicHost(current.hostname);
    const signal = AbortSignal.any([budget.signal, AbortSignal.timeout(PER_REQUEST_MS)]);
    const res = await fetch(current, { method, headers: { 'user-agent': UA, ...headers }, body, redirect: 'manual', signal });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (method !== 'GET') throw new SourceError(`redirect on ${method}`);
      const next = httpUrl(location, current);
      if (!next) throw new SourceError('redirect to a non-http(s) URL');
      current = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (okOnly) throw new SourceError(`HTTP ${res.status} from ${current.hostname}`);
      return { url: current.href, status: res.status, contentType: '', buffer: Buffer.alloc(0) };
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (accept && !accept.test(contentType)) {
      await res.body?.cancel();
      throw new SourceError(`unexpected content-type "${contentType.slice(0, 60)}" from ${current.hostname}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new SourceError(`too large (${declared} bytes) from ${current.hostname}`);
    }
    if (headersOnly) {
      await res.body?.cancel();
      return { url: current.href, status: res.status, contentType, buffer: Buffer.alloc(0) };
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new SourceError(`over ${maxBytes} bytes from ${current.hostname}`);
      chunks.push(chunk);
    }
    return { url: current.href, status: res.status, contentType, buffer: Buffer.concat(chunks) };
  }
  throw new SourceError('too many redirects');
}

// Run a best-effort step: log why it was skipped (to stderr, never secrets) and return the fallback.
async function attempt(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    const why = err instanceof SourceError ? err.message : (err?.name === 'TimeoutError' || err?.name === 'AbortError') ? 'timed out' : (err?.cause?.code || err?.message || String(err));
    console.error(`[preview] ${label}: skipped (${String(why).slice(0, 160)})`);
    return fallback;
  }
}

module.exports = { UA, SourceError, createBudget, httpUrl, isPrivateIp, fetchCapped, attempt };
