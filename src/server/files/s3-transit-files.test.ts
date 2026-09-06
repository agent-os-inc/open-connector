import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Hono } from "hono";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createS3TransitClient, S3TransitFileService } from "./s3-transit-files.ts";
import { createTenantFileMiddleware } from "./tenant-context.ts";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const keyPrefix = `tenants/${tenantA}/transit/openconnector/`;
const token = "test-service-token".repeat(3);
async function asTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  const app = new Hono();
  let result: T;
  let failure: unknown;
  app.use("*", createTenantFileMiddleware(token));
  app.post("/api/files", async () => {
    try {
      result = await fn();
    } catch (error) {
      failure = error;
    }
    return new Response();
  });
  const response = await app.request("/api/files", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-agentos-tenant-id": tenant },
  });
  expect(response.status).toBe(200);
  if (failure) throw failure;
  return result!;
}
const tenantTest = (name: string, fn: () => Promise<void>) => it(name, () => asTenant(tenantA, fn));

describe("S3TransitFileService", () => {
  tenantTest("shares transit files across service instances", async () => {
    const storage = new MemoryS3();
    const first = createService(storage.client);
    const second = createService(storage.client);

    const upload = await first.create(new File(["hello transit"], "report.TXT", { type: "text/plain" }));
    expect(upload.fileId).toMatch(/^[a-f0-9]{32}\.txt$/);
    const signed = new URL(upload.downloadUrl);
    expect(signed.pathname).toBe(`/${keyPrefix}${upload.fileId}`);
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(upload).toMatchObject({
      sizeBytes: 13,
      name: "report.TXT",
      mimeType: "text/plain",
    });
    expect([...storage.objects.keys()]).toEqual([`${keyPrefix}${upload.fileId}`]);

    const read = await second.read(upload.fileId);
    expect(read).toMatchObject({
      sizeBytes: 13,
      name: "report.TXT",
      mimeType: "text/plain",
    });
    await expect(read.file.text()).resolves.toBe("hello transit");

    const response = await second.response(upload.fileId);
    expect(response.headers.get("content-length")).toBe("13");
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("hello transit");

    await expect(second.delete(upload.fileId)).resolves.toBe(true);
    await expect(first.delete(upload.fileId)).resolves.toBe(false);
    await expect(first.read(upload.fileId)).rejects.toMatchObject({ status: 404, code: "file_not_found" });
  });

  tenantTest("streams a staged file into S3 with its known content length", async () => {
    const storage = new MemoryS3();
    const service = createService(storage.client);
    const root = await mkdtemp(join(tmpdir(), "connect-s3-transit-"));
    const path = join(root, "upload.tmp");
    await writeFile(path, "staged payload");

    try {
      const upload = await service.createFromPath({
        path,
        sizeBytes: 14,
        name: "report.txt",
        mimeType: "text/plain",
      });

      const objectPut = storage.send.mock.calls
        .map(([command]) => command)
        .find((command) => command instanceof PutObjectCommand && command.input.Key === `${keyPrefix}${upload.fileId}`);
      expect(objectPut).toBeInstanceOf(PutObjectCommand);
      if (!(objectPut instanceof PutObjectCommand)) {
        throw new Error("Object upload command was not sent.");
      }
      expect(objectPut.input.Body).toBeInstanceOf(Readable);
      expect(objectPut.input.ContentLength).toBe(14);
      await expect(service.read(upload.fileId).then((stored) => stored.file.text())).resolves.toBe("staged payload");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  tenantTest("rejects files over the configured limit", async () => {
    const storage = new MemoryS3();
    const service = createService(storage.client, { maxBytes: 4 });

    await expect(service.create(new File(["12345"], "large.bin"))).rejects.toMatchObject({
      status: 413,
      code: "file_too_large",
    });
    expect(storage.objects.size).toBe(0);
  });

  tenantTest("deletes expired files when they are read", async () => {
    const storage = new MemoryS3();
    const service = createService(storage.client);
    const upload = await service.create(new File(["old"], "old.txt"));
    storage.objects.get(`${keyPrefix}${upload.fileId}`)!.lastModified = new Date(Date.now() - 61_000);

    await expect(service.read(upload.fileId)).rejects.toMatchObject({ status: 404, code: "file_not_found" });
    expect(storage.objects.size).toBe(0);
  });

  tenantTest("stores and restores a Unicode file name from S3 object metadata", async () => {
    const storage = new MemoryS3();
    const service = createService(storage.client);
    const upload = await service.create(new File(["invoice"], "发票.pdf", { type: "application/pdf" }));

    expect(storage.objects.size).toBe(1);
    await expect(service.read(upload.fileId).then((stored) => stored.name)).resolves.toBe("发票.pdf");
  });

  tenantTest("rejects malformed file ids without touching S3", async () => {
    const storage = new MemoryS3();
    const service = createService(storage.client);

    await expect(service.read("../secret")).rejects.toMatchObject({ status: 404, code: "file_not_found" });
    await expect(service.delete("transit/evil")).rejects.toMatchObject({ status: 404, code: "file_not_found" });
    expect(storage.send).not.toHaveBeenCalled();
  });
});

describe("createS3TransitClient", () => {
  it("configures the client from the server settings and keeps checksums opt-in", async () => {
    const client = createS3TransitClient({
      region: "eu-west-1",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      credentials: { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" },
    });

    try {
      await expect(client.config.region()).resolves.toBe("eu-west-1");
      expect(client.config.forcePathStyle).toBe(true);
      await expect(client.config.endpoint?.()).resolves.toMatchObject({ hostname: "127.0.0.1", port: 9000 });
      await expect(client.config.credentials()).resolves.toMatchObject({
        accessKeyId: "id",
        secretAccessKey: "secret",
        sessionToken: "token",
      });
      await expect(client.config.requestChecksumCalculation()).resolves.toBe("WHEN_REQUIRED");
      await expect(client.config.responseChecksumValidation()).resolves.toBe("WHEN_REQUIRED");
    } finally {
      client.destroy();
    }
  });

  it("leaves endpoint and credentials to the SDK defaults when they are not configured", () => {
    const client = createS3TransitClient({ region: "us-east-1", forcePathStyle: false });

    try {
      expect(client.config.endpoint).toBeUndefined();
      expect(client.config.forcePathStyle).toBe(false);
    } finally {
      client.destroy();
    }
  });
});

function createService(
  client: S3Client,
  options: { ttlSeconds?: number; maxBytes?: number } = {},
): S3TransitFileService {
  return new S3TransitFileService({
    client,
    bucket: "transit-files",
    kmsKeyId: "arn:aws:kms:us-east-1:111111111111:key/test",
    publicOrigin: "http://localhost:3000",
    ttlSeconds: options.ttlSeconds ?? 60,
    maxBytes: options.maxBytes ?? 1024 * 1024,
  });
}

class MemoryS3 {
  readonly objects = new Map<string, MemoryS3Object>();
  readonly client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  readonly send = vi.fn(async (command: object): Promise<object> => {
    if (command instanceof PutObjectCommand) {
      this.objects.set(command.input.Key!, {
        bytes: await bytes(command.input.Body),
        contentType: command.input.ContentType,
        metadata: command.input.Metadata,
        lastModified: new Date(),
      });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const value = this.objects.get(command.input.Key!);
      if (!value) {
        throw notFound();
      }
      return {
        Body: body(value.bytes),
        ContentLength: value.bytes.byteLength,
        ContentType: value.contentType,
        LastModified: value.lastModified,
        Metadata: value.metadata,
      };
    }
    if (command instanceof HeadObjectCommand) {
      if (!this.objects.has(command.input.Key!)) {
        throw notFound();
      }
      return { LastModified: this.objects.get(command.input.Key!)!.lastModified };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key!);
      return {};
    }
    throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
  });

  constructor() {
    this.client.send = this.send as typeof this.client.send;
  }
}

interface MemoryS3Object {
  bytes: Uint8Array;
  contentType?: string;
  metadata?: Record<string, string>;
  lastModified: Date;
}

async function bytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  if (value instanceof Readable) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of value) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : Uint8Array.from(chunk));
    }
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
  throw new TypeError("Unexpected S3 body.");
}

