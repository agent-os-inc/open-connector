import type { MiddlewareHandler } from "hono";

import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { jsonError } from "../api/http-utils.ts";
import { isTransitFilePath, TransitFileError } from "./transit-file-store.ts";

const tenants = new AsyncLocalStorage<string>();
export const tenantIdPattern: RegExp = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function currentTenant(): string | undefined {
  return tenants.getStore();
}

export function requireTenant(): string {
  const tenant = currentTenant();
  if (!tenant) {
    throw new TransitFileError(400, "tenant_required", "An authenticated tenant context is required.");
  }
  return tenant;
}

export function createTenantFileMiddleware(runtimeToken: string | undefined): MiddlewareHandler {
  if (!runtimeToken || runtimeToken.length < 32) {
    throw new Error("Tenant files require the AgentOS service runtime token.");
  }
  const expected = Buffer.from(`Bearer ${runtimeToken}`);
  return async (context, next) => {
    const path = context.req.path;
    // AgentOS is the account/action authorization boundary. Alternate executors
    // cannot supply the tenant authority required by this deployment.
    if (path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/v1/proxy/")) {
      return jsonError(context, 403, "agentos_required", "Use the authorized AgentOS action endpoint.");
    }
    const isAction = context.req.method === "POST" && path.startsWith("/v1/actions/");
    if (!isTransitFilePath(path) && !isAction) {
      return next();
    }
    const supplied = Buffer.from(context.req.header("authorization") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return jsonError(context, 401, "unauthorized", "The AgentOS service credential is required.");
    }
    const tenant = context.req.header("x-agentos-tenant-id") ?? "";
    if (!tenantIdPattern.test(tenant)) {
      return jsonError(context, 400, "tenant_required", "A canonical tenant UUID is required.");
    }
    // The server's cache middleware marks every transit file response private.
    await tenants.run(tenant, next);
  };
}
