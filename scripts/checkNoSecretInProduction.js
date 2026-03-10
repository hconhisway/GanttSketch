#!/usr/bin/env node
"use strict";

/**
 * Pre-build guard: fail production builds if REACT_APP_LLM_API_KEY is set.
 * That variable is baked into the frontend bundle and would expose the key to all visitors.
 */
if (process.env.NODE_ENV === "production") {
  const key = (process.env.REACT_APP_LLM_API_KEY || "").trim();
  if (key && key.length > 0) {
    console.error(
      "[checkNoSecretInProduction] REACT_APP_LLM_API_KEY must not be set for production builds. " +
        "It gets embedded in the frontend and is visible to everyone. " +
        "Use the Server (proxy) and OPENAI_API_KEY on the server instead. See DEPLOY.md and README.md."
    );
    process.exit(1);
  }
}
