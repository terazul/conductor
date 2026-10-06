#!/usr/bin/env node
/**
 * `make status` formatter.
 *
 * This lives in a file rather than inline in the Makefile on purpose: a JS
 * template literal's `${...}` is *Make's* variable syntax inside a recipe, so an
 * inline version silently expanded every interpolation to an empty string. The
 * status output printed "seq  ·  browser client(s) · up s" and looked like a
 * daemon bug rather than a quoting bug.
 *
 * Reads nothing from argv; talks to the daemon directly.
 */

const PORT = process.env.CONDUCTOR_PORT ?? '7777';
const WEB = process.env.WEB_PORT ?? '5173';

// The daemon binds 127.0.0.1; Vite binds ::1 only. Each is probed where it
// actually answers — getting this wrong makes a working server look dead.
const DAEMON = `http://127.0.0.1:${PORT}`;
const WEB_URL = `http://localhost:${WEB}`;

async function get(url, ms = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

function pad(label) {
  return `  ${label.padEnd(10)}`;
}

const out = [];
out.push('');

// ── daemon ──────────────────────────────────────────────────────────────────
const health = await get(`${DAEMON}/api/health`);
if (health) {
  const h = await health.json();
  out.push(`  daemon    up on 127.0.0.1:${PORT}  pid ${h.pid}`);
  out.push(
    `            seq ${h.seq} · ${h.clients} browser client(s) · up ${h.uptimeSec}s`,
  );
  // Amendment 38: which commit, made when, and whether HEAD has moved since boot.
  const build = await get(`${DAEMON}/api/build`);
  if (build) {
    const b = await build.json();
    const tag = b.commit ? `${b.branch ? `${b.branch}@` : ''}${b.commit}${b.dirty ? '*' : ''}` : `v${b.version}`;
    out.push(`  build     ${tag} · committed ${b.committedAt ?? '—'} · started ${b.startedAt}`);
    if (b.behind) out.push(`            <-- checkout is at ${b.head}; make restart to run it`);
  }
} else {
  out.push('  daemon    down');
}

// ── web ─────────────────────────────────────────────────────────────────────
// 8s, not 1.5s: Vite's first request transforms the whole import graph, which
// legitimately takes seconds on a cold start. A tight timeout here reported
// "web down" for a server that was serving fine — the same false-negative shape
// as probing the wrong loopback family.
const web = await get(WEB_URL, 8000);
if (web) {
  out.push(`  web       up on localhost:${WEB}`);
  const v4 = await get(`http://127.0.0.1:${WEB}`, 1000);
  out.push(
    v4
      ? '            127.0.0.1 also answers'
      : '            127.0.0.1 refuses — Vite is on ::1, use localhost',
  );
} else {
  out.push('  web       down');
}

// ── fleet ───────────────────────────────────────────────────────────────────
const snapRes = await get(`${DAEMON}/api/snapshot`);
if (snapRes) {
  const s = await snapRes.json();
  const byStatus = {};
  for (const a of s.agents) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  const breakdown =
    Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${v} ${k}`)
      .join(', ') || 'none';

  out.push('');
  out.push(`${pad('projects')}${s.projects.length}`);
  out.push(`${pad('jobs')}${s.jobs.length}`);
  out.push(`${pad('agents')}${s.agents.length}  (${breakdown})`);
  out.push(
    `${pad('blocked')}${s.pending.length}${s.pending.length > 0 ? '   <-- needs you' : ''}`,
  );
  if (s.pending.length > 0) {
    for (const p of s.pending) {
      const waited = Math.round((Date.now() - Date.parse(p.createdAt)) / 1000);
      out.push(
        `            ${p.projectName} · ${p.agentRole} · ${p.toolName} · ${p.blockMode} · ${waited}s`,
      );
    }
  }
  out.push(`${pad('servers')}${s.servers.length}`);
  out.push(`${pad('slots')}${s.slots.used}/${s.slots.total} live`);
  out.push(`${pad('spend')}$${s.costToday.toFixed(2)} today`);
}

out.push('');
console.log(out.join('\n'));
