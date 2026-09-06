import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "ablefy" as const;
const emptyInput = s.object("This action does not require any input.", {});
const resourceIdInput = (resource: string) =>
  s.object(`The ${resource} lookup input.`, {
    id: s.integer(`The numeric ablefy ${resource} identifier.`, { minimum: 1 }),
  });
const dataOutput = (description: string) =>
  s.object(description, {
    data: s.unknown("The JSON response returned by ablefy."),
  });

export const ablefyActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_account",
    description: "Get the ablefy account associated with the configured API credentials.",
    requiredScopes: [],
    inputSchema: emptyInput,
    outputSchema: dataOutput("The connected ablefy account response."),
  }),
  defineProviderAction(service, {
    name: "list_products",
    description: "List products available in the connected ablefy account.",
    requiredScopes: [],
    inputSchema: emptyInput,
    outputSchema: dataOutput("The ablefy product collection response."),
  }),
  defineProviderAction(service, {
    name: "get_product",
    description: "Get an ablefy product and its related pricing and author information.",
    requiredScopes: [],
    inputSchema: resourceIdInput("product"),
    outputSchema: dataOutput("The requested ablefy product response."),
  }),
  defineProviderAction(service, {
    name: "list_pricing_plans",
    description: "List pricing plans available in the connected ablefy account.",
    requiredScopes: [],
    inputSchema: emptyInput,
    outputSchema: dataOutput("The ablefy pricing plan collection response."),
  }),
  defineProviderAction(service, {
    name: "get_pricing_plan",
    description: "Get one ablefy pricing plan by its numeric identifier.",
    requiredScopes: [],
    inputSchema: resourceIdInput("pricing plan"),
    outputSchema: dataOutput("The requested ablefy pricing plan response."),
  }),
];
