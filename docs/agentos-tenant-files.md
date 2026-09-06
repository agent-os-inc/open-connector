# AgentOS tenant transit files

This branch preserves OpenConnector v1.3.4 at
`ef9ef5b6cf1f8c15368f0a62fc2517780aebc12a` plus the reviewed TEN-609
QuickBooks/Gmail/Alchemy source tree
`73bf9fedb4b46191a883ed8cd959c49bab0dd50d`. It backports the upstream S3
and streaming multipart implementation from upstream commit
`5a0db6f07a70d553b02c33a85238c8710d5680d2`, then enforces tenant ownership.
It does not upgrade the runtime to upstream v1.5 or migrate SQLite.

## Contract

Set `OOMOL_CONNECT_TRANSIT_FILE_BACKEND=s3`, `OOMOL_CONNECT_S3_BUCKET`,
`OOMOL_CONNECT_S3_KMS_KEY_ID`, and `AWS_REGION`. Existing runtime token,
admin token and encryption key remain required. Credentials use the AWS SDK
default chain with EKS Pod Identity; static AWS credential environment
variables are rejected at startup. SQLite/PVC retains runtime records and
native encrypted provider credentials. No per-user vault lookup is involved.

Go supplies `X-AgentOS-Tenant-ID` only after current tenant/user/profile,
action and connected-account authorization. The private connector accepts
that header only with its configured AgentOS service runtime bearer token.
Admin tokens, stored runtime tokens and JWTs cannot establish this tenant
context. Missing, repeated, noncanonical or traversal-shaped tenant IDs
fail before execution or file access. Direct MCP/proxy execution is disabled
in S3 mode; catalog and admin/OAuth routes retain their existing controls.
OAuth callback routing must remain separate from public admin/runtime access.

Objects use `tenants/<canonical UUID>/transit/openconnector/<random file ID>`.
Upload, provider-produced files, read/head/download and deletion use the same
immutable async tenant context. There is no shared-prefix fallback. The
shared Pod Identity role does not provide per-tenant IAM isolation: this is
an application boundary enforced after Go authorization. Action idempotency
is also scoped by tenant, preventing cached response crossover.

Every write explicitly requests the configured SSE-KMS key and the object
tag `agentos-transit=openconnector`. The role needs GetObject, PutObject,
PutObjectTagging and DeleteObject only under this transit subtree, plus the
existing S3-scoped KMS permissions. Do not grant all tenant data. HEAD uses
GetObject authority. No bucket listing is used by the runtime.

Provider download URLs are S3 GET signatures valid for at most five minutes
and at most the remaining object TTL. They are bearer capabilities: any
recipient can fetch that object until expiry, deletion or credential expiry.
They expose no connector service token and require no public connector
runtime route. Authorized idempotent replay renews only matching file URLs,
without provider re-execution or extension of object lifetime. Deleted or
expired transit files fail visibly. SDK credential expiry may shorten URLs.

## Temporary data and cleanup

The default object TTL is 86400 seconds (`OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS`).
Expired objects cannot be read or renewed through the connector. S3 lifecycle
must physically remove objects using BOTH prefix `tenants/` and tag
`agentos-transit=openconnector`; S3 lifecycle prefix filters do not accept
wildcards. Use a one-day expiry for the default TTL, noting lifecycle removal
is asynchronous rather than an exact 24-hour deletion guarantee. Changing
runtime TTL requires a matching lifecycle review. Never apply this rule to
other tenant objects.

Multipart uploads stage at `<dataDir>/tmp/transit-files/<tenant UUID>/<random>.tmp`,
with private directory/file modes, and remove staging on success or error.
Startup cleanup removes expired managed staging files across tenant directories;
symlinks and unrelated names are not followed. Provider-produced File objects
may be buffered in memory. This is S3 final storage, not a promise of zero
local files. SQLite and provider credentials remain on the existing PVC.

## Image and deployment ownership

Build `docker/Dockerfile.agentos` from an exact reviewed fork commit with
`VCS_REF` set to that commit. The infrastructure owner retains the existing
protected linux/arm64 image build/sign/attestation workflow and
`ghcr.io/agent-os-inc/openconnector-evaluation` registry. Publish and pin the
resulting immutable digest; a source revision or local test is not a published
image. Retain the current Node image digest, non-root UID 10001, production
dependency audit, license notices and existing supply-chain checks.

Infra owns custom chart templates/values, source pins, S3/KMS permissions,
lifecycle and the exact Pod Identity agent egress exception required for
credential delivery. General private or metadata access remains blocked;
public Internet egress stays unrestricted per deployment policy. LOCAL owns
live cluster/credential acceptance. Keep single replica, SQLite/PVC, startup
CSI mounts and current provider action/OAuth restrictions.

Roll out the Go tenant header first, then the compatible fork image and S3
configuration. Fresh setup requires no SQLite transfer. Rollback must hold
file-dependent invocations if the prior binary cannot enforce tenant file
ownership; never restore shared transit reads as a fallback. Existing provider
credentials and the PVC must be preserved.

## Acceptance

Run `npm run fix-check`, the full `npm test`, `npm run generate:catalog`, and
the hardened image build. Focused tests cover concurrent tenants, missing or
spoofed authority, traversal, cross-tenant read/delete, SSE-KMS/tag writes,
TTL, replay renewal, streamed staging cleanup, plus QBO/Gmail regressions.
Go tests cover current authorization before dispatch and tenant header custody.

Live acceptance remains separate: exact image digest/source/signature;
private ingress and OAuth callback; fresh Pod Identity credentials; two-tenant
upload/action/read/delete; KMS encryption and lifecycle tags; provider-facing
signed download; staging cleanup; SQLite restart and native credential survival.
No production rollout or provider credential rotation is implied.
