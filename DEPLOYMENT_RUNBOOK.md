# Deployment Runbook — Security Hardening (Phases 1–7)

This walks through promoting the `security/hardening-phases-1-4` branch to
production for `chat.technext.it`. Read it end-to-end before doing
anything; several steps are **breaking** and the wrong order will lock
out every existing user.

| Doc | Use it for |
|---|---|
| [`BREAKING_CHANGES.md`](./BREAKING_CHANGES.md) | The authoritative contract diff (env, JWT, webhooks, attachments). |
| [`FRONTEND_INTEGRATION_CHANGES.md`](./FRONTEND_INTEGRATION_CHANGES.md) | What every client / SPA / tenant frontend has to change. |
| This file | The **order of operations** and the exact commands. |

---

## Audience + style

- "You" = the operator (the human running Dokploy / SSH).
- Every command snippet is **copy-paste runnable** with the noted
  substitutions.
- Every checkbox in §6 must be ✅ before you call the deploy done.

---

## Risk summary (read once, then proceed)

Three changes will instantly break every existing session if you
deploy without coordinating them first. They are the entire reason
this runbook exists.

1. **JWT `aud: "chat-app"`** required → every existing tenant-minted
   token without it 401s.
2. **JWT max TTL 1h** → any token with `exp − iat > 3600s` 401s.
3. **Webhook signatures default ON** → tenant webhook calls without
   `X-Chat-Signature` 401.

Mitigation: ship the tenant-side changes first; only then deploy this
server.

Two more things will break the **deploy itself** if you skip them:

4. `REDIS_PASSWORD` missing → `docker compose` refuses to start.
5. `CORS_ALLOWED_ORIGINS` contains `localhost` or non-https → server
   prints `[env] CORS_ALLOWED_ORIGINS contains non-https / localhost /
   invalid origins in production` and exits 1.

Mitigation: §1 catches both in pre-flight.

---

## 0. Pre-flight (do these on your laptop, today)

### 0.1 Make sure PR #1 has landed and the tag is cut

```sh
# On main, post-merge of security/hardening-phases-1-4
git fetch origin
git checkout main
git pull
git log --oneline -10        # Confirm phases 1-7 commits are present
make tag VERSION=1.3.0       # Or the next semver; tags + pushes
```

Take note of the tag — Dokploy will pull this exact image.

### 0.2 Generate / collect every secret you'll need

Put these in your password manager. **Do not commit any of them.**
Generation commands (re-run if anything ever leaked):

```sh
openssl rand -hex 32        # CENTRIFUGO_*_SECRET, CENTRIFUGO_API_KEY,
                            # MASTER_API_KEY, METRICS_TOKEN
openssl rand -base64 24     # POSTGRES_PASSWORD, REDIS_PASSWORD,
                            # MINIO_ROOT_PASSWORD, CENTRIFUGO_ADMIN_PASSWORD
openssl rand -base64 32     # JWT_SECRET_ENCRYPTION_KEY (must decode to 32 B)
npx web-push generate-vapid-keys
```

⚠️ Verify the entropy guard before you paste `MASTER_API_KEY`:
```sh
python3 -c "import sys; k=sys.argv[1]; print(len(set(k)), 'unique chars (need >=16)')" YOUR_KEY
```

### 0.3 Rotate the three exposed-in-prod tenants

`DEV_MINT_ENABLED=true` was set in production with
`ALLOW_DEV_MINT_TENANTS=default,demo_acme,demo_beta`. Until Phase 1
landed, anyone on the internet could mint a JWT as **any user** of
those three tenants.

Treat this as a confirmed incident:

```sh
# Replace <MASTER> with the CURRENT (pre-deploy) master key.
for T in default demo_acme demo_beta; do
  curl -X POST -H "Authorization: Bearer <MASTER>" \
       https://chat.technext.it/api/admin/tenants/$T/api-keys
  curl -X POST -H "Authorization: Bearer <MASTER>" \
       https://chat.technext.it/api/admin/tenants/$T/jwt-secret/rotate
done
```

Distribute the new `apiKey` + `jwtSecret` to each tenant's backend
**out of band** (encrypted email, password manager, etc.). After this
runs:
- Every existing user-JWT is invalid (signature mismatch) → **users
  log out on next request**. That window happens BEFORE the §3 deploy
  anyway, so it's not extra.
