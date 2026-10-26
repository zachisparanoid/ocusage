# ocusage — design

_2026-09-06. `ocusage` ("OpenAI Codex usage") is the Codex CLI counterpart to
[ccusage](https://github.com/zachisparanoid/ccusage): same command surface,
same exit codes, same `--json` contract style, same look — with Codex's local
state and usage service underneath instead of Claude Code's._

## Goal

Run `ocusage` and instantly see how much of the Codex 5-hour and weekly
allowances are used and when they reset, using the login Codex already has.
Nothing to configure, no API key, works on macOS/Linux/Windows.

## Ground truth (verified against a real install, Codex CLI 0.153.4)

Everything below was reverse-engineered from the actual machine — `strings`
on the native `codex` binary, real files under `~/.codex`, and live
authenticated requests — not from published docs (which don't cover any of
this).

### Home directory

`$CODEX_HOME` if set (the same override Codex itself honors), else `~/.codex`.

### Credentials — `<home>/auth.json`

```jsonc
{
  "auth_mode": "chatgpt", // also seen in the binary: "apikey", "chatgpt_auth_tokens"
  "OPENAI_API_KEY": null, // set instead of tokens when signed in with an API key
  "tokens": {
    "id_token": "<JWT>", // short-lived (1h) — only its claims are useful
    "access_token": "<JWT>", // ~10 days; the bearer token for the usage service
    "refresh_token": "<opaque>",
    "account_id": "<uuid>",
  },
  "last_refresh": "2026-08-28T16:55:39.090600661Z",
}
```

The access token is a JWT whose payload carries everything the header needs
(decoded without signature verification — we only read, never trust):

- `exp` — epoch **seconds** (not ms like Claude Code's `expiresAt`).
- `https://api.openai.com/auth` → `chatgpt_plan_type` (`"plus"`, `"pro"`,
  `"team"`, …), `chatgpt_account_id`.
- `https://api.openai.com/profile` → `email`.

The id token has `email`, `name` and the same auth claim; it's a fallback
for identity only.

### Live usage service

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <access_token>
ChatGPT-Account-Id: <account_id>     # optional — identical result without it
```

Any User-Agent is accepted (tested with `ocusage/0.1.0` and with none), so
ocusage identifies as itself. A bad or expired token gets `401` with
`{"detail": "Could not parse your authentication token. …"}`; no token gets
`401 {"detail": "Unauthorized"}`. Real captured response:

```jsonc
{
  "user_id": "user-…",
  "account_id": "<uuid>",
  "email": "you@example.com",
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 7,
      "limit_window_seconds": 18000,
      "reset_after_seconds": 17836,
      "reset_at": 1788698795,
    },
    "secondary_window": {
      "used_percent": 24,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 490214,
      "reset_at": 1789171173,
    },
  },
  "code_review_rate_limit": null, // presumably the same {allowed, limit_reached, primary_window, secondary_window} shape
  "additional_rate_limits": null, // shape unobserved — parsed defensively
  "model_usage": {
    "gpt-6-astra": { "available": true, "available_at": null, "credits_would_enable": false },
  },
  "credits": {
    "has_credits": false,
    "unlimited": false,
    "overage_limit_reached": false,
    "balance": "0",
    "approx_local_messages": [0, 0],
    "approx_cloud_messages": [0, 0],
  },
  "spend_control": { "reached": false, "individual_limit": null },
  "rate_limit_reached_type": null,
  "promo": null,
  "rate_limit_reset_credits": { "available_count": 2, "applicable_available_count": 0 },
}
```

`reset_at` is epoch seconds. Percentages are the only measurement — OpenAI
never exposes a token cap, so `limit` is always `null` in the report.

### Session rollouts — `<home>/sessions/YYYY/MM/DD/rollout-<local-ts>-<uuid>.jsonl`

One JSON object per line: `{ timestamp (UTC ISO), type, payload }`. The line
that matters is `type: "event_msg"` with `payload.type: "token_count"`:

```jsonc
{ "timestamp": "2026-09-04T23:30:36.759Z", "type": "event_msg", "payload": {
  "type": "token_count",
  "info": {                                   // may be null (rate-limit-only update)
    "total_token_usage": { "input_tokens": 20244, "cached_input_tokens": 11392, "output_tokens": 372, "reasoning_output_tokens": 0, "total_tokens": 20616 },
    "last_token_usage":  { … same keys … },
    "model_context_window": 258400 },
  "rate_limits": {                            // may be null
    "limit_id": "codex", "limit_name": null,
    "primary":   { "used_percent": 3,  "window_minutes": 300,   "resets_at": 1788580828 },
    "secondary": { "used_percent": 88, "window_minutes": 10080, "resets_at": 1788800843 },
    "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
    "plan_type": "plus", "rate_limit_reached_type": null, "individual_limit": null, "spend_control_reached": null } } }
