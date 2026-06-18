# Migrating Storage: MinIO → AWS S3

This walks through swapping the bundled MinIO sidecar for an AWS S3
bucket. The server code is S3-compatible by design — the AWS SDK is
already what speaks to MinIO, so this is mostly:

1. Stand up the bucket + policy + CORS in AWS
2. Mint an IAM identity with the right permissions
3. Replace four env vars
4. (Optional) Sync existing objects across
5. Stop the `minio` + `minio-init` services

Reading order: §1–§4 are mandatory. §5 only if you have existing data
to preserve. §6 if you want CloudFront in front. §7 covers rollback.

---

## 0. TL;DR

```env
# Before (MinIO):
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=chatprod
S3_SECRET_ACCESS_KEY=<minio-root-password>
S3_BUCKET=chatapp
S3_PUBLIC_URL_BASE=https://chat.example.com/chatapp

# After (AWS S3 direct):
S3_ENDPOINT=                                # MUST be empty/unset for AWS
S3_REGION=us-east-1                         # The bucket's region
S3_ACCESS_KEY_ID=AKIA...                    # From step 4
S3_SECRET_ACCESS_KEY=<from IAM user>
S3_BUCKET=technext-chat-prod                # Your bucket name
S3_PUBLIC_URL_BASE=https://technext-chat-prod.s3.us-east-1.amazonaws.com
#                  ^ or CloudFront URL if you use the §6 option
```

The two-client split in `apps/server/src/lib/s3.ts` (internal vs.
presign endpoints) collapses for AWS — both clients hit the same AWS
endpoint and the code's `forcePathStyle: !!endpoint` flips to
`false`, which AWS prefers. No code change needed.

---

## 1. Pre-flight

You'll need:
- An AWS account with permission to create buckets, IAM users, and
  optionally CloudFront distributions.
- The AWS CLI v2 configured locally (`aws sts get-caller-identity`
  should succeed).
- The hostname your app will use (e.g. `https://chat.technext.it`) —
  needed for the CORS config in §3.

Pick:
- **Bucket name** that's globally unique. Convention used here:
  `<org>-chat-<env>`, e.g. `technext-chat-prod`.
- **Region**. Use the same region as your server for the fastest
  pre-signed URL signing path. Recorded as `us-east-1` below;
  substitute yours.

---

## 2. Create the bucket

```sh
export AWS_REGION=us-east-1
export BUCKET=technext-chat-prod
export APP_ORIGIN=https://chat.technext.it

aws s3api create-bucket \
  --bucket $BUCKET \
  --region $AWS_REGION \
  $( [ "$AWS_REGION" != "us-east-1" ] && echo "--create-bucket-configuration LocationConstraint=$AWS_REGION" )

# Versioning is OPTIONAL but recommended — `Attachment.objectKey`
# stays valid across overwrites, and accidental deletes are
# recoverable. Skip if you want lower storage cost.
aws s3api put-bucket-versioning \
  --bucket $BUCKET \
  --versioning-configuration Status=Enabled

# Default encryption (server-side, AES-256) — costs nothing extra.
aws s3api put-bucket-encryption \
  --bucket $BUCKET \
  --server-side-encryption-configuration '{
    "Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]
  }'
```

### 2.1 Block Public Access — partial off

The default AWS account-level setting blocks ALL public access. We
keep most of that, but the `avatars/*` prefix needs `s3:GetObject`
allowed for anonymous principals (cross-user avatar rendering — see
[`BREAKING_CHANGES.md`](../BREAKING_CHANGES.md) §3.7).

```sh
# Per-bucket: allow public BUCKET POLICIES; keep public ACLs blocked.
# Public ACLs are a 2003-era footgun; we only need policies.
aws s3api put-public-access-block \
  --bucket $BUCKET \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"
```

### 2.2 Apply the avatars-only public policy

```sh
cat > /tmp/avatars-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AnonymousReadAvatars",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/avatars/*"
    }
  ]
}
EOF

aws s3api put-bucket-policy \
  --bucket $BUCKET \
  --policy file:///tmp/avatars-policy.json
```

Verify:

```sh
aws s3api get-bucket-policy --bucket $BUCKET --query Policy --output text | jq
```

This matches what `minio-init` was doing for MinIO. Everything outside
`avatars/*` stays private; reads go through server-minted signed URLs.

### 2.3 (Optional but recommended) Orphan cleanup lifecycle

The server creates `Attachment` rows at presign time and links them
when the message is sent. Orphans (never linked) are reaped by the
nightly GC cron on the DB side. But if the message send fails and S3
keeps a few objects with no DB row, a lifecycle rule cleans them up:

