# Task cockpit: implementation and verification

The task cockpit ships in **0.5.0**, alongside transport/cache, polling and
active-session improvements. It keeps the existing authenticated proxy, official
chat and loopback management boundary, targeting Harness **0.2.1-rc.2**.
The automated totals below describe the current release checks; real-host
acceptance records are retained evidence from the earlier cockpit implementation,
**not a fresh real-host test of the final 0.5.0 transport changes**.

## What is implemented

- A minimizable entry on remote hostnames or phone-width viewports (≤720 CSS px).
- Selectable cross-session inbox for each session's highest-priority official
  interaction; existing approval, question and plan-review forms are reused.
- Official session membership/order, running/unknown facts, stopped activity to
  review, navigation and a page-lifetime last-opened marker.
- Full-width phone bottom panel; compact right panel from 640px. Safe-area
  padding, short-landscape adaptation, 44px touch controls, wrapping long titles,
  scrollable long plans, host-theme colors and keyboard focus isolation.
- In-memory drafts and submission locks remain mounted when switching tabs,
  choosing another item or minimizing. Resolution/removal clears that form.
- Connection observation reuses the host carrier. Connected/foreground recovery
  requests a coalesced refresh; no new WebSocket and no write-action replay.
- Disconnected/unknown channel submissions are disabled and guarded again at the
  action boundary. Sent actions stay locked for that mount, with confirmation or
  uncertain-result messaging; the official pending registry owns removal.

## Deliberate limits

- Connected is not synchronized. The locked host API's refresh Promise can
  resolve after an internal failed pull, so the UI says “last known state”.
- Session-list phase is first-arrival lifecycle, not current transport health.
  Unknown running is not false; stopped/unread is not successful completion.
- Drafts, recent navigation and locks are not persisted across reloads or client
  service reconstruction. No PWA, Web Push, granular sharing, task stop/retry or
  replacement chat client is included.
- A real browser with emulated viewport is not a physical iOS Safari or Android
  Chrome test. Keyboard/OS safe-area behavior still deserves device acceptance.

## Repeatable checks

Use the repository's locked dependencies:

    pnpm install --frozen-lockfile
    NODE_ENV=test NODE_OPTIONS=--no-experimental-webstorage pnpm run check:ci

The explicit environment avoids an inherited production React build and Node 26
experimental Web Storage overriding jsdom. This run passed lint, CI typecheck,
303 server/unit tests, 127 client tests and the production build. The regular
full TypeScript config was also checked with pnpm run typecheck.

Browser fixture regression:

    pnpm exec playwright install chromium
    NODE_ENV=development pnpm run test:browser

For an already-running, isolated system Chromium browser with an approved local
CDP endpoint, use DSH_BROWSER_CDP instead of launching another test browser:

    NODE_ENV=development DSH_BROWSER_CDP=http://127.0.0.1:9437 pnpm run test:browser

The smoke covers 320×568 dark/en, 390×844 light/zh, 844×390 dark/en,
1280×900 light/en. It checks panel bounds, long-title overflow, draft retention,
minimize/resume, reachable long-plan actions, pending removal and offline guards.
The 0.5.0 release browser run passed all four cockpit viewports above, plus
the settings/self-check/invite/language-persistence flow at 390×844, with zero
browser page errors. This is fresh fixture acceptance, not a fresh real-host run.

The interactive fixture is scripts/screenshots/CockpitDemo.tsx; serve it with the
existing screenshots Vite setup and open ?demo=cockpit. Optional query keys:
lang=en|zh, theme=light|dark, connection=connected|connecting|disconnected|unknown,
phase=pending. Its state and answers are local memory only, not real host calls.

## Transport and polling evidence

The fifteen-round [English benchmark](./performance-benchmark.md) /
[中文报告](./performance-benchmark.zh.md) separates real HTTP/SSE pipelines and
real React component tests from simulated clocks/RPCs. It measures warm cache
work avoidance, hidden/slow polling and deterministic expiry behavior — not LCP,
physical-phone performance or lossless reconnection. Cache hits remain behind
authentication/CIDR checks; no write-action replay is added.

## Real-host acceptance (retained evidence)

The retained local verification used a separate HOME/DSH_HOME and pinned Harness
0.2.1-rc.2. It was not rerun as part of this release documentation update.
No real user's profile, settings, credentials or sessions were changed.
Direct authenticated boot loaded the then-current plugin and a connected cockpit at
390×844 with no browser runtime errors. The authenticated reverse-proxy path was
also verified: boot graph includes dsh-full-remote, launcher is clickable after
the host welcome dialog is closed normally, the Sessions tab lists a real
session, and the remote management API still returns 403. Browser page errors: 0.
The original proxy-path acceptance output remains under ignored `output/playwright`.
Selected previously captured images are now preserved in the repository:
[cockpit inbox](./screenshots/cockpit-phone-light.png),
[dark cockpit](./screenshots/cockpit-phone-dark.png),
[question](./screenshots/cockpit-phone-question.png),
[plan](./screenshots/cockpit-phone-plan.png), and
[real proxy phone](./screenshots/cockpit-real-proxy-phone.png).
Fixture screenshots demonstrate layout, not additional live-host coverage.
Actual model/tool execution remains covered by domain callbacks and
regression fixtures rather than a paid live model invocation.
