// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import config from "@/lib/config/config";
import {
  getFrontendBrowserSentryOptions,
  isAllowedSentryEnvironment,
} from "../sentry.shared";

const {
  sentry: { dsn, environment },
} = config;

if (dsn && isAllowedSentryEnvironment(environment)) {
  const browserOptions = getFrontendBrowserSentryOptions({ dsn, environment });

  Sentry.init({
    ...browserOptions,
    // Preserve the default browser integrations and add Replay on top.
    integrations: [
      ...Sentry.getDefaultIntegrations(browserOptions),
      Sentry.replayIntegration(),
    ],
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
