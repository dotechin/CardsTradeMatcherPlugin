# CardsTradeMatcherPlugin

A userscript that matches Steam Trading Cards with ASF bots and Steam friends.

## Script

- **Installable file:** [`CardsTradeMatcherPlugin.user.js`](CardsTradeMatcherPlugin.user.js)
- **Source file:** [`CardsTradeMatcherPlugin.txt`](CardsTradeMatcherPlugin.txt)
- **Version:** 6.1.0.0
- **Authors:** Rudokhvist, iBreakEverything, dotechin

## Features

- Scans ASF bots and Steam friends in a single unified run
- Configurable source filters (ASF bots, friends, or both)
- Result grouping and filtering by source (ASF / Friend / Shared)
- Scan filters to skip badges you don't need
- Blacklist support
- Trade offer automation options (message, auto-send, post-trade action)
- Debug mode

## Installation

1. Install a userscript manager (e.g. [Tampermonkey](https://www.tampermonkey.net/), [Greasemonkey](https://www.greasespot.net/), or [Violentmonkey](https://violentmonkey.github.io/))
2. Open the raw version of [`CardsTradeMatcherPlugin.user.js`](CardsTradeMatcherPlugin.user.js) and use your userscript manager's install flow, or install directly from Greasyfork if published there
3. If your manager does not support direct GitHub installs, open [`CardsTradeMatcherPlugin.txt`](CardsTradeMatcherPlugin.txt), copy the contents, and create a new userscript manually
4. Navigate to your Steam badges page (`steamcommunity.com/id/<yourname>/badges`) to use the matcher

## Known Limitations

- Foil badge matching is not yet supported (`TODO: match foils too`)