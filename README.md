# CardsTradeMatcherPlugin

A userscript that matches Steam Trading Cards with ASF bots, Steam friends, and optionally saved Steam groups.

## Script

- **Installable file:** [`CardsTradeMatcherPlugin.user.js`](CardsTradeMatcherPlugin.user.js) (full userscript source)
- **Direct install URL:** [`raw/CardsTradeMatcherPlugin.user.js`](https://raw.githubusercontent.com/dotechin/CardsTradeMatcherPlugin/main/CardsTradeMatcherPlugin.user.js)
- **Version:** 6.5.0.2
- **Authors:** Rudokhvist, iBreakEverything, dotechin

## Features

- Scans ASF bots and Steam friends in a single unified run
- Configurable source filters (ASF bots, friends, or both)
- Result grouping and filtering by source (ASF / Friend / Shared)
- Scan filters to skip badges you don't need
- Long-lived self-updating inventory cache with stale reuse, configurable capacity, and manual bypass/clear controls
- Blacklist support
- Whitelist support for additional SteamIDs
- Trade offer automation options (message, auto-send, post-trade action)
- Debug mode
- Optional saved Steam groups with enable/disable/remove controls, per-group page/member limits, and a group source filter
- Unified badge-count matching for ASF bots, friends, whitelist entries, and group members
- Strictly validated, locally saved Steam trade URLs for members who are not friends

## Steam group scanning

Enable **Scan saved groups** under **Configuration → Matcher → Scan sources**. Manage groups under **Configuration → Groups**: add HTTPS `steamcommunity.com/groups/<name>` or `steamcommunity.com/gid/<ID>` URLs. Saved links display a short `groups/<name>` or `gid/<ID>` label; hover to see the full URL. Saved groups remain available when disabled. Set the number of groups per scan and default page/member limits; individual groups can override the defaults. Groups coexist with ASF bots, friends, and the whitelist. Members are deduplicated across sources, excluding your account and blacklisted accounts (account IDs or SteamID64s).

Discovery reads Steam's paginated `memberslistxml/?xml=1&p=N` response. Limits, unavailable groups, incomplete responses, and failed/private target badge pages are reported as partial rather than a complete group scan. A private target is skipped, not automatically blacklisted. All sources use the same badge-page scanning workers and cache, including when group scanning is enabled; neither your nor target `/inventory/<SteamID64>/753/6` endpoints are fetched during matching. Existing badge templates/scan filters define the games to match.

Badge card counts determine duplicate balance and candidate matches; they do **not** verify tradability and may include locked cards. Group members always use neutral-or-better matching, including members also listed by ASF with MatchEverything enabled. Live tradable-card availability is checked only when preparing an offer.

Group membership and a public inventory **do not establish permission to trade**. Access is labeled unknown unless a friend/source/token supplies an access route; Steam still decides eligibility. You may save a member's Steam trade URL (one per line, with `partner` and `token`). Only HTTPS Steam URLs with a valid account ID and eight-character token are accepted, and tokens are applied only to their matching partner. Tokens are stored in this browser's local storage; avoid sharing/exporting it.

Group-related offers **never auto-send**, even when the global auto-send option is enabled. Open the usual match link, review Steam's availability/eligibility checks, and submit manually. Before adding any items, the helper checks both loaded inventories for enough explicitly tradable normal cards and verifies the partner. Existing offer items, missing cards, incomplete loading, or partner mismatches abort preparation.

Cached badge counts are candidate-matching data, not verified tradable inventory. Stale cache reuse is labeled and refreshed in the background; refresh failure remains visible. **Force fresh scan** bypasses caches, and **Clear inventory cache** invalidates in-flight cache writes. Accepted-trade reconciliation accounts for consumed cards until a newer snapshot supersedes it. Stop/restart invalidates obsolete work; Steam requests have bounded timeouts/retries and rate-limit backoff.

Disabling group scanning changes target discovery, not the badge-based ASF/friend matching pipeline or scan filters.

## Scan diagnostics and troubleshooting

Progress, request errors, and persistent source warnings appear in an in-flow status area below the matcher results, including during discovery. Errors identify the stage, request path (without query strings/trade tokens), HTTP status when available, timeout/network event, and actual attempt count. A generic retry error alone cannot establish the runtime cause; only HTTP **429** confirms a rate-limit response. HTTP 401/403 suggests checking sign-in, privacy, or permissions; 404 suggests checking the endpoint/profile/group. Timeouts, network failures, and 5xx responses may reflect connectivity or upstream availability.

Requests use bounded transient retries (configured max errors, capped at five retries after the initial attempt); other 4xx errors are not retried, except 408/429. A 429 honors available `Retry-After` seconds or HTTP-date headers. Steam scan and background-refresh calls share pacing/cooldown, with cancellation checks during long waits. No additional wait is performed after the final failed attempt, although subsequent Steam calls still respect the shared cooldown. The configured web limiter is now a minimum spacing for these calls, even if the adaptive delay eases lower.

Defaults remain **web limiter 300 ms / parallel requests 3 / error delay 30000 ms / max errors 3**. For troubleshooting, try **parallel requests 1 / web limiter 1500 ms** and wait before restarting. This is conservative guidance, not a guaranteed fix; background refreshes also consume requests. Check the reported status first rather than assuming Steam blocked the scan.

Warnings name missing ASF/Friends/Groups sources and retain available failure details in the target cache. Configured group/page/member limits are reported separately as **partial by limits**, not fetch failures. Successful targets/results remain available; unavailable individual badge pages are skipped. Group scanning does not require loading your verified inventory: your badge counts feed the same matching pipeline used for ASF and friends. Older partial caches may lack source details: use **Bypass next scan** to rediscover them.

**Install/update the userscript to 6.5.0.2 and reload the Steam page.** Editing this repository does not update an already running installed copy. Live Steam behavior has not been verified for this release; browser checks use local fixtures.

### Local regression checks

With Node.js installed, run `node --check CardsTradeMatcherPlugin.user.js` and `node --test tests/scan-diagnostics.test.js`. Tests use mocked requests/clocks and cover diagnostics, retries, cancellation, source warnings, status replacement, source-row structure, unified badge scanning, group fairness/manual review, and live offer safety checks; they do not contact Steam.

## Overall Status

- **Implemented and working:** unified ASF/friend target scan, badge matching, source-aware results, scan filters, blacklist handling, trade helper flow, and inventory caching
- **Operational caveats:** the plugin still depends on current Steam and ASF page/API formats, so upstream layout or response changes can break parts of the scan flow
- **Current scope:** trading-card matching is the supported path today

## TODO

- Foil badge matching
- Profile backgrounds
- Emoticons
- Make the Inventory scanning in the Bot's background operations
- Make duplicate lister tab
- Show inventory size for users too
- Add delete scan-filter button or delete on de-selection

## Installation

1. Install a userscript manager (e.g. [Tampermonkey](https://www.tampermonkey.net/), [Greasemonkey](https://www.greasespot.net/), or [Violentmonkey](https://violentmonkey.github.io/))
2. Open the [direct install URL](https://raw.githubusercontent.com/dotechin/CardsTradeMatcherPlugin/main/CardsTradeMatcherPlugin.user.js) and use your userscript manager's install flow, or install directly from Greasyfork if published there
3. If your manager does not support direct GitHub installs, open [`CardsTradeMatcherPlugin.user.js`](CardsTradeMatcherPlugin.user.js), copy the contents, and create a new userscript manually
4. Navigate to your Steam badges page (`steamcommunity.com/id/<yourname>/badges`) to use the matcher

## Known Limitations

- Foil badge matching is not yet supported
- Background and emoticon matching are not yet supported
- Steam group XML, badge-page layouts, and live trade inventory formats can change. Live endpoint verification was unavailable in the implementation environment (Steam DNS resolution failed); validate against your group's current response before relying on a large scan.
- Badge-count matches can include locked or unavailable cards; live offer preparation rejects insufficient tradable normal cards rather than guaranteeing every candidate can be traded
