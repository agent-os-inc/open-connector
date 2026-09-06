import type { TransitFileRead, TransitFileUpload } from "../../core/types.ts";
import type { IStagedTransitFileService, StagedTransitFile, TransitFileInfo } from "./transit-file-store.ts";
import type { GetObjectCommandOutput, PutObjectCommandInput } from "@aws-sdk/client-s3";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "node:fs";
import { requireTenant } from "./tenant-context.ts";
import {
  assertFileSize,
  assertSafeFileId,
  isSafeFileId,
  contentTypeFromFileId,
  normalizeDescriptor,
  randomHex,
  safeExtension,
  TransitFileError,
  transitFileRead,
  transitFileResponse,
} from "./transit-file-store.ts";

/** A presigned download URL is a bearer capability, so it never outlives five minutes. */
const maxSignedUrlSeconds = 300;
const transitObjectTag = "agentos-transit=openconnector";

export interface S3TransitFileOptions {
  client: S3Client;
  bucket: string;
  kmsKeyId: string;
  ttlSeconds: number;
  maxBytes: number;
}

/**
 * Build the S3 client for the transit-file backend. Checksum calculation stays opt-in so S3-compatible stores
 * without CRC support keep working; credentials come from the SDK default chain (EKS Pod Identity).
 */
export function createS3TransitClient(region: string): S3Client {
  return new S3Client({
    region,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export class S3TransitFileService implements IStagedTransitFileService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly kmsKeyId: string;
  private readonly ttlMs: number;
  readonly maxBytes: number;

  constructor(options: S3TransitFileOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    if (!options.kmsKeyId) throw new Error("Tenant S3 storage requires a KMS key.");
    this.kmsKeyId = options.kmsKeyId;
    this.ttlMs = options.ttlSeconds * 1000;
    this.maxBytes = options.maxBytes;
  }

  create(file: File): Promise<TransitFileUpload> {
    return this.put(file.size, file.name, file.type, async () => new Uint8Array(await file.arrayBuffer()));
  }

  createFromPath(file: StagedTransitFile): Promise<TransitFileUpload> {
    return this.put(file.sizeBytes, file.name, file.mimeType, () => createReadStream(file.path));
  }

  async read(fileId: string): Promise<TransitFileRead> {
    const { object, metadata } = await this.readObject(fileId);
    // The SDK's bytes are always ArrayBuffer-backed; asserting that beats copying the whole file.
    const bytes = (await object.Body!.transformToByteArray()) as Uint8Array<ArrayBuffer>;
    return transitFileRead(bytes, metadata);
  }

  async response(fileId: string): Promise<Response> {
    const { object, metadata } = await this.readObject(fileId);
    return transitFileResponse(object.Body!.transformToWebStream(), metadata);
  }

  async delete(fileId: string): Promise<boolean> {
    assertSafeFileId(fileId);
    const existing = await this.objectExists(fileId);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(fileId) }));
    return existing;
  }

  // Physical expiry is owned by the tag-filtered S3 lifecycle rule; reads enforce TTL.
  async cleanupExpired(): Promise<void> {}

  // Renew only our typed file descriptors, under the already authenticated
  // tenant. Never replay provider execution merely because a URL expired.
  async refreshDownloadUrls(value: unknown): Promise<unknown> {
    requireTenant();
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.refreshDownloadUrls(item)));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.fileId === "string" && typeof record.downloadUrl === "string") {
      return this.renewDownloadUrl(record, record.fileId, record.downloadUrl);
    }
    const entries = await Promise.all(
      Object.entries(record).map(async ([key, item]) => [key, await this.refreshDownloadUrls(item)] as const),
    );
    return entries.some(([key, item]) => item !== record[key]) ? Object.fromEntries(entries) : value;
  }

  /** Re-sign a descriptor that names an object of this tenant, leaving anything else untouched. */
  private async renewDownloadUrl(
    descriptor: Record<string, unknown>,
    fileId: string,
    downloadUrl: string,
  ): Promise<Record<string, unknown>> {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(downloadUrl).pathname);
    } catch {
      return descriptor;
    }
    if (!isSafeFileId(fileId) || pathname !== `/${this.objectKey(fileId)}`) return descriptor;
    let object;
    try {
      object = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(fileId) }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const remaining = object?.LastModified
      ? Math.floor((this.ttlMs - (Date.now() - object.LastModified.getTime())) / 1000)
      : 0;
    if (remaining < 1) throw new TransitFileError(404, "file_not_found", "Transit file is no longer available.");
    return { ...descriptor, downloadUrl: await this.signedUrl(fileId, remaining) };
  }

  /** Store `body` under the current tenant's transit prefix and answer with a short-lived download URL. */
  private async put(
    sizeBytes: number,
    uploadedName: string,
    uploadedMimeType: string,
    body: () => PutObjectCommandInput["Body"] | Promise<PutObjectCommandInput["Body"]>,
  ): Promise<TransitFileUpload> {
    requireTenant();
    assertFileSize(sizeBytes, this.maxBytes);
    const fileId = `${randomHex(16)}${safeExtension(uploadedName)}`;
    const { name, mimeType } = normalizeDescriptor({
      name: uploadedName || fileId,
      mimeType: uploadedMimeType || contentTypeFromFileId(fileId),
    });

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(fileId),
        Body: await body(),
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.kmsKeyId,
        Tagging: transitObjectTag,
        ContentLength: sizeBytes,
        ContentType: mimeType,
        Metadata: { filename: encodeFileName(name) },
      }),
    );

    return {
      fileId,
      sizeBytes,
      name,
      mimeType,
      downloadUrl: await this.signedUrl(fileId, Math.floor(this.ttlMs / 1000)),
    };
  }

  private signedUrl(fileId: string, availableSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(fileId) }), {
      expiresIn: Math.min(maxSignedUrlSeconds, availableSeconds),
    });
  }

  private objectKey(fileId: string): string {
    assertSafeFileId(fileId);
    return `tenants/${requireTenant()}/transit/openconnector/${fileId}`;
  }

  private async readObject(fileId: string): Promise<{
    object: GetObjectCommandOutput;
    metadata: TransitFileInfo;
  }> {
    assertSafeFileId(fileId);
    const object = await this.getObject(this.objectKey(fileId));
    if (!object?.Body || !object.LastModified || this.isExpired(object.LastModified)) {
      await this.delete(fileId);
      throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
    }

    return {
      object,
      metadata: {
        ...normalizeDescriptor({
          name: decodeFileName(object.Metadata?.filename) ?? fileId,
          mimeType: object.ContentType || contentTypeFromFileId(fileId),
        }),
        sizeBytes: object.ContentLength ?? 0,
      },
    };
  }

  private async getObject(key: string): Promise<GetObjectCommandOutput | undefined> {
    try {
      return await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async objectExists(fileId: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(fileId) }));
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  private isExpired(lastModified: Date): boolean {
    return Date.now() - lastModified.getTime() > this.ttlMs;
  }
}

function encodeFileName(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

function decodeFileName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const name = Buffer.from(value, "base64url").toString("utf8");
  return name || undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
}
