import type { ProviderExecutors } from "../../core/types.ts";

import { defineProviderExecutors } from "../provider-runtime.ts";
import { executeWhoGhoAction } from "./runtime.ts";
const service = "who_gho";
const handlers: Record<
  string,
  (input: Record<string, unknown>, context: { fetcher: typeof fetch }) => Promise<unknown>
> = {};
for (const name of ["list_dimensions", "list_dimension_values", "search_indicators", "get_indicator_data"])
  handlers[name] = (input, context) => executeWhoGhoAction(name as never, input, context.fetcher);
export const executors: ProviderExecutors = defineProviderExecutors({
  service,
  handlers,
  createContext: (_context, fetcher) => ({ fetcher }),
  skipDnsValidation: true,
});