function body(value: Uint8Array): {
  transformToByteArray(): Promise<Uint8Array>;
  transformToString(): Promise<string>;
  transformToWebStream(): ReadableStream;
} {
  return {
    async transformToByteArray() {
      return Uint8Array.from(value);
    },
    async transformToString() {
      return new TextDecoder().decode(value);
    },
    transformToWebStream() {
      return new Blob([Uint8Array.from(value)]).stream();
    },
  };
}

function notFound(): S3ServiceException {
  return new S3ServiceException({
    name: "NoSuchKey",
    $fault: "client",
    $metadata: { httpStatusCode: 404 },
  });
}

it("denies absent context and isolates concurrent tenants, including deletion", async () => {
  const storage = new MemoryS3();
  const service = createService(storage.client);
  await expect(service.create(new File(["x"], "x.txt"))).rejects.toMatchObject({ code: "tenant_required" });
  expect(storage.send).not.toHaveBeenCalled();
  const [a, b] = await Promise.all([
    asTenant(tenantA, () => service.create(new File(["a"], "a.txt"))),
    asTenant(tenantB, () => service.create(new File(["b"], "b.txt"))),
  ]);
  await asTenant(tenantB, async () => {
    await expect(service.read(a.fileId)).rejects.toMatchObject({ status: 404 });
    await expect(service.delete(a.fileId)).resolves.toBe(false);
    await expect(service.read(b.fileId).then((x) => x.file.text())).resolves.toBe("b");
  });
  await asTenant(tenantA, async () => {
    await expect(service.read(a.fileId).then((x) => x.file.text())).resolves.toBe("a");
  });
  for (const [command] of storage.send.mock.calls) {
    if (command instanceof PutObjectCommand) {
      expect(command.input).toMatchObject({
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: "arn:aws:kms:us-east-1:111111111111:key/test",
        Tagging: "agentos-transit=openconnector",
      });
    }
  }
});

