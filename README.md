# zenith-jobs

An agent skill for submitting, watching and cancelling GPU training jobs on a **Zenith** platform (personal API), plus a tiny zero-dependency CLI (`scripts/zn.mjs`) that talks to it.

Zenith's personal API is token-scoped and read-only by default; you create a personal API token in the console, then scripts/agents can list offerings, check per-zone capacity, submit training jobs, read logs and metrics, and cancel.

## Requirements

- Node.js ≥ 20 (uses built-in `fetch`; no dependencies)
- A Zenith account with an assigned compute offering
- A personal API token with these scopes:
  `jobs:create`, `jobs:read`, `jobs:cancel`, `operations:read`, `catalog:read`
  (recommended: `profile:read`, `projects:read`)

## Setup

1. Console → avatar menu → **Account settings → API Token → New**. Pick the scopes above. The plaintext is shown only once.
2. Store it locally (never in a repo or command argument):

```bash
mkdir -p ~/.zenith && chmod 700 ~/.zenith
read -rsp "token: " T && printf '%s' "$T" > ~/.zenith/token && unset T
chmod 600 ~/.zenith/token
```

3. Point the client at your platform origin (default: `https://zenith.bza.edu.cn/pt/api2`):

```bash
export ZENITH_ORIGIN=https://your-host.example.com/pt/api2
```

The token is read from `$ZENITH_API_TOKEN` or `~/.zenith/token`; the origin from `$ZENITH_ORIGIN`.

## Install as an agent skill

Copy this directory into a skills location your agent scans, e.g.:

```bash
cp -r . ~/.agents/skills/zenith-jobs          # user-level
cp -r . <project>/.agents/skills/zenith-jobs  # project-level
```

`SKILL.md` carries the routing description; agents load it when a task involves submitting or checking training jobs.

## Usage

```
ZN="node scripts/zn.mjs"

$ZN caps | whoami | quota | hours | projects
$ZN offerings [--project-id ID] [--full]
$ZN images <offering> [--workload JOB|DEV_INSTANCE] [--resource-zone Z] [--q KW] [--page-size N] [--all]
$ZN zones <offering> [--workload-type job] [--execution-class C]
$ZN admission <offering> --workload-type job --resource-zone Z [--project-id ID]
$ZN job-create <offering> --name N --entrypoint "CMD" --intent K \
      [--project-id ID] [--image-id ID] [--resource-zone Z] \
      [--execution-class standard|low_priority] [--funding-mode MODE] [--replicas N] [--wait SEC]
$ZN jobs | job <id> | logs <id> [--lines N] [--worker W]
$ZN replicas <id> | metrics <id> [--minutes N]
$ZN job-cancel <id> --intent K | op <operation-id>
```

Typical flow: `offerings` → `zones` (per-zone capacity) → `admission` (read-only precheck) → `job-create` with an explicit `--intent` → `jobs` / `logs`.

JSON goes to stdout, diagnostics to stderr. Exit codes follow the platform CLI: `2` usage, `3` auth, `4` permission, `5` conflict, `6` network/rate limit, `7` pending/unknown, `1` internal.

## Notes

- `--intent` is the idempotency key. Re-sending the same intent with the same parameters resumes the original operation; the same intent with different parameters is rejected locally. Keep the intent stable across network failures — a new key submits a second job.
- `202` means accepted, not running. `PENDING` can last minutes to hours.
- `image_id` must come from the offering's own image catalog and match the resource zone. If omitted, the platform picks a default and no API will tell you afterwards which image ran.
- Job logs come back newest-first with the text in `body`.
- Training jobs have no interactive terminal and cannot be SSH'd into; write checkpoints to persistent storage.
- Nothing here grants platform or project administration. Only the operations your token scopes allow are reachable.

## License

MIT — see [LICENSE](LICENSE).
