import type { BrowserOptions, EdgeOptions, NodeOptions } from "@sentry/nextjs";

const FRONTEND_BROWSER_TRACES_SAMPLE_RATE = 0.05;
const FRONTEND_SERVER_TRACES_SAMPLE_RATE = 0.02;

// Sentry only initializes when the resolved environment is exactly `production`
// — resolved from `NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT`, falling back to
// `NODE_ENV`. Dev laptops (`NODE_ENV=development`), ad-hoc per-machine names,
// and typos are silenced. Preview / branch deploys that build with
// `NODE_ENV=production` and no override will count as production; set
// `NEXT_PUBLIC_ARCHESTRA_SENTRY_ENVIRONMENT` to a distinct value (e.g.
// `preview`) to silence them. Extend this allowlist when a new deployment
// environment should report events.
export function isAllowedSentryEnvironment(
  environment: string | undefined,
): boolean {
  return environment === "production";
}

export function getFrontendBrowserSentryOptions(
  params: Pick<BrowserOptions, "dsn" | "environment">,
): BrowserOptions {
  return {
    dsn: params.dsn,
    environment: params.environment,
    tracesSampleRate: FRONTEND_BROWSER_TRACES_SAMPLE_RATE,
    enableLogs: true,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    sendDefaultPii: true,
  };
}

export function getFrontendServerSentryOptions(
  params: Pick<NodeOptions, "dsn" | "environment">,
): NodeOptions {
  return {
    dsn: params.dsn,
    environment: params.environment,
    tracesSampleRate: FRONTEND_SERVER_TRACES_SAMPLE_RATE,
    enableLogs: true,
    sendDefaultPii: true,
  };
}

export function getFrontendEdgeSentryOptions(
  params: Pick<EdgeOptions, "dsn" | "environment">,
): EdgeOptions {
  return {
    dsn: params.dsn,
    environment: params.environment,
    tracesSampleRate: FRONTEND_SERVER_TRACES_SAMPLE_RATE,
    enableLogs: true,
    sendDefaultPii: true,
  };
}
