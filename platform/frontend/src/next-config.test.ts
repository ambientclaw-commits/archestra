import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  withSentryConfig: (config: unknown) => config,
}));

describe("next config rewrites", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ARCHESTRA_API_BODY_LIMIT;
    delete process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
    delete process.env.VERSION;
  });

  it("matches the backend request body limit for proxied client uploads by default", async () => {
    const { default: nextConfig } = await import("../next.config");

    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe("70mb");
  });

  it("uses ARCHESTRA_API_BODY_LIMIT for proxied client uploads when configured", async () => {
    process.env.ARCHESTRA_API_BODY_LIMIT = "100mb";

    const { default: nextConfig } = await import("../next.config");

    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe("100mb");
  });

  it("supports numeric ARCHESTRA_API_BODY_LIMIT values as bytes for proxied client uploads", async () => {
    process.env.ARCHESTRA_API_BODY_LIMIT = "52428800";

    const { default: nextConfig } = await import("../next.config");

    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(52428800);
  });

  it("uses sanitized VERSION as the deployment id", async () => {
    process.env.VERSION = "v1.2.41+build.5";

    const { default: nextConfig } = await import("../next.config");

    expect(nextConfig.deploymentId).toBe("v1-2-41-build-5");
  });

  it("proxies well-known oauth discovery routes to the backend by default", async () => {
    const { default: nextConfig } = await import("../next.config");

    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/.well-known/:path*",
          destination: "http://localhost:9000/.well-known/:path*",
        },
      ]),
    );
  });

  it("uses the configured backend URL for well-known oauth discovery routes", async () => {
    process.env.ARCHESTRA_INTERNAL_API_BASE_URL = "https://api.example.com";

    const { default: nextConfig } = await import("../next.config");

    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: "/.well-known/:path*",
          destination: "https://api.example.com/.well-known/:path*",
        },
      ]),
    );
  });
});