```sh
cat > /tmp/lifecycle.json <<EOF
{
  "Rules": [
    {
      "ID": "expire-incomplete-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
EOF
aws s3api put-bucket-lifecycle-configuration \
  --bucket $BUCKET \
  --lifecycle-configuration file:///tmp/lifecycle.json
```

---

## 3. CORS configuration

The browser uploads directly to S3 via presigned POST + downloads
from signed GET URLs, so the bucket must accept those origins.

```sh
cat > /tmp/cors.json <<EOF
{
  "CORSRules": [
    {
      "AllowedOrigins": ["${APP_ORIGIN}"],
      "AllowedMethods": ["POST", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "x-amz-version-id"],
      "MaxAgeSeconds": 3000
    }
  ]
}
EOF

aws s3api put-bucket-cors \
  --bucket $BUCKET \
  --cors-configuration file:///tmp/cors.json
```

> If you have multiple app origins (e.g. staging + prod), list them
> all in `AllowedOrigins`. Don't use `"*"` — even though the AWS
> request is presigned, `*` lets any site initiate the upload from a
> victim's session if a signed URL ever leaks.

---

## 4. IAM identity for the server

The server needs to:
- `PutObject` (presigned POST happens on its behalf)
- `GetObject` + `HeadObject` (for the post-upload size check + the
  64-byte magic-byte sniff + the optional whole-file ClamAV scan)
- `DeleteObject` (for the orphan GC + the soft-delete cleanup)
- `ListBucket` (for the orphan GC)

Pick **one** of the two patterns:

### 4a. EC2/EKS — instance role (preferred)

If the server runs on AWS (EC2, ECS, EKS), use an **IAM role** with
the policy below attached. Leave `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` empty in env — the SDK picks up the instance
role automatically from the metadata service.

> The SSRF protection in the push-endpoint allowlist (Phase 4) already
> denies `169.254.169.254`; that's a defensive belt-and-braces for push
> subscriptions, NOT a blocker for the AWS SDK to read its own metadata
> from the same address. They don't interact.

### 4b. Dokploy / non-AWS host — IAM user with static keys

```sh
# 1. Create the policy.
cat > /tmp/server-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ChatAppServerObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:HeadObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "ChatAppServerList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name chat-app-server \
  --policy-document file:///tmp/server-policy.json

POLICY_ARN=$(aws iam list-policies --query "Policies[?PolicyName=='chat-app-server'].Arn" --output text)

# 2. Create the user + access key.
aws iam create-user --user-name chat-app-server
aws iam attach-user-policy --user-name chat-app-server --policy-arn "$POLICY_ARN"
aws iam create-access-key --user-name chat-app-server
# Output includes AccessKeyId + SecretAccessKey. Save them in your
# password manager; the secret is shown ONCE.
```

Stash:
- `AccessKeyId` → goes into `S3_ACCESS_KEY_ID`
- `SecretAccessKey` → goes into `S3_SECRET_ACCESS_KEY`

---

## 5. Update the env

Edit the env panel (Dokploy / `.env` / whatever you use):

