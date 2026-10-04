# CardsTradeMatcherPlugin

A userscript that matches Steam Trading Cards with ASF bots, Steam friends, and optionally saved Steam groups.

## Script

- **Installable file:** [`CardsTradeMatcherPlugin.user.js`](CardsTradeMatcherPlugin.user.js) (full userscript source)
- **Direct install URL:** [`raw/CardsTradeMatcherPlugin.user.js`](https://raw.githubusercontent.com/dotechin/CardsTradeMatcherPlugin/main/CardsTradeMatcherPlugin.user.js)
- **Version:** 6.5.0.0
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
- Paginated normal-card inventories with separate total holdings and tradable budgets when group scanning is enabled
- Strictly validated, locally saved Steam trade URLs for members who are not friends

## Steam group scanning

Open **Configuration → Groups**, add HTTPS `steamcommunity.com/groups/<name>` or `steamcommunity.com/gid/<ID>` URLs, and enable group scanning. Saved groups remain available when disabled. Set the number of groups per scan and default page/member limits; individual groups can override the defaults. Groups coexist with ASF bots, friends, and the whitelist. Members are deduplicated across sources, excluding your account and blacklisted accounts (account IDs or SteamID64s).

Discovery reads Steam's paginated `memberslistxml/?xml=1&p=N` response. Limits, unavailable groups, incomplete responses, and failed/private inventories are reported as partial rather than a complete group scan. A private target is skipped, not automatically blacklisted. All targets use paginated `/inventory/<SteamID64>/753/6` inventories while group mode is enabled. Existing badge templates/scan filters define the games to match; foil cards and other items are excluded using stable Steam tags and market hashes.

Total holdings (including locked cards) determine duplicate balance and neutral-or-better fairness. Only the original tradable budget on each side can be spent; cards received during matching cannot be re-offered. Group members always use neutral-or-better matching, including members also listed by ASF.

Group membership and a public inventory **do not establish permission to trade**. Access is labeled unknown unless a friend/source/token supplies an access route; Steam still decides eligibility. You may save a member's Steam trade URL (one per line, with `partner` and `token`). Only HTTPS Steam URLs with a valid account ID and eight-character token are accepted, and tokens are applied only to their matching partner. Tokens are stored in this browser's local storage; avoid sharing/exporting it.

Group-related offers **never auto-send**, even when the global auto-send option is enabled. Open the usual match link, review Steam's availability/eligibility checks, and submit manually. Before adding any items, the helper checks both loaded inventories for enough explicitly tradable normal cards and verifies the partner. Existing offer items, missing cards, incomplete loading, or partner mismatches abort preparation.

Verified inventory snapshots use a separate provenance and upgraded cache schema: old badge counts are never treated as verified tradable counts. Stale inventory reuse is labeled and refreshed in the background; refresh failure remains visible. **Force fresh scan** bypasses caches, and **Clear inventory cache** invalidates in-flight cache writes. Accepted-trade reconciliation subtracts consumed total and tradable counts until a newer snapshot supersedes it. Stop/restart invalidates obsolete work; Steam requests have bounded timeouts/retries and rate-limit backoff.

With group scanning disabled, the existing badge-based ASF/friend matching and scan filters remain available.

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
- Steam group XML and inventory formats can change. Live endpoint verification was unavailable in the implementation environment (Steam DNS resolution failed); validate against your group's current response before relying on a large scan.
- Very large inventories stop at a 100-page safety limit and are discarded rather than used as complete inventories
