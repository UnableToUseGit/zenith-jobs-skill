#!/usr/bin/env node
// Minimal Zenith personal API client. No dependencies. Node >= 20.
// Token: $ZENITH_API_TOKEN, or $ZENITH_TOKEN_FILE, or ~/.zenith/token (chmod 600).
// Origin: $ZENITH_ORIGIN, default https://zenith.bza.edu.cn/pt/api2
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ORIGIN = (process.env.ZENITH_ORIGIN || 'https://zenith.bza.edu.cn/pt/api2').replace(/\/$/, '');
const HOME = join(homedir(), '.zenith');
const TOKEN_FILE = process.env.ZENITH_TOKEN_FILE || join(HOME, 'token');
const JOURNAL = join(HOME, 'journal.json');

const EX = { usage: 2, auth: 3, perm: 4, conflict: 5, network: 6, pending: 7, internal: 1 };

function die(msg, code = EX.internal) {
  console.error(msg);
  process.exit(code);
}

function token() {
  const fromEnv = process.env.ZENITH_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(TOKEN_FILE)) die(`no token: set ZENITH_API_TOKEN or write ${TOKEN_FILE} (chmod 600)`, EX.auth);
  const t = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!t) die(`empty token file: ${TOKEN_FILE}`, EX.auth);
  return t;
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; }
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function exitFor(status) {
  if (status === 401) return EX.auth;
  if (status === 403) return EX.perm;
  if (status === 409 || status === 428) return EX.conflict;
  if (status === 429 || status === 503 || status >= 500) return EX.network;
  return EX.internal;
}