```

Two facts that shape the local source:

1. **Every `token_count` event carries a full rate-limit snapshot**, and the
   shape has been identical from Codex 0.137.0 through 0.153.x. So the local
   fallback can show _real percentages_ (as of the last time Codex talked to
   the server), not just a token count. Older builds may have used
   `resets_in_seconds` instead of `resets_at`; both are accepted.
2. **`token_count` events are duplicated** — the same cumulative
   `total_token_usage` is re-emitted on some events (1–11 per file observed),
   so summing `last_token_usage` over-counts by up to ~5%. Tokens are counted
   as the _delta_ of `total_token_usage.total_tokens` between consecutive
   events in a file (duplicate ⇒ delta 0; a reset ⇒ take the new total). This
   also matches the `tokens_used` figure Codex keeps in its own SQLite state.

Newer builds (0.153+) also write `token_usage_record` lines with a
per-response `usage` and `response_id`; older ones don't, so ocusage relies
only on `token_count`.

## Architecture

Identical layout to ccusage so the two codebases stay mutually legible:

```
src/
  cli.ts                 commander setup, routing, top-level error boundary
  commands/              show (default), json, watch
  core/
    paths.ts             CODEX_HOME resolution, auth.json / sessions paths
    credentials.ts       auth.json + JWT claim decoding → ResolvedCredentials
    apiSource.ts         wham/usage fetch + parsing → RawUsageData
    localSource.ts       rollout scan: latest rate-limit snapshot + token deltas
    usageSource.ts       auto → api (+ local token enrichment) → local fallback
    normalize.ts         the only place percentUsed is computed; window ordering
    resetMath.ts         "resets in 3d 4h" (pure)
    version.ts
  render/                colors (palette), bar, format, dashboard (pure)
  types.ts               UsageReport / UsageWindow / CliOptions contract
  errors.ts              typed errors → exit codes
```

## Windows

| id                                    | source field                  | label                                     | compact                   |
| ------------------------------------- | ----------------------------- | ----------------------------------------- | ------------------------- |
| `session_5h`                          | `rate_limit.primary_window`   | Current 5-hour window                     | `5-hour`                  |
| `week_all`                            | `rate_limit.secondary_window` | Current week                              | `weekly`                  |
| `code_review_5h` / `code_review_week` | `code_review_rate_limit.*`    | Code review (5-hour) / Code review (week) | `review-5h` / `review-wk` |
| `<limit_id>_5h` / `<limit_id>_week`   | `additional_rate_limits[]`    | `<limit_name> (…)`                        | derived                   |

Ids reuse ccusage's names for the same concepts (`session_5h`, `week_all`) so
one status-bar script can read both tools' `--json`. Ids are derived from the
window length: 18000 s → `5h`, 604800 s → `week`, anything else →
`<seconds>s`, so a changed window size degrades to a still-stable id rather
than a wrong label.

Every window: `unit: "ratio"`, `limit: null`, `percentUsed` from the server,
plus two Codex-specific fields:

- `windowSeconds` — the window length.
- `localTokens` — tokens counted from local rollouts inside
  `[resetsAt − windowSeconds, now]` (null if the scan found nothing or
  failed). Shown as `~1.2M tokens` in the detail line — the only way to get a
  feel for what a percentage point costs, since the cap itself is secret.

## Data-source policy

- **`auto`** (default): credentials present and JWT not expired → live API.
  On success, rollouts are scanned to fill `localTokens` (best effort; any
  failure just leaves it null). Missing/expired credentials, network
  failure, 401, or a response with no `rate_limit` → local fallback with a
  warning explaining why.
- **`local`**: newest rate-limit snapshot across rollouts modified in the last
  7 days (by event timestamp, not file order — a long-running old session
  can hold the newest event). Windows come from the snapshot, `estimated:
true`, with a warning that says how old it is. A window whose `resets_at`
  is already past shows 0% plus a warning that it has reset since the
  snapshot. No snapshot at all → trailing 5h / 7d token windows (unit
  `tokens`, 0%, `resets: unknown`) exactly like ccusage's fallback. Nothing
  at all → exit 2.
- **`api`**: forced; never falls back.

Tokens are never refreshed by ocusage (that would mean writing `auth.json`
underneath a possibly-running Codex). An expired token just means "run Codex
once" — it refreshes on use.

## Report contract

```jsonc
{
  "account": { "email": "you@example.com", "plan": "Plus" },
  "credits": { "hasCredits": false, "unlimited": false, "balance": "0" },  // null when unknown
  "windows": [ { "id", "label", "used", "limit", "unit", "percentUsed", "resetsAt",
                 "windowSeconds", "localTokens", "source", "estimated" } ],
  "fetchedAt": "<run time>",
  "asOf": "<time the numbers reflect: run time for api, snapshot time for local>",
  "source": "api" | "local",
  "warnings": []
}
```

Warnings also carry server flags when set: `limit_reached` /
`rate_limit_reached_type`, `allowed: false`, `spend_control.reached`, and any
`model_usage` entry with `available: false`.

## Rendering

Same layout and palette as ccusage; accent is OpenAI green `#10A37F` instead
of coral. Title `Codex · usage`. Header identity line appends
`· credits <balance>` when the account has credits (or `· unlimited credits`).
Detail line: `resets in 4h 57m · ~1.2M tokens`.

## Errors / exit codes

Same classes and codes as ccusage (2 not authenticated / no data, 3 network,
1 unexpected); messages point at `codex login`.

## Testing

vitest, mirroring ccusage's suites. Fixtures: `auth.sample.json` (a
synthetic JWT with far-future `exp`), `rollout.sample.jsonl` (duplicates, a
null-info event, an out-of-window event, a corrupt line; the legacy
`resets_in_seconds` form is covered inline), and the real captured `wham/usage` shape inline
in `apiSource.test.ts`. Dashboard output is snapshot-tested plain and colored.
