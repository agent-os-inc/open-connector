import { describe, expect, it } from "vitest";
import { getResponseCachePolicy } from "./cache-policy.ts";

describe("getResponseCachePolicy", () => {
  it("returns public cache headers only for successful or 304 catalog reads", () => {
    expect(getResponseCachePolicy("GET", "/v1/actions/example.echo", 200)).toEqual({
      cacheControl: "no-store",
      cloudflareCdnCacheControl: "no-store",
    });
    expect(getResponseCachePolicy("HEAD", "/api/providers/example", 204)).toEqual({
      cacheControl: "public, max-age=0, must-revalidate",
      cloudflareCdnCacheControl: "public, max-age=31536000, stale-while-revalidate=86400",
      vary: "Authorization, Cookie, Accept-Encoding",
    });
    expect(getResponseCachePolicy("GET", "/api/providers", 304)).toEqual({
      cacheControl: "public, max-age=0, must-revalidate",
      cloudflareCdnCacheControl: "public, max-age=31536000, stale-while-revalidate=86400",
      vary: "Authorization, Cookie, Accept-Encoding",
    });
  });

  it("returns no-store for runtime responses that are not successful catalog reads", () => {
    expect(getResponseCachePolicy("POST", "/v1/actions/example.echo", 200)).toEqual({
      cacheControl: "no-store",
    });
    expect(getResponseCachePolicy("GET", "/v1/actions/search", 200)).toEqual({
      cacheControl: "no-store",
      cloudflareCdnCacheControl: "no-store",
    });
    expect(getResponseCachePolicy("GET", "/api/providers/missing", 404)).toEqual({
      cacheControl: "no-store",
    });
  });

  it("leaves non-runtime paths untouched", () => {
    expect(getResponseCachePolicy("GET", "/assets/app.js", 200)).toBeUndefined();
  });
});