- Every webhook the tenant was sending with the old `apiKey` 401s.
  Coordinate the cutover so the tenant ships the new key + signer at
  the same time.

### 0.4 Coordinate with tenant backends — the JWT cutover

Send this to every tenant backend team:

> Subject: chat.technext.it — required JWT changes on or before
> `<deploy date>`
>
> Two mandatory mint-side changes:
>
> 1. Add `audience: "chat-app"` to every user JWT you sign.
>    ```ts
>    jwt.sign(payload, tenantJwtSecret, {
>      issuer: tenantId,
>      audience: "chat-app",
>      algorithm: "HS256",
>      expiresIn: 3600,   // max 1h; refresh more often
>    });
>    ```
> 2. Reduce TTL to ≤ 3600 s and refresh tokens proactively (under
>    ~5 min before `exp`).
>
> Also: ship the webhook HMAC signer described in `BREAKING_CHANGES.md
> §2.3` if you call `/api/webhooks/*`.

Get confirmation in writing from every tenant before §3.

### 0.5 Find your Traefik CIDR for `TRUST_PROXY_CIDRS`

```sh
# On the Dokploy host:
docker network inspect dokploy-network \
  | jq -r '.[].IPAM.Config[].Subnet'
# Example output: 172.17.0.0/16
```

Save that — it goes into the env in §1.

### 0.6 Stand up the same branch on staging

```sh
# On staging (or a throwaway clone):
git checkout v1.3.0
# Use a staging copy of prod data if you can; an empty DB works for
# smoke testing but won't catch migration-on-real-data issues.
docker compose run --rm migrate
docker compose up -d
# Run the smoke script:
API_BASE_URL=https://staging.chat.example.com \
  DEV_TENANT_ID=default \
  pnpm --filter @chat-app/server exec tsx scripts/security-smoke.ts
```

Every ❌ MUST be fixed before §3. Don't promote a red staging.

---

## 1. Prepare the production env

Replace your current Dokploy env panel with the version below, after
the three substitutions:

- `<YOUR_TRAEFIK_CIDR>` (from §0.5)
- `<MASTER_API_KEY>` (freshly generated; ≥43 chars, ≥16 unique)
- `<REDIS_PASSWORD>` (freshly generated)

A reference of the full file is in [`BREAKING_CHANGES.md`](./BREAKING_CHANGES.md);
the canonical short list of what changed vs. your old env is in this
runbook's appendix at §10.

> The boot guards will refuse to start if you forget to:
> - remove `http://localhost:3000` from `CORS_ALLOWED_ORIGINS`,
> - remove `DEV_MINT_ENABLED` and `ALLOW_DEV_MINT_TENANTS`,
> - add `REDIS_PASSWORD`,
> - generate a `MASTER_API_KEY` with ≥16 unique chars.

---

## 2. The migration prerequisite

Phases 1–7 ship **four** Prisma migrations. They are all additive
(`ADD COLUMN`, `CREATE TABLE`) — safe to apply ahead of the server
deploy.

| Migration | What it adds | Reversible? |
|---|---|---|
| `20260519100000_tokens_valid_after_and_deleted_externals` | `User.tokensValidAfter`, `DeletedExternalId` table | Yes (drop) |
| `20260520100000_attachment_object_key` | `Attachment.objectKey` | Yes |
| `20260522100000_tenant_storage_quota` | `Tenant.storageQuotaBytes` | Yes |
| `20260522120000_admin_audit_log` | `AdminAuditLog` table | Yes |

Apply them **before** the server image rolls:

```sh
# In a Dokploy one-shot task or SSH'd onto the host:
docker compose run --rm migrate
# Watch the output for "Database migration: 0 unapplied" or
# "Applied N migrations".
```

If any one of these fails, **STOP**. Do not deploy the new server.
Old server keeps running fine without the new columns/tables.

---

## 3. The deploy itself (low-traffic window)

### 3.1 Order of operations

