# ADR 0005: The browser talks only to the API

**Status:** accepted

## Context

The original application had the browser talking to the database directly and
calling a third-party language model from the client. Because Vite inlines
every `VITE_*` variable into the client bundle, that model key was readable by
anyone who loaded the page, in a project whose entire subject is phishing.

## Decision

The browser calls only the application's own API routes. Those routes verify
the session, run the detection pipeline, persist the result and generate the
explanation. No database URL and no third-party key is ever sent to the
client.

## Consequences

* The Gemini key lives in a server-side secret and is unreachable from the
  browser.
* The API becomes the audited boundary for everything: authorisation, audit
  logging, cost tracking and rate limiting all happen in one place.
* The detection pipeline runs server-side, so the latency the user sees
  includes the model's inference time. Optional client-side inference is
  supported by letting the browser send a score it computed locally, which
  also keeps the raw message on the device.
* A local development server is needed to run the API without deploying, since
  the routes are plain request handlers.