async function call(method, path, { body, idempotencyKey } = {}) {
  const headers = { authorization: `Bearer ${token()}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  let res;
  try {
    res = await fetch(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    die(`network error: ${e.message}`, EX.network);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const err = json ?? { raw: text.slice(0, 800) };
    console.error(JSON.stringify({ status: res.status, ...err }, null, 2));
    const ra = err.retry_after_seconds ?? res.headers.get('retry-after');
    if (ra) console.error(`retry-after: ${ra}s`);
    process.exit(exitFor(res.status));
  }
  return json;
}

const emit = (v) => console.log(JSON.stringify(v, null, 2));

function journal() {
  if (!existsSync(JOURNAL)) return {};
  return JSON.parse(readFileSync(JOURNAL, 'utf8'));
}

function saveJournal(j) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify(j, null, 2), { mode: 0o600 });
  try { chmodSync(JOURNAL, 0o600); } catch { /* ignore */ }
}

// One stable key per intent. Same intent + same request => same key (safe retry).
// Same intent + different request => hard fail instead of creating a second machine.
function intentKey(intent, request) {
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16);
  const j = journal();
  const prev = j[intent];
  if (prev) {
    if (prev.hash !== hash) die(`intent "${intent}" already used with a different request; refusing to reuse`, EX.conflict);
    return prev.key;
  }
  const key = `${intent}-${hash}`.slice(0, 190);
  j[intent] = { key, hash, at: new Date().toISOString() };
  saveJournal(j);
  return key;
}

const status = (i) => i.unified_status || i.status;

async function listInstances(scope = 'mine') {
  const r = await call('GET', `/ai/instances?scope=${scope}&page_size=100`);
  return r.instances ?? [];
}

// Report every resource zone of one offering with the facts the agent needs to
// decide where to submit: route support, worker status, per-zone admission
// result and observed queue capacity. This command never ranks, picks, reserves
// or submits: the decision belongs to the caller.
async function zoneReport(offeringId, { workloadType = 'job', executionClass = 'standard', projectId } = {}) {
  const q = projectId ? `?project_id=${projectId}` : '';
  const full = await call('GET', `/compute-offerings${q}`);
  const o = (full.offerings ?? []).find((x) => x.id === offeringId);
  if (!o) die(`unknown offering id: ${offeringId}`, EX.usage);
  const caps = o.capabilities_by_resource_zone ?? {};
  const createKey = workloadType === 'job' ? 'job_create' : 'instance_create';
  const classKey = workloadType === 'job' ? 'job_execution_classes' : 'instance_execution_classes';
  const rows = [];
  for (const zone of Object.keys(caps).sort((a, b) => Number(a) - Number(b))) {
    const cap = caps[zone] ?? {};
    const classes = Array.isArray(cap[classKey]) ? cap[classKey] : null;
    const supported = cap[createKey] !== false && (classes === null || classes.length === 0 || classes.includes(executionClass));
    const row = {
      zone,
      supported,
      worker_status: cap.worker_status ?? null,
      execution_classes: classes,
    };
    if (!supported) {
      row.status = 'no_route';
      row.reason = cap[createKey] === false ? 'workload_not_routed_here' : 'execution_class_not_offered';
      rows.push(row);
      continue;
    }
    // Read-only admission: confirms permission, quota, routing and observed
    // capacity for this zone. It does not reserve cards.
    const body = { workload_type: workloadType, resource_zone: zone, execution_class: executionClass };
    if (projectId) body.project_id = projectId;
    const a = await call('POST', `/compute-offerings/${offeringId}/admission`, { body });
    const route = (a.routes ?? [])[0] ?? {};
    const c = route.capacity ?? {};
    rows.push({
      ...row,
      status: a.status,
      reason: a.reason_code ?? route.reason_code ?? null,
      retryable: a.retryable ?? null,
      vendor: route.vendor ?? null,
      free_gpus: c.free_gpus ?? null,
      total_gpus: c.total_gpus ?? null,
      available_gpus: route.available_gpus ?? null,
      protected_gpus: route.protected_gpus ?? null,
      queue_state: c.queue_state ?? null,
      capacity_status: c.status ?? null,
      capacity_observed_at: c.observed_at ?? null,
    });
  }
  return { offering: o, workload_type: workloadType, execution_class: executionClass, zones: rows };
}

function pick(body, keys) {
  const out = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`zn.mjs <cmd>

  caps                        identity, token scopes, resource zones
  whoami | quota | hours      profile:read
  projects
  offerings [--project-id ID] catalog:read
  admission <offering> [--workload-type instance|job] [--project-id ID]
            [--resource-zone Z] [--execution-class standard|low_priority]
            [--storage-mode MODE] [--replicas N]   (read-only precheck)
  zones <offering> [--workload-type job|instance] [--execution-class C]
            [--project-id ID]        per-zone facts: route, worker, capacity
  images <offering> [--workload JOB|DEV_INSTANCE] [--resource-zone Z]
            [--q TEXT] [--page N] [--page-size N] [--all]   catalog:read
  create <offering> --name NAME [--project-id ID] [--resource-zone Z]
            [--storage-mode MODE] [--image-id ID] [--execution-class C]
            [--funding-mode MODE] [--intent NAME] [--wait SECONDS] [--json FILE]
  job-create <offering> --name NAME --entrypoint CMD [--project-id ID]
            [--resource-zone Z] [--execution-class standard|low_priority]
            [--funding-mode MODE] [--replicas N] [--image-id ID]
            [--intent NAME] [--wait SECONDS]
  jobs [--page N] [--page-size N] [--project-id ID]
  job <platform-job-id>
  logs <platform-job-id> [--lines N] [--worker ID]
  replicas <platform-job-id> [--page N] [--page-size N]
  metrics <platform-job-id> [--minutes N] [--replica ID]
  job-cancel <platform-job-id> [--intent NAME]
  list [--scope mine|projects]
  ssh <instance-id>
  start|stop|restart <instance-id> [--intent NAME]
  delete <instance-id> [--intent NAME]
  op <operation-id>
`);
    process.exit(cmd ? 0 : EX.usage);
  }

  switch (cmd) {
    case 'caps': return emit(await call('GET', '/ai/capabilities'));
    case 'whoami': return emit(await call('GET', '/me'));
    case 'quota': return emit(await call('GET', '/me/quota-usage'));
    case 'hours': return emit(await call('GET', '/me/card-hours'));
    case 'projects': return emit(await call('GET', '/projects'));

    case 'offerings': {
      const q = flags['project-id'] ? `?project_id=${flags['project-id']}` : '';
      const r = await call('GET', `/compute-offerings${q}`);
      if (flags.full) return emit(r);
      const rows = (r.offerings ?? []).map((o) => ({
        id: o.id, name: o.name, gpu: `${o.gpu_model}x${o.gpu_count}`,
        class: o.resource_class, card_hours_per_hour: o.card_hours_per_hour,
        available: o.available, job_available: o.job_available,
        project_ids: o.project_ids ?? null,
        dev_enabled: o.project_development_enabled ?? null,
        dev_gpu_limit: o.dev_instance_gpu_limit ?? null,
        zones: o.capabilities_by_resource_zone ? Object.keys(o.capabilities_by_resource_zone) : null,
      }));
      return emit(rows);
    }

    case 'admission': {
      const id = pos[1] ?? die('usage: admission <offering-id>', EX.usage);
      const body = pick({
        workload_type: flags['workload-type'] ?? 'instance',
        project_id: flags['project-id'],
        resource_zone: flags['resource-zone'],
        execution_class: flags['execution-class'],
        storage_mode: flags['storage-mode'],
        replicas: flags['replicas'] ? Number(flags.replicas) : undefined,
        vendor: flags.vendor,
      }, ['workload_type', 'project_id', 'resource_zone', 'execution_class', 'storage_mode', 'replicas', 'vendor']);
      return emit(await call('POST', `/compute-offerings/${id}/admission`, { body }));
    }

    case 'images': {
      const id = pos[1] ?? die('usage: images <offering-id> [--workload JOB] [--resource-zone Z]', EX.usage);
      const pageSize = flags['page-size'] ?? '100';
      const base = () => {
        const q = new URLSearchParams({ page_size: pageSize });
        if (flags.workload) q.set('workload', flags.workload);
        if (flags['resource-zone']) q.set('resource_zone', flags['resource-zone']);
        if (flags.q) q.set('q', flags.q);
        return q;
      };
      const collect = [];
      let page = Number(flags.page ?? '1');
      let total = null;
      for (;;) {
        const q = base();
        q.set('page', String(page));
        const r = await call('GET', `/compute-offerings/${id}/images?${q}`);
        collect.push(...(r.images ?? []));
        if (r.total !== undefined && r.total !== null) total = r.total;
        const exhausted = (r.images ?? []).length < Number(pageSize);
        if (!flags.all || exhausted || collect.length >= 2000) break;
        page += 1;
      }
      return emit({
        offering_id: id,
        workload: flags.workload ?? null,
        resource_zone: flags['resource-zone'] ?? null,
        total: total,
        returned: collect.length,
        // total may lag or be absent on older servers; treat mismatch as "incomplete"
        complete: total === null ? null : collect.length >= total,
        images: collect.map((i) => ({ image_id: i.image_id, name: i.name, kind: i.kind, vendor: i.vendor, source: i.source, resource_zone: i.resource_zone ?? null })),
      });
    }

    case 'zones': {
      const id = pos[1] ?? die('usage: zones <offering-id>', EX.usage);
      const r = await zoneReport(id, {
        workloadType: flags['workload-type'] ?? 'job',
        executionClass: flags['execution-class'] ?? 'standard',
        projectId: flags['project-id'],
      });
      return emit({
        offering: { id: r.offering.id, name: r.offering.name, gpu: `${r.offering.gpu_model}x${r.offering.gpu_count}`, card_hours_per_hour: r.offering.card_hours_per_hour },
        workload_type: r.workload_type,
        execution_class: r.execution_class,
        zones: r.zones,
      });
    }

    case 'create': {
      const id = pos[1] ?? die('usage: create <offering-id> --name NAME', EX.usage);
      const name = flags.name ?? die('--name is required', EX.usage);
      let body = {};
      if (flags.json) body = JSON.parse(readFileSync(flags.json, 'utf8'));
      body = {
        ...body,
        ...pick({
          name,
          project_id: flags['project-id'],
          resource_zone: flags['resource-zone'],
          storage_mode: flags['storage-mode'],
          image_id: flags['image-id'],
          execution_class: flags['execution-class'],
          funding_mode: flags['funding-mode'],
          entry_point: flags['entry-point'],
        }, ['name', 'project_id', 'resource_zone', 'storage_mode', 'image_id', 'execution_class', 'funding_mode', 'entry_point']),
      };
      const intent = flags.intent ?? `create-${id}-${name}`;
      const key = intentKey(intent, body);
      const receipt = await call('POST', `/compute-offerings/${id}/instances`, { body, idempotencyKey: key });
      emit({ intent, idempotency_key: key, receipt });
      if (flags.wait) {
        const limit = Number(flags.wait);
        const started = Date.now();
        const seen = new Set((await listInstances()).map((i) => i.id));
        process.stderr.write(`waiting up to ${limit}s for a new instance named "${name}"\n`);
        while (Date.now() - started < limit * 1000) {
          await new Promise((r) => setTimeout(r, 5000));
          const mine = await listInstances();
          const fresh = mine.filter((i) => !seen.has(i.id) && i.name === name);
          if (fresh.length) {
            emit(fresh);
            if (fresh.some((i) => /RUNNING|running/i.test(status(i) ?? ''))) return;
          }
        }
        console.error('timeout: not RUNNING yet. Re-check with `zn.mjs list`; the operation is not cancelled.');
        process.exit(EX.pending);
      }
      return;
    }

    case 'job-create': {
      const id = pos[1] ?? die('usage: job-create <offering-id> --name NAME --entrypoint CMD', EX.usage);
      const name = flags.name ?? die('--name is required', EX.usage);
      const entrypoint = flags.entrypoint ?? die('--entrypoint is required', EX.usage);
      const body = {
        name,
        entrypoint,
        ...pick({
          project_id: flags['project-id'],
          resource_zone: flags['resource-zone'],
          execution_class: flags['execution-class'],
          funding_mode: flags['funding-mode'],
          replicas: flags.replicas ? Number(flags.replicas) : undefined,
          image_id: flags['image-id'],
          description: flags.description,
        }, ['project_id', 'resource_zone', 'execution_class', 'funding_mode', 'replicas', 'image_id', 'description']),
      };
      const intent = flags.intent ?? `create-job-${id}-${name}`;
      const key = intentKey(intent, body);
      const receipt = await call('POST', `/compute-offerings/${id}/jobs`, { body, idempotencyKey: key });
      emit({ intent, idempotency_key: key, receipt });
      if (!flags.wait) return;
      const limit = Number(flags.wait);
      const started = Date.now();
      const known = new Set(((await call('GET', '/ai/jobs?page_size=100')).jobs ?? []).map((j) => j.id));
      let jobId = flags['job-id'] ?? null;
      while (Date.now() - started < limit * 1000) {
        await new Promise((r) => setTimeout(r, 5000));
        const jobs = (await call('GET', '/ai/jobs?page_size=100')).jobs ?? [];
        const found = jobId ? jobs.find((j) => j.id === jobId) : jobs.find((j) => !known.has(j.id) && j.name === name);
        if (!found) { process.stderr.write('.'); continue; }
        jobId = found.id;
        process.stderr.write(`\n[${((Date.now() - started) / 1000).toFixed(0)}s] ${found.id} ${found.status}\n`);
        if (/SUCCEEDED|FAILED|CANCELLED|STOPPED/i.test(found.status ?? '')) return emit(found);
      }
      console.error(`\ntimeout: job ${jobId ?? '(id unknown)'} not terminal. The job keeps running; cancel with \`job-cancel\`.`);
      process.exit(EX.pending);
    }

    case 'jobs': {
      const q = new URLSearchParams({ page: flags.page ?? '1', page_size: flags['page-size'] ?? '50' });
      if (flags['project-id']) q.set('project_id', flags['project-id']);
      const r = await call('GET', `/ai/jobs?${q}`);
      if (flags.full) return emit(r);
      return emit((r.jobs ?? []).map((j) => ({
        id: j.id, name: j.name, status: j.status, class: j.execution_class,
        gpu: j.gpu_type ? `${j.gpu_type}x${j.gpu_count}` : null,
        replicas: j.replicas ?? null, zone: j.zone_id ?? null, ended_at: j.ended_at ?? null,
      })));
    }

    case 'job': {
      const id = pos[1] ?? die('usage: job <platform-job-id>', EX.usage);
      return emit(await call('GET', `/ai/jobs/by-id/${id}`));
    }

    case 'logs': {
      const id = pos[1] ?? die('usage: logs <platform-job-id>', EX.usage);
      const q = new URLSearchParams({ log_num: flags.lines ?? '200' });
      if (flags.worker) q.set('worker_id', flags.worker);
      const r = await call('GET', `/ai/jobs/by-id/${id}/logs?${q}`);
      const meta = { job_status: r.job_status, log_state: r.log_state, returned: r.returned, truncated: r.truncated, pending: r.pending };
      console.error(JSON.stringify(meta));
      const lines = [...(r.lines ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      return console.log(lines.map((l) => (typeof l === 'string' ? l : l.body ?? l.line ?? l.message ?? JSON.stringify(l))).join('\n'));
    }

    case 'replicas': {
      const id = pos[1] ?? die('usage: replicas <platform-job-id>', EX.usage);
      const q = new URLSearchParams({ page: flags.page ?? '1', page_size: flags['page-size'] ?? '50' });
      return emit(await call('GET', `/ai/jobs/by-id/${id}/replicas?${q}`));
    }

    case 'metrics': {
      const id = pos[1] ?? die('usage: metrics <platform-job-id>', EX.usage);
      const q = new URLSearchParams({ minutes: flags.minutes ?? '30' });
      if (flags.replica) q.set('replica', flags.replica);
      const r = await call('GET', `/ai/jobs/by-id/${id}/metrics?${q}`);
      return emit(r);
    }

    case 'job-cancel': {
      const id = pos[1] ?? die('usage: job-cancel <platform-job-id>', EX.usage);
      const intent = flags.intent ?? `cancel-job-${id}`;
      const key = intentKey(intent, { cmd: 'cancel', id });
      return emit(await call('POST', `/ai/jobs/by-id/${id}/cancel`, { idempotencyKey: key }));
    }

    case 'list': return emit(await listInstances(flags.scope ?? 'mine'));

    case 'ssh': {
      const id = pos[1] ?? die('usage: ssh <instance-id>', EX.usage);
      return emit(await call('GET', `/instances/${id}/ssh-access`));
    }

    case 'start':
    case 'stop':
    case 'restart':
    case 'delete': {
      const id = pos[1] ?? die(`usage: ${cmd} <instance-id>`, EX.usage);
      const intent = flags.intent ?? `${cmd}-${id}`;
      const key = intentKey(intent, { cmd, id });
      if (cmd === 'delete') return emit(await call('DELETE', `/ai/instances/${id}`, { idempotencyKey: key }));
      return emit(await call('POST', `/ai/instances/${id}/${cmd}`, { idempotencyKey: key }));
    }

    case 'op': {
      const id = pos[1] ?? die('usage: op <operation-id>', EX.usage);
      return emit(await call('GET', `/operations/${id}`));
    }

    default: die(`unknown command: ${cmd}`, EX.usage);
  }
}

main().catch((e) => die(e.stack ?? String(e)));
