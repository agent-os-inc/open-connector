import type { CatalogStore, RuntimeActionDefinition } from "../../catalog-store.ts";

import { createHash } from "node:crypto";
import { canonicalize } from "../actions/action-idempotency.ts";
import { serializeRuntimeAction, serializeRuntimeProvider } from "./runtime-api.ts";

/** Broker-owned metadata digest; deliberately excludes caller approval policy. */
export function actionDigest(action: RuntimeActionDefinition): string {
  return digest(serializeRuntimeAction(action));
}

/** Immutable catalog assets and executable metadata, independent of account grants. */
export function catalogGeneration(catalog: CatalogStore): string {
  const providers = catalog.providers
    .map(serializeRuntimeProvider)
    .sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
  const actions = catalog.actions
    .map((action) => [action.id, actionDigest(action)])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return digest({ providers, actions });
}

function digest(value: unknown): string {
  return (
    "oc-v1-sha256:" +
    createHash("sha256")
      .update(JSON.stringify(canonicalize(value)))
      .digest("hex")
  );
}

/** Fails before execution when the caller approved a different action definition. */
export class CatalogChangedError extends Error {
  constructor() {
    super("Action metadata changed; review it before execution.");
  }
}
