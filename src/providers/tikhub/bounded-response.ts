import { TikHubRequestError } from "./errors.ts";

export class BoundedResponseTooLargeError extends TikHubRequestError {}

export async function readBoundedResponseText(
  response: Response,
  input: { maxBytes: number; label: string },
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > input.maxBytes) {
      await cancelResponseBody(response);
      throw responseTooLarge(input);
    }
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > input.maxBytes) {
      await reader.cancel();
      throw responseTooLarge(input);
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

function responseTooLarge(input: { maxBytes: number; label: string }) {
  return new BoundedResponseTooLargeError(
    "provider_error",
    `${input.label} exceeds the ${input.maxBytes} byte limit`,
    502,
  );
}