it.each([
  ["", tenantA, 401],
  ["Bearer untrusted", tenantA, 401],
  [`Bearer ${token}`, "", 400],
  [`Bearer ${token}`, "../escape", 400],
  [`Bearer ${token}`, `${tenantA},${tenantB}`, 400],
])("rejects invalid service/tenant authority before file access", async (authorization, tenant, status) => {
  const app = new Hono();
  const called = vi.fn();
  app.use("*", createTenantFileMiddleware(token));
  app.get("/api/files/:id", () => {
    called();
    return new Response();
  });
  const response = await app.request("/api/files/" + "a".repeat(32), {
    headers: { authorization, "x-agentos-tenant-id": tenant },
  });
  expect(response.status).toBe(status);
  expect(called).not.toHaveBeenCalled();
});

it("renews replayed file URLs without extending file lifetime or crossing tenants", async () => {
  const storage = new MemoryS3();
  const service = createService(storage.client, { ttlSeconds: 600 });
  const upload = await asTenant(tenantA, () => service.create(new File(["cached"], "cached.txt")));
  storage.objects.get(`${keyPrefix}${upload.fileId}`)!.lastModified = new Date(Date.now() - 350_000);
  const replay = (await asTenant(tenantA, () => service.refreshDownloadUrls({ files: [upload] }))) as {
    files: Array<{ downloadUrl: string }>;
  };
  const renewed = new URL(replay.files[0].downloadUrl);
  expect(Number(renewed.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(250);
  expect(Number(renewed.searchParams.get("X-Amz-Expires"))).toBeGreaterThan(240);
  expect(storage.send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(1);
  storage.objects.get(`${keyPrefix}${upload.fileId}`)!.lastModified = new Date(Date.now() - 601_000);
  await expect(asTenant(tenantA, () => service.refreshDownloadUrls(upload))).rejects.toMatchObject({ status: 404 });
  const before = storage.send.mock.calls.length;
  expect(await asTenant(tenantB, () => service.refreshDownloadUrls(upload))).toEqual(upload);
  expect(storage.send.mock.calls).toHaveLength(before);
});

it("leaves malformed non-file URLs unchanged during replay without touching S3", async () => {
  const storage = new MemoryS3();
  const service = createService(storage.client);
  const output = { fileId: "a".repeat(32), downloadUrl: "https://example.test/%ZZ" };
  expect(await asTenant(tenantA, () => service.refreshDownloadUrls(output))).toEqual(output);
  expect(storage.send).not.toHaveBeenCalled();
});
