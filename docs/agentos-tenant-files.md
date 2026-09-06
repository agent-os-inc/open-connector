# AgentOS tenant transit files

Pinned to OpenConnector v1.3.4 (`ef9ef5b6cf1f8c15368f0a62fc2517780aebc12a`)
plus the reviewed TEN-609 source tree
(`73bf9fedb4b46191a883ed8cd959c49bab0dd50d`), with the upstream S3 and
streaming multipart implementation backported from
`5a0db6f07a70d553b02c33a85238c8710d5680d2` and tenant ownership enforced on
top. It does not upgrade to upstream v1.5 or migrate SQLite.

## Configuration

`OOMOL_CONNECT_TRANSIT_FILE_BACKEND=s3`, `OOMOL_CONNECT_S3_BUCKET`,
`OOMOL_CONNECT_S3_KMS_KEY_ID`, `AWS_REGION`. Runtime token, admin token and
encryption key remain required. Credentials come from the AWS SDK default
chain (EKS Pod Identity); static AWS credential env vars are rejected at
startup. SQLite/PVC still holds runtime records and encrypted provider
credentials.

## Tenant authority

Go supplies `X-AgentOS-Tenant-ID` only after tenant/user/profile, action and
connected-account authorization. The connector accepts that header only with
its configured AgentOS service runtime bearer token — admin tokens, stored
runtime tokens and JWTs cannot establish tenant context. Missing, repeated,
noncanonical or traversal-shaped IDs fail before execution or file access.
Direct MCP/proxy execution is disabled in S3 mode.

Objects live at `tenants/<canonical UUID>/transit/openconnector/<file ID>`,
with no shared-prefix fallback. Upload, provider-produced files,
read/head/download and deletion share one immutable async tenant context, and
action idempotency is keyed by tenant so cached responses cannot cross over.
The shared Pod Identity role gives no per-tenant IAM isolation: this is an
application boundary enforced after Go authorization.

## S3 and KMS

Every write requests the configured SSE-KMS key and the object tag
`agentos-transit=openconnector`. The role needs GetObject, PutObject,
PutObjectTagging and DeleteObject under this transit subtree only, plus the
existing S3-scoped KMS permissions — not all tenant data. HEAD uses GetObject
authority; the runtime never lists the bucket.

Provider download URLs are S3 GET signatures valid for at most five minutes
and never beyond the object's remaining TTL. They are bearer capabilities: any
holder can fetch that object until expiry or deletion. Authorized idempotent
replay re-signs matching file URLs without re-running the provider or
extending object lifetime.

## Temporary data and cleanup

Default object TTL is 86400s (`OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS`);
expired objects cannot be read or re-signed. Physical removal is the S3
lifecycle rule's job and it must filter on BOTH prefix `tenants/` and tag
`agentos-transit=openconnector` (lifecycle prefixes accept no wildcards). Use
a one-day expiry for the default TTL — removal is asynchronous, not an exact
24-hour guarantee — and re-review the rule whenever the runtime TTL changes.
Never apply it to other tenant objects.

Multipart uploads stage at
`<dataDir>/tmp/transit-files/<tenant UUID>/<random>.tmp` with private
directory/file modes, removed on success or error; startup cleanup sweeps
expired managed staging files per tenant directory without following symlinks
or unrelated names. Provider-produced File objects may still be buffered in
memory: S3 is the final store, not a promise of zero local bytes.

## Image and rollout

Build `docker/Dockerfile.agentos` from an exact reviewed fork commit with
`VCS_REF` set to it, through the existing protected linux/arm64
build/sign/attestation workflow into
`ghcr.io/agent-os-inc/openconnector-evaluation`, then pin the resulting
immutable digest — a source revision is not a published image. Keep the
pinned Node image digest, non-root UID 10001, dependency audit, license
notices, single replica and SQLite/PVC.

Roll out the Go tenant header first, then the fork image and S3 configuration.
Rollback must hold file-dependent invocations if the prior binary cannot
enforce tenant file ownership; never restore shared transit reads as a
fallback.

## Acceptance

`npm run fix-check`, full `npm test`, `npm run generate:catalog`, and the
hardened image build. Live acceptance is separate: image digest/signature,
private ingress and OAuth callback, fresh Pod Identity credentials, two-tenant
upload/action/read/delete, KMS encryption and lifecycle tags, provider-facing
signed download, staging cleanup, SQLite restart with native credentials
surviving.