```env
# Internal endpoint MUST be empty/unset for AWS. The SDK auto-routes
# to the regional AWS endpoint and uses virtual-host style addressing,
# which AWS prefers (forcePathStyle in s3.ts is keyed on whether
# S3_ENDPOINT is set — leaving it empty flips it off automatically).
S3_ENDPOINT=

S3_REGION=us-east-1
S3_BUCKET=technext-chat-prod
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...

# The host the browser hits for direct uploads (presigned POST) and
# direct avatar reads (the public `avatars/*` prefix). The bucket
# regional endpoint is the simplest choice. For CloudFront, see §6.
S3_PUBLIC_URL_BASE=https://technext-chat-prod.s3.us-east-1.amazonaws.com
```

> `S3_PUBLIC_URL_BASE` is signed against in SigV4 — the Host header
> the browser sends must match what the URL was signed for. If you
> ever route through a proxy that rewrites `Host`, signing fails
> opaquely. With AWS direct, no proxy is in the path; this is one of
> the reasons switching off MinIO simplifies the deployment.

---

## 6. (Optional) CloudFront in front

CloudFront pays off if:
- You serve attachments at scale and want edge caching
- You want a vanity hostname like `cdn.chat.example.com`
- You want to keep the S3 bucket entirely private (CloudFront fetches
  via OAC)

### 6.1 Distribution sketch

- **Origin**: the S3 bucket, with Origin Access Control (OAC) bound
  to the distribution.
- **Behaviour**:
  - Default behaviour: forward signed URLs through to S3, no caching
    (private attachments rotate signed URLs every ~5 min).
  - Path pattern `avatars/*`: cache long (TTL ≥ 1d), public read.
- **Bucket policy** when using OAC: replace the §2.2 anonymous
  `s3:GetObject` with one that allows ONLY the CloudFront
  distribution's service principal to read `avatars/*`. Drop the
  `BlockPublicPolicy=false` toggle from §2.1 — the bucket can be
  fully private again.

Then set:
```env
S3_PUBLIC_URL_BASE=https://cdn.chat.example.com
```

### 6.2 The presigned-URL caveat

A presigned URL is signed against the **origin's hostname**. If the
browser hits `cdn.chat.example.com` but the URL was signed against
`technext-chat-prod.s3.us-east-1.amazonaws.com`, the signature is
invalid. Pick one:

- **Simplest**: leave `S3_PUBLIC_URL_BASE` pointing at the bucket
  origin. Use CloudFront only for the public `avatars/*` path (a
  separate `S3_AVATARS_BASE_URL` — would need a code change).
- **Or**: configure CloudFront with the "Forward all viewer headers"
  policy and sign URLs against the CloudFront hostname (set
  `S3_PUBLIC_URL_BASE=https://cdn.chat.example.com`). Verify with
  one upload + one render before deploying widely.

If you don't have a strong reason for CloudFront, skip §6 entirely
— direct-to-S3 is faster to set up and one fewer thing to break.

---

## 7. Migrate existing objects (only if you had MinIO data)

If this is a fresh deploy, skip this section.

### 7.1 Inventory what's in the bucket

```sh
# MinIO container has `mc`. Get a quick count:
docker compose exec minio-init mc ls -r local/chatapp | wc -l
```

### 7.2 Mirror to AWS

Two options:

**A. Using mc (simplest if your laptop already has mc configured for
both endpoints)**

```sh
mc alias set src http://localhost:9000 chatprod <minio-root-password>
mc alias set dst https://s3.us-east-1.amazonaws.com $S3_ACCESS_KEY_ID $S3_SECRET_ACCESS_KEY
mc mirror --preserve src/chatapp dst/technext-chat-prod
```

**B. Using `aws s3 sync` (download then upload)**

```sh
# Pull from MinIO via path-style endpoint:
aws s3 sync \
  --endpoint-url http://minio:9000 \
  --no-verify-ssl \
  s3://chatapp/ ./minio-snapshot/

# Push to AWS:
aws s3 sync ./minio-snapshot/ s3://technext-chat-prod/
```

Object keys are preserved — `Attachment.objectKey` in the DB stays
correct.

### 7.3 Verify a sample of objects

```sh
# Count both sides should match (excluding anything written between
# the sync and now — schedule the cutover during a quiet window):
aws s3 ls s3://technext-chat-prod/ --recursive --summarize | grep "Total Objects"

# Spot-check by HEADing 5 random objects:
docker compose exec minio-init mc ls -r local/chatapp | shuf -n 5 | awk '{print $5}' | while read key; do
  aws s3api head-object --bucket technext-chat-prod --key "$key" >/dev/null \
    && echo "OK $key" || echo "MISSING $key"
done
```

### 7.4 The cutover sequence (low-traffic window)

```
1. Put the app in a 30-second maintenance window if you can (so no
   uploads land in MinIO mid-sync).
2. Re-run §7.2's `mc mirror` to catch anything written since the
   first run.
3. Update the env panel with the new S3 values (§5).
4. `docker compose up -d --no-deps server` to roll the server with
   new env. Don't touch the minio/minio-init containers yet — they
   stay running for rollback.
5. Verify §8 below.
6. After 24 h of green, stop minio (next section).
```

---

## 8. Verify

Run these in order. Any ❌ = rollback (§9).

### 8.1 Server picks up the new endpoint

```sh
docker compose exec server sh -c 'env | grep ^S3_'
# Confirm S3_ENDPOINT is EMPTY, S3_PUBLIC_URL_BASE is the AWS URL.
```

### 8.2 Sign + upload + download round-trip

```sh
docker compose exec server \
  pnpm exec tsx scripts/smoke-minio.ts
# Despite the name this just exercises createUploadUrl + POST +
# createDownloadUrl. With S3_ENDPOINT empty, it talks to AWS.
```

Expected: `✅ All steps passed.`

### 8.3 Browser end-to-end

In an incognito tab on the real `${APP_ORIGIN}`:
- [ ] Send a message with an image attachment. Bubble renders.
      DevTools → Network → the upload `POST` goes to your AWS bucket
      (not `localhost:9000`).
- [ ] Settings → "Change photo" → upload an avatar. Other users see
      it. URL is on the AWS public origin (or your CloudFront vanity).
- [ ] Download an attachment. File saves.

### 8.4 Audit log

```sh
# Should be unchanged (admin_audit_log doesn't touch S3).
docker compose exec postgres psql -U chatapp chatapp -c \
  "SELECT COUNT(*) FROM admin_audit_log;"
```

---

## 9. Rollback

The MinIO bucket still has every object (assuming you didn't delete
the volume). Reverse:

```sh
# 1. Restore the previous env values for S3_*
# 2. docker compose up -d --no-deps server
```

That's it. No DB change needed; objects in AWS will become orphans
that the next §7.2 mirror (from AWS → MinIO) can backfill if you ever
re-attempt the migration. Or just leave them — you're paying AWS
storage for a few weeks until you delete them via:

```sh
aws s3 rm s3://technext-chat-prod --recursive
aws s3api delete-bucket --bucket technext-chat-prod
```

---

## 10. Decommission MinIO (only after 24+ hours of green AWS)

Edit `docker-compose.yml` to comment out or remove:
- `minio` service block
- `minio-init` service block
- `minio_data` volume

Or leave them defined but commented; cheaper to bring back if needed.
Then:

```sh
docker compose up -d --remove-orphans
docker volume rm chat-app_minio_data    # only when you're sure
```

You can also drop the `MINIO_*` env vars (`MINIO_ROOT_USER`,
`MINIO_ROOT_PASSWORD`, `MINIO_BUCKET`, `MINIO_API_CORS_ALLOW_ORIGIN`).
They're inert without the service.

---

## 11. Cost sanity check

Rough AWS S3 pricing (us-east-1, June 2026):
- Storage: ~$0.023/GB/month for the first 50 TB.
- `PUT` / `POST` requests: $0.005 per 1,000.
- `GET` requests: $0.0004 per 1,000.
- Data transfer **out to the internet**: $0.09/GB for the first 10 TB.

The expensive line item is almost always egress, not storage. If you
plan on serving high attachment-render volume, CloudFront's free tier
(1 TB/month outbound) is essentially mandatory — its egress rate is
$0.085/GB and S3-to-CloudFront origin transfer is free.

The presigned POST flow uploads **directly** from the browser to S3
(not via the server), so PUT request charges are the only "upload-side"
cost. The post-upload `GetObject` + `HeadObject` calls the server
makes for size verification + magic-byte sniff are negligible.

---

## 12. Things that are subtly different vs. MinIO

| Topic | MinIO behaviour | AWS S3 behaviour |
|---|---|---|
| `forcePathStyle` | `true` (set by code because `S3_ENDPOINT` is non-empty) | `false` (virtual-host) |
| Two-client split (internal vs. presign) | Used to navigate the Traefik path-style rewrite for MinIO | Collapses: both clients point at the same AWS endpoint |
| `mc anonymous set-json` for `avatars/*` | `minio-init` container handles it | `aws s3api put-bucket-policy` — you do it once, by hand |
| Public-Access-Block | n/a | Need `BlockPublicPolicy=false` for the avatars policy to work (or use CloudFront with OAC and keep it `true`) |
| CORS | Set via `MINIO_API_CORS_ALLOW_ORIGIN` env | Set via `put-bucket-cors` |
| Presigned POST policy (`content-length-range` + `eq $Content-Type`) | Works | Works (identical SigV4) |
| Versioning | Off by default; possible | Off by default; enable in §2 if you want soft-delete semantics |
| Server-side encryption | Off | AES-256 enabled in §2 (no key management cost) |

---

## 13. Where to look in the code

You shouldn't have to change anything in the codebase. The relevant
files for reference:

| File | What it does |
|---|---|
| [`apps/server/src/lib/s3.ts`](../apps/server/src/lib/s3.ts) | `createUploadUrl`, `createDownloadUrl`, `createViewUrl`, `getObjectHead`. Endpoint-agnostic. |
| [`apps/server/src/env.ts`](../apps/server/src/env.ts) | The `S3_*` schema. |
| [`apps/server/src/routes/attachments.ts`](../apps/server/src/routes/attachments.ts) | The presigned-POST handler + the avatar-prefix routing. |
| [`apps/server/scripts/smoke-minio.ts`](../apps/server/scripts/smoke-minio.ts) | End-to-end upload/download smoke. Despite the name, it works against any S3-compatible target — just provide the right `S3_*` env. |

---

## 14. Final checklist

Before flipping the env in prod:

- [ ] §2 — bucket created, versioning + encryption set.
- [ ] §2.1, §2.2 — Public-Access-Block partially off + avatars policy
      applied; verified with `get-bucket-policy`.
- [ ] §3 — CORS configured with your real `${APP_ORIGIN}`.
- [ ] §4 — IAM role (4a) OR access key pair (4b) ready.
- [ ] §7 — existing MinIO data mirrored (if applicable) and spot-checked.
- [ ] §5 — env values prepared; verified `S3_ENDPOINT` is **empty**.
- [ ] You have a copy of the previous env values for §9 rollback.

Once all ✅, paste the new env, redeploy the server only, and walk
through §8.