```
1. Confirm §0.3 rotation is done and tenants are using new keys ✅
2. Confirm tenants are minting `aud: "chat-app"` + 1h TTL JWTs ✅
3. Paste the new env into Dokploy's panel + save ✅
4. Run `docker compose run --rm migrate` (or rely on Dokploy's
   pre-deploy step if you've configured one) ✅
5. Click Deploy in Dokploy (rolls server + web together) ✅
6. Watch `docker compose logs -f server web` for 60 seconds. The
   server should print:
       server listening { "port": 3001 }
   and NOT print:
       [env] CORS_ALLOWED_ORIGINS contains ...
       [tenant] legacy NULL apiKeyPrefix rows detected ...
```

### 3.2 The boot canaries

The startup is idempotent and runs three guards. If you see any of
these, the server has exited 1 — **rollback immediately** (see §5):

| Log line | Likely cause |
|---|---|
| `[env] PUBLIC_URL is required in production` | Missed renaming `BETTER_AUTH_URL` → `PUBLIC_URL`. |
| `[env] CORS_ALLOWED_ORIGINS contains non-https / localhost / invalid origins` | A non-https or `localhost` entry in the allowlist. |
| `Invalid environment variables ... CLAMAV_PORT ... Too small` | Empty `CLAMAV_PORT` with the older schema build (shouldn't happen on this tag, but if it does, leave both `CLAMAV_HOST` and `CLAMAV_PORT` empty entirely — not even the var name). |
| `[env] MASTER_API_KEY is too low-entropy` | Regenerate with `openssl rand -hex 32`; verify ≥16 unique chars. |
| `[env] JWT_SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes` | Bad base64; regenerate with `openssl rand -base64 32`. |

---

## 4. Verification — must-do checklist

Run these in order. Any ❌ = consider it failed; either rollback (§5)
or fix forward fast.

### 4.1 Smoke (one minute)

```sh
curl -s https://chat.technext.it/livez
# expect: {"status":"ok"}

curl -s https://chat.technext.it/api/readyz
# expect: HTTP 200, body {"status":"ok"}

curl -sI https://chat.technext.it/api/livez | grep -i -E 'strict-transport|x-content|content-security'
# expect: HSTS max-age=63072000; CSP default-src 'none'; X-Content-Type-Options nosniff
```

### 4.2 Auth + token contract

```sh
# Pick a real tenant whose backend you've coordinated with.
# Decode their freshly-minted JWT at jwt.io and verify:
#   - aud === "chat-app"
#   - exp - iat <= 3600
#   - iss === <tenantId>
```

### 4.3 The full security smoke (3 minutes)

```sh
API_BASE_URL=https://chat.technext.it \
  DEV_TENANT_ID=default \
  pnpm --filter @chat-app/server exec tsx scripts/security-smoke.ts
```

Every check ✅. The push-subscribe IDOR may say "skipped" if VAPID
isn't configured.

### 4.4 The end-to-end browser walk

Open `https://chat.technext.it` in an incognito window and:

- [ ] Sign in via the persona picker (or however tenants surface this).
- [ ] Send a text message — it appears in a second tab in real time.
- [ ] Send an **image attachment** — it renders in the bubble. Open
      DevTools → Network → confirm `/api/attachments/<id>/view` returns
      `{ "url": ..., "expiresIn": ... }` (JSON, not 302).
- [ ] Click "Download" on an attachment — the file actually downloads.
- [ ] Settings → "Change photo" → upload an avatar — it shows up in
      another user's view (i.e. the public `avatars/*` prefix works).
- [ ] Settings → "Sign out everywhere" → confirm modal → you're booted.
- [ ] DELETE /me via curl with a stale token → next request returns
      **410 Gone**; in the browser, the page navigates to
      `/account-deleted`.

### 4.5 Centrifugo / Realtime

- [ ] `wscat -c "wss://chat.technext.it/connection/websocket"` →
      connection works once you send a connect token. (Or just verify
      via DevTools → Network → WS that the websocket upgrades cleanly.)
- [ ] In a multi-user conversation, kick a member from another browser
      → the kicked user loses access **immediately**, not after 10
      minutes. (Phase 4: force-unsubscribe + 30s subscription token.)

### 4.6 Audit log is recording

```sh
docker compose exec postgres psql -U chatapp chatapp -c \
  "SELECT id, action, tenant_id, actor_ip, created_at
     FROM admin_audit_log
     ORDER BY created_at DESC LIMIT 20;"
```
You should see the rows from §0.3's rotation. If you don't, the
`AdminAuditLog` table wasn't created or the audit write is failing —
check `docker compose logs server | grep admin-audit`.

### 4.7 Observability

- [ ] `curl -H "Authorization: Bearer $METRICS_TOKEN" https://chat.technext.it/metrics`
      returns Prometheus text.
- [ ] `curl https://chat.technext.it/metrics` returns **404** (gated).
- [ ] Confirm your Prometheus scraper has been updated to send the
      bearer.

---

## 5. Rollback

### What rolls back cleanly

- **The server image** — redeploy the previous tag. Old code ignores
  the new columns/tables (they're additive). All four migrations stay
  in place; that's intentional.
- **Tenant credentials rotated in §0.3** — those are the new state;
  rolling the server back does NOT restore the old api-key/jwt-secret.
  Tenants must continue using the new ones.

### What does NOT roll back

- **The MinIO bucket privacy.** Once `mc anonymous set-json` applied
  the new policy, old clients pointing at `attachment.url` will keep
  getting 403 until they're updated to use `/view`. If you must
  rollback **and** keep old clients working, run on the host:
  ```sh
  docker compose exec minio mc anonymous set download local/chatapp
  ```
  Aware this re-opens the C1 finding.
- **GDPR tombstones written.** Deleted users stay tombstoned for 30
  days; rolling the server back doesn't unwrite the row. You can
  manually `DELETE FROM deleted_external_id WHERE …` if needed.

### Rollback procedure

```sh
# 1. In Dokploy, redeploy the previous tag (e.g. v1.2.7).
# 2. The new env can stay (old server ignores the new vars).
# 3. Old clients: same as before; nothing to do.
# 4. New clients (post-update apps/web): MUST be reverted in lockstep
#    or they'll keep hitting /view (404 on old server) instead of
#    rendering attachment.url directly.
```

---

## 6. Post-deploy follow-ups (do within 7 days)

- [ ] **Flip `WEBHOOK_SIGNATURE_REQUIRED=true`** once every tenant has
      shipped the HMAC signer.
- [ ] **Set `TRUST_PROXY_CIDRS`** to your Traefik CIDR (if you left it
      empty during the initial deploy, the numeric `TRUST_PROXY=2`
      hopcount is functional but spoofable).
- [ ] **Enable the CI workflow** as required status checks on PRs:
      Settings → Branches → Add rule → require `gitleaks (secret scan)`,
      `pnpm audit (high+critical)`, `typecheck + unit tests (server)`,
      `semgrep (SAST)`.
- [ ] **Bring up the ClamAV sidecar** if you handle untrusted file
      uploads. Uncomment the `clamav` block + `clamav_data` volume in
      `docker-compose.yml`, set `CLAMAV_HOST=clamav` and
      `CLAMAV_PORT=3310` in env, redeploy.
- [ ] **Re-run `scripts/security-smoke.ts`** weekly as part of your
      release cadence; treat any ❌ as a release-blocker.
- [ ] **Audit the `admin_audit_log` table** monthly. Anything you
      didn't authorize means a leaked `MASTER_API_KEY`.

---

## 7. Failure-mode quick reference

| Symptom | First thing to check |
|---|---|
| Every authenticated request 401s after deploy | Tenant backends still mint pre-`aud` JWTs. Did §0.4 confirm cutover? |
| Specific tenant's webhooks 401 | Their `apiKey` was rotated in §0.3 but they're still sending the old one. Or they haven't shipped the HMAC signer and `WEBHOOK_SIGNATURE_REQUIRED=true`. |
| Image attachments show as broken | apps/web wasn't deployed in lockstep. Verify the bundle on `/_next/static/...` matches the server tag. |
| Avatars don't render cross-user | Bucket policy didn't apply. SSH into the host, `docker compose logs minio-init` should show `Access permission ... is set from /tmp/avatars-policy.json`. If missing, `docker compose restart minio-init`. |
| Random 410 Gone for users who shouldn't be deleted | The `DeletedExternalId` migration ran, then a user called `DELETE /me`. Tombstones expire after 30 days. To force-clear a single user: `DELETE FROM deleted_external_id WHERE tenant_id=$1 AND external_id=$2;` |
| `/metrics` returns 401/404 to Prometheus | `METRICS_TOKEN` set on server but scraper isn't sending `Authorization: Bearer <token>`. Update scrape config. |
| Realtime events not arriving | Centrifugo's Redis engine URL is wrong. Should be `redis://:${REDIS_PASSWORD}@redis:6379/0`. Check `docker compose logs centrifugo`. |

---

## 8. Phase 0 secret-rotation tracker

Use this table while you do §0.2-0.3 so you don't lose track:

| Secret | Rotated? | When | Who |
|---|---|---|---|
| `POSTGRES_PASSWORD` | ☐ | | |
| `REDIS_PASSWORD` (new) | ☐ | | |
| `MINIO_ROOT_PASSWORD` | ☐ | | |
| `CENTRIFUGO_TOKEN_SECRET` | ☐ | | |
| `CENTRIFUGO_API_KEY` | ☐ | | |
| `CENTRIFUGO_ADMIN_PASSWORD` | ☐ | | |
| `CENTRIFUGO_ADMIN_SECRET` | ☐ | | |
| `MASTER_API_KEY` | ☐ | | |
| `JWT_SECRET_ENCRYPTION_KEY` | ☐ | | |
| `METRICS_TOKEN` (new) | ☐ | | |
| VAPID keypair | ☐ | only rotate if you accept losing existing push subscribers | |
| Tenant `default` apiKey + jwtSecret | ☐ | | |
| Tenant `demo_acme` apiKey + jwtSecret | ☐ | | |
| Tenant `demo_beta` apiKey + jwtSecret | ☐ | | |

---

## 9. Final go/no-go

Don't `git push` to deploy unless every line below is true.

- [ ] §0.3 — three tenants rotated, new credentials in their backends.
- [ ] §0.4 — every tenant confirmed `aud: "chat-app"` + 1h TTL in
      their mint code.
- [ ] §0.6 — staging deploy passed `security-smoke.ts` clean.
- [ ] §1 — production env panel reflects the new file; spot-checked
      for `REDIS_PASSWORD`, https-only CORS, and the absence of
      `DEV_MINT_ENABLED` / `ALLOW_DEV_MINT_TENANTS`.
- [ ] §2 — migrations applied on the prod DB.
- [ ] Low-traffic window confirmed (or you're prepared to wear the
      blast).
- [ ] Communicated to support / ops that account-deletion is now
      sticky for 30 days (the new 410 Gone path).

---

## 10. Appendix — env diff vs. your previous prod env

Removed (dead vars or actively exploitable):
- `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`
- `API_PROXY_URL`, `WS_PROXY_URL`, `STORAGE_PROXY_URL`
- `DEV_MINT_ENABLED=true` ⚠️  was actively exploitable in prod
- `ALLOW_DEV_MINT_TENANTS=default,demo_acme,demo_beta` ⚠️  same
- `http://localhost:3000` from `CORS_ALLOWED_ORIGINS`

Added (required or strongly recommended):
- `REDIS_PASSWORD` ⚠️  required; compose refuses to parse without it.
- `TRUST_PROXY_CIDRS` (optional but recommended over numeric)
- `METRICS_TOKEN` (optional; gate `/metrics`)
- `CLAMAV_HOST`, `CLAMAV_PORT` (optional anti-malware)

Default changes:
- `WEBHOOK_SIGNATURE_REQUIRED`: false → **true**.
- `TENANT_JWT_CLOCK_SKEW_SEC`: 30 → **5** (cap 60).

Tightened validation (boot fails if violated):
- `MASTER_API_KEY`: ≥43 chars of base64url/hex with ≥16 unique chars.
- `JWT_SECRET_ENCRYPTION_KEY`: must decode to exactly 32 bytes.
- `CORS_ALLOWED_ORIGINS` (prod only): no non-https, no localhost.

---

Once you've done §6, copy this runbook into your team's wiki + delete
the populated §8 table from the repo copy. Don't keep prod secrets in
Git, even in a runbook tracker.
