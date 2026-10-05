const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../CardsTradeMatcherPlugin.user.js"), "utf8");
function declaration(name, indentation = 4) {
    const spaces = " ".repeat(indentation);
    const start = source.search(new RegExp(`^${spaces}(?:async )?function ${name}\\(`, "m"));
    assert.notEqual(start, -1, name);
    const rest = source.slice(start);
    const end = rest.slice(1).search(new RegExp(`\\n${spaces}(?:(?:async )?function |//Main)`));
    return end < 0 ? rest : rest.slice(0, end + 1);
}

function harness(responses = []) {
    let now = 0;
    const starts = [];
    const urls = [];
    const sleeps = [];
    const timers = [];
    let scheduled = false;
    function pump() {
        if (scheduled || !timers.length) return;
        scheduled = true;
        setImmediate(() => {
            scheduled = false;
            timers.sort((a, b) => a.deadline - b.deadline);
            const timer = timers.shift();
            now = timer.deadline;
            context.onSleep?.();
            timer.callback();
            pump();
        });
    }
    const context = vm.createContext({
        URL, console, queueMicrotask,
        Date: class extends Date { static now() { return now; } },
        setTimeout(callback, delay) {
            sleeps.push(delay);
            timers.push({callback, deadline: now + delay});
            pump();
        },
        XMLHttpRequest: class {
            open(method, url) { this.url = url; }
            addEventListener(name, callback) { this[name] = callback; }
            getResponseHeader() { return this.reply.retryAfter || null; }
            send() {
                starts.push(now);
                urls.push(this.url);
                this.reply = responses.shift();
                assert.ok(this.reply, "unexpected request");
                this.status = this.reply.status;
                this.response = this.reply.body ?? null;
                this.responseURL = this.url;
                queueMicrotask(() => {
                    this[`on${this.reply.event || "load"}`]();
                    this.loadend?.();
                });
            }
            abort() { this.onabort(); }
        },
    });
    vm.runInContext(`
        let stop = false, scanGeneration = 1;
        let steamCooldownUntil = 0, nextSteamRequestAt = 0;
        let globalSettings = {maxErrors: 2, errorLimiter: 1000, weblimiter: 0};
        let scanStatus = {progress: "", diagnostic: "", warning: ""};
        const activeScanRequests = new Set();
        function getAdaptiveRequestDelay() { return globalSettings.weblimiter; }
        function recordRequestSuccess() {}
        function recordRequestError() {}
        function updateResultSummary() {}
        function getRequestFunc() { return gmRequest; }
        const GM_info = {version: "test"};
        ${["boundedRetryLimit", "assertCurrentScan", "scanDelay", "waitForSteamSlot", "sendPacedSteamRequest",
            "retryAfterDelay", "sanitizeDiagnostic", "requestFailure", "requestWithRetries",
            "requestSteam", "requestSource", "sourceWarning", "showDiscoveryProgress",
            "renderScanStatus", "showScanDiagnostic"].map(name => declaration(name)).join("\n")}
    `, context);
    return {context, starts, urls, sleeps, run: code => vm.runInContext(code, context), now: () => now};
}

test("bounded attempts retain stage/path/status and never trade query credentials", async () => {
    const h = harness(Array.from({length: 3}, () => ({status: 503})));
    await assert.rejects(h.run(`requestSteam("https://steamcommunity.com/inventory/123/753/6?token=secret12", "json", 1, "Your inventory")`),
        error => error.status === 503 && error.attempts === 3 && error.stage === "Your inventory" &&
            error.path === "/inventory/123/753/6" && !error.message.includes("secret12") &&
            !error.message.includes("rate limiting"));
    assert.equal(h.starts.length, 3);
    assert.equal(h.now(), 3000, "no extra wait after final failure");
});

test("nonretryable HTTP errors stop on first attempt, including private inventories", async () => {
    for (const status of [400, 401, 403, 404]) {
        const h = harness([{status}]);
        await assert.rejects(h.run(`requestSteam("https://steamcommunity.com/inventory/123/753/6", "json", 1)`),
            error => error.status === status && error.attempts === 1 &&
                error.type === ([401, 403].includes(status) ? "private" : "failed"));
        assert.equal(h.sleeps.length, 0);
    }
});

test("authorization guidance distinguishes Steam from external sources", () => {
    const h = harness();
    const steam = h.run(`requestFailure("https://steamcommunity.com/inventory/123/753/6", "Inventory", {status: 403}, 1).message`);
    const asf = h.run(`requestFailure("https://asf.justarchi.net/Api/Listing/Bots", "ASF", {status: 403}, 1).message`);
    assert.match(steam, /Steam sign-in and inventory\/member-list privacy/);
    assert.match(asf, /authorization and access permissions for this source/);
    assert.doesNotMatch(asf, /Steam sign-in|inventory\/member-list privacy/);
});

test("timeout and network failures remain distinct with no invented HTTP status", async () => {
    for (const event of ["timeout", "error"]) {
        const h = harness([{status: 0, event}]);
        h.run("globalSettings.maxErrors = 0");
        await assert.rejects(h.run(`requestSteam("https://steamcommunity.com/test", "json", 1)`),
            error => error.event === (event === "error" ? "network" : "timeout") &&
                error.status === 0 && error.message.includes("no HTTP status"));
    }
});

test("Retry-After seconds and HTTP-date honor waits longer than 60 seconds", async () => {
    for (const retryAfter of ["120", new Date(120000).toUTCString()]) {
        const h = harness([{status: 429, retryAfter}, {status: 200, body: {success: true}}]);
        const result = await h.run(`requestSteam("https://steamcommunity.com/test", "json", 1)`);
        assert.equal(result.success, true);
        assert.equal(h.starts[1] - h.starts[0], 120000);
        assert.ok(h.sleeps.every(delay => delay <= 250), "waits check cancellation frequently");
    }
    const h = harness();
    assert.equal(h.run('retryAfterDelay("invalid")'), 0);
    assert.equal(h.run('retryAfterDelay("-1")'), 0);
    assert.equal(h.run('retryAfterDelay("Thu, 01 Jan 1970 00:00:00 GMT", 1000)'), 0);
});

test("final 429 establishes shared cooldown without waiting; next call respects it", async () => {
    const h = harness([{status: 429, retryAfter: "90"}, {status: 200, body: "ok"}]);
    h.run("globalSettings.maxErrors = 0");
    await assert.rejects(h.run(`requestSteam("https://steamcommunity.com/test", "json", 1)`),
        error => error.status === 429 && error.attempts === 1 && error.message.includes("rate limiting"));
    assert.equal(h.sleeps.length, 0);
    assert.equal(await h.run(`requestSteam("https://steamcommunity.com/next", "json", 1)`), "ok");
    assert.equal(h.starts[1], 90000);
});

test("cancellation and generation changes interrupt Retry-After without another request", async () => {
    for (const change of ["stop = true", "scanGeneration++"]) {
        const h = harness([{status: 429, retryAfter: "120"}]);
        h.context.onSleep = () => h.run(change);
        await assert.rejects(h.run(`requestSteam("https://steamcommunity.com/test", "json", 1)`),
            error => error.type === "stopped");
        assert.equal(h.starts.length, 1);
        assert.equal(h.now(), 250);
    }
});

test("shared pacing never eases below configured limiter", async () => {
    const h = harness([{status: 200, body: "a"}, {status: 200, body: "b"}, {status: 200, body: "c"}]);
    h.run("globalSettings.weblimiter = 1500; getAdaptiveRequestDelay = () => 50");
    await h.run(`Promise.all([requestSteam("https://steamcommunity.com/a", "json", 1),
        requestSteam("https://steamcommunity.com/b", "json", 1),
        requestSteam("https://steamcommunity.com/c", "json", 1)])`);
    assert.equal(h.starts.length, 3);
    assert.ok(h.starts[1] - h.starts[0] >= 1500);
    assert.ok(h.starts[2] - h.starts[1] >= 1500);
});

test("GM source requests retry transient responses and retain HTTP headers", async () => {
    const h = harness();
    const replies = [{status: 429, responseHeaders: "Retry-After: 75\r\n"}, {status: 200, responseText: "friends"}];
    let calls = 0;
    h.context.gmRequest = options => {
        calls++;
        queueMicrotask(() => options.onload(replies.shift()));
        return {abort() { options.onabort({}); }};
    };
    assert.equal(await h.run(`requestSource("https://steamcommunity.com/actions/PlayerList/?type=friends", "Friends", 1)`), "friends");
    assert.equal(calls, 2);
    assert.equal(h.now(), 75000);
    assert.equal(h.run("activeScanRequests.size"), 0);
});

test("GM sources do not retry private errors and obsolete responses are cancelled", async () => {
    const h = harness();
    let calls = 0;
    h.context.gmRequest = options => {
        calls++;
        queueMicrotask(() => options.onload({status: 403}));
    };
    await assert.rejects(h.run(`requestSource("https://asf.justarchi.net/Api/Listing/Bots", "ASF", 1)`),
        error => error.status === 403 && error.attempts === 1);
    assert.equal(calls, 1);
    h.context.gmRequest = options => {
        h.run("scanGeneration++");
        queueMicrotask(() => options.onload({status: 200, responseText: "obsolete"}));
        return Promise.resolve();
    };
    await assert.rejects(h.run(`requestSource("https://asf.justarchi.net/Api/Listing/Bots", "ASF", 1)`),
        error => error.type === "stopped");
});

test("warnings name failures separately from intentional limits, including older caches", () => {
    const h = harness();
    h.context.cache = {
        partialFailure: true,
        sourceReports: [{name: "ASF", status: "failed", detail: "HTTP 503, 3 attempts"}, {name: "Groups", status: "limited"}],
        groupReports: [{name: "Example", kind: "limit", status: "partial: member limit"}],
    };
    const warning = h.run("sourceWarning(cache)");
    assert.match(warning, /ASF: HTTP 503/);
    assert.match(warning, /Partial by configured limits.*member limit/);
    assert.doesNotMatch(warning, /Groups: limited|could not be fetched/);
    assert.match(h.run("sourceWarning({partialFailure: true})"), /older cache has no source details/);
    assert.match(h.run(`sourceWarning({groupReports: [{name: "Group", status: "partial: private", detail: "HTTP 403"}]})`), /Groups.*HTTP 403/);
    assert.equal(h.run("sourceWarning({partialFailure: false})"), "");
    assert.doesNotMatch(h.run(`sanitizeDiagnostic("HTTP 503 https://steamcommunity.com/tradeoffer/new/?partner=1&token=secret12 token=secret12")`), /secret12/);
});

test("bottom status survives replacement, preserves warnings, and uses textContent", () => {
    class Element {
        constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.style = {}; }
        setAttribute(key, value) { this.attributes[key] = value; }
        set textContent(value) { this.text = value; this.children = []; }
        get textContent() { return this.text; }
        appendChild(child) {
            if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
            this.children.push(child);
            child.parent = this;
        }
    }
    const host = new Element();
    const button = new Element();
    const h = harness();
    h.context.document = {
        createElement: () => new Element(),
        getElementsByClassName: name => name === "maincontent" ? [host] : [],
        getElementById: id => id === "asf_stm_button_div" ? button : host.children.find(child => child.id === id),
    };
    h.run(`scanStatus.warning = "ASF: HTTP 503"; showDiscoveryProgress("Discovering");`);
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].attributes.role, "status");
    h.run(`showScanDiagnostic({message: "<img src=x>"}); showDiscoveryProgress("Scanning");`);
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].children[1].textContent, "<img src=x>");
    assert.equal(host.children[0].children[2].textContent, "ASF: HTTP 503");
    host.textContent = "replacement";
    h.run("renderScanStatus()");
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].children[2].textContent, "ASF: HTTP 503");
    h.run(`scanStatus = {progress: "", warning: "", diagnostic: ""}; renderScanStatus();`);
    assert.ok(host.children[0].children.every(row => row.hidden));
});

test("Scan Sources uses identical labelled rows without legacy margins or breaks", () => {
    const template = source.match(/const scanSourcesTemplate = ([\s\S]*?);\n        templateElement/)[1];
    const html = vm.runInNewContext(template, {
        globalSettings: {scanBots: true, scanFriends: false, scanGroups: true},
        questionmarkURL: "help.png",
    });
    const rows = [...html.matchAll(/<div class="asf-stm-scan-source">(.*?)<\/div>/g)].map(match => match[1]);
    assert.equal(rows.length, 3);
    ["scanBots", "scanFriends", "scanGroups"].forEach((id, index) => {
        assert.match(rows[index], new RegExp(`<label for="${id}"><input type="checkbox" id="${id}"`));
        assert.equal(rows[index].includes("checked"), index !== 1);
        assert.match(rows[index], /<span>.*<\/span><\/label><a class="tooltip/);
    });
    assert.doesNotMatch(html, /<br|asf-stm-margin-/);
    assert.match(source, /\.asf-stm-config \.asf-stm-scan-sources\{[^}]*gap:8px/);
    assert.doesNotMatch(source, /\.asf-stm-config fieldset label\{/);
    assert.match(source, /templateElement.innerHTML = configDialogTemplate.replace/);
});

test("discovery caches named failures, caps, and successful targets without inventing success", async () => {
    const h = harness();
    h.context.saved = [];
    h.run(`
        let bots, groupDiscoveryReports = [];
        const whitelist = [], myProfileLink = "id/me", STORAGE_PREFIX = "test";
        globalSettings.tradeUrls = [];
        const localStorage = {setItem(key, value) { saved.push(JSON.parse(value)); }};
        function getEnabledSources() { return {scanBots: true, scanFriends: false, scanGroups: true}; }
        function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
        function mergeTargets(lists) { return lists.flat(); }
        function normalizeWhitelistSteamID(id) { return id; }
        function renderScanStatus() {}
        function showDiscoveryProgress() {}
        function buttonPressedEvent(ready) { started = ready; }
        function stopEventCleanup(reason) { stoppedReason = reason; }
        requestSource = async () => { throw requestFailure("https://asf.justarchi.net/Api/Listing/Bots", "ASF", {status: 503, event: "load"}, 3); };
        async function discoverGroupTargets() {
            groupDiscoveryReports = [{name: "Example", status: "partial: member limit", kind: "limit"}];
            return [{TradePartner: "123", SourceTypes: ["groups"]}];
        }
        ${declaration("fetchBots")}
        fetchBots();
    `);
    await new Promise(setImmediate);
    const cache = h.context.saved[0];
    assert.equal(cache.Success, true);
    assert.equal(cache.Result.length, 1);
    assert.equal(cache.sourceReports[0].name, "ASF");
    assert.equal(cache.sourceReports[0].diagnostic.status, 503);
    assert.equal(cache.sourceReports[0].diagnostic.attempts, 3);
    assert.equal(cache.sourceReports[1].status, "limited");
    assert.equal(h.context.started, true);
    assert.match(h.run("scanStatus.warning"), /ASF.*HTTP 503.*Partial by configured limits/);
    h.run(`
        getEnabledSources = () => ({scanBots: true, scanFriends: false, scanGroups: false});
        started = false;
        fetchBots();
    `);
    await new Promise(setImmediate);
    assert.equal(h.context.saved[1].Success, false);
    assert.equal(h.context.started, false);
    assert.match(h.context.stoppedReason, /Failed to fetch enabled sources/);
    assert.match(h.run("scanStatus.warning"), /ASF.*HTTP 503/);
});

test("failed-only group discovery is unsuccessful but completed empty discovery succeeds", async () => {
    const h = harness();
    h.context.saved = [];
    h.run(`
        let bots, groupDiscoveryReports = [];
        const whitelist = [], myProfileLink = "id/me", STORAGE_PREFIX = "test";
        globalSettings.tradeUrls = [];
        const localStorage = {setItem(key, value) { saved.push(JSON.parse(value)); }};
        function getEnabledSources() { return {scanBots: false, scanFriends: false, scanGroups: true}; }
        function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
        function mergeTargets(lists) { return lists.flat(); }
        function normalizeWhitelistSteamID(id) { return id; }
        function renderScanStatus() {}
        function showDiscoveryProgress() {}
        function buttonPressedEvent(ready) { started = ready; }
        function stopEventCleanup(reason) { stoppedReason = reason; }
        async function discoverGroupTargets() {
            groupDiscoveryReports = [{name: "Unavailable", status: "partial: failed", kind: "failure"}];
            return [];
        }
        ${declaration("fetchBots")}
        fetchBots();
    `);
    await new Promise(setImmediate);
    assert.equal(h.context.saved[0].Success, false);
    assert.equal(h.context.started, undefined);

    h.run(`
        discoverGroupTargets = async function() {
            groupDiscoveryReports = [{name: "Empty", status: "complete"}];
            return [];
        };
        fetchBots();
    `);
    await new Promise(setImmediate);
    assert.equal(h.context.saved[1].Success, true);
    assert.equal(h.context.started, true);
});

test("group member/page/group limits retain targets and remain limit reports", async () => {
    for (const kind of ["member", "page", "group"]) {
        const h = harness();
        h.context.kind = kind;
        h.run(`
            let ownSteamID64 = "76561198000000000", groupDiscoveryReports;
            const blacklist = [];
            globalSettings.groups = [{url: "https://steamcommunity.com/groups/example"}];
            globalSettings.groupLimit = 1;
            globalSettings.groupPageLimit = kind === "page" ? 1 : 10;
            globalSettings.groupMemberLimit = kind === "member" ? 1 : 100;
            if (kind === "group") globalSettings.groups.push({url: "https://steamcommunity.com/groups/omitted"});
            async function resolveOwnSteamID64() { return ownSteamID64; }
            function getPartner(id) { return id; }
            function normalizeWhitelistSteamID(id) { return {SteamID64: id}; }
            function showDiscoveryProgress() {}
            requestSteam = async () => ({
                querySelector(selector) {
                    const values = {currentPage: "1", totalPages: kind === "page" ? "2" : "1",
                        memberCount: kind === "page" ? "4" : "2", "groupDetails > groupName": "Example"};
                    return values[selector] ? {textContent: values[selector]} : null;
                },
                querySelectorAll() { return [{textContent: "76561198000000001"}, {textContent: "76561198000000002"}]; }
            });
            ${["boundedLimit", "normalizeGroupUrl", "isUserSteamID64", "discoverGroupTargets"].map(name => declaration(name)).join("\n")}
        `);
        const targets = await h.run("discoverGroupTargets(1)");
        assert.equal(targets.length, kind === "member" ? 1 : 2);
        assert.ok(h.run("groupDiscoveryReports.some(report => report.kind === 'limit')"));
        assert.doesNotMatch(h.run("sourceWarning({groupReports: groupDiscoveryReports})"), /source discovery incomplete/);
    }
});

test("group-enabled own badge finalization scans every source and skips unavailable targets", async () => {
    function badgeDocument() {
        return {documentElement: {
            querySelector() { return {}; },
            querySelectorAll() {
                return Array.from({length: 5}, (_, number) => ({
                    querySelector(selector) {
                        if (selector === ".badge_card_set_text_qty") return {innerText: "(2)"};
                        if (selector === ".gamecard") return {src: "card.png"};
                        return {childNodes: [{nodeType: 3, textContent: `Card ${number}`}]};
                    },
                }));
            },
        }};
    }
    const h = harness([
        {status: 200, body: badgeDocument()},
        {status: 200, body: badgeDocument()},
        {status: 200, body: badgeDocument()},
        {status: 200, body: {documentElement: {querySelector() { return null; }}}},
        {status: 503},
        {status: 200, body: badgeDocument()},
    ]);
    h.context.completed = [];
    h.context.diagnostics = [];
    h.context.finished = new Promise(resolve => { h.context.finish = resolve; });
    h.run(`
        globalSettings.scanGroups = true;
        globalSettings.maxErrors = 0;
        globalSettings.anyBots = true;
        globalSettings.fairBots = true;
        globalSettings.botMinItems = 0;
        globalSettings.botMaxItems = 0;
        const Node = {TEXT_NODE: 3}, inventoryCacheGeneration = 1, blacklist = [];
        const ownSteamID64 = "76561198000000000", groupDiscoveryReports = [];
        const inventoryScanStatuses = {};
        let myBadges = [{appId: 123, title: "Game", maxCards: 5,
            cards: [4, 0, 1, 1, 1].map((count, number) => ({
                count, number, hash: "123-Card " + number, item: "Card " + number, iconUrl: "card.png"
            }))}], botBadges = [];
        let bots = {Result: [
            ["asf"], ["friends"], ["asf", "friends", "groups"], ["groups"], ["friends"], ["groups"]
        ].map((SourceTypes, i) => ({
            SourceTypes, SteamID: String(i + 1), TradePartner: String(i + 1),
            SteamID64: String(76561198000000001n + BigInt(i)), MatchEverything: true, TotalInventoryCount: 100
        }))};
        let progressRadials = {bots: {}, botBadges: {}};
        function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
        function getPartner(id) { return (BigInt(id) - 76561197960265728n).toString(); }
        function SaveParams() {}
        function updateProgress() {}
        function markProgressComplete() {}
        function getScanConcurrency() { return 2; }
        function getTargetProfileLink(target) { return "profiles/" + target.SteamID64; }
        function getTargetInventorySourceType(target) { return target.SourceTypes.join("+"); }
        function buildInventoryCacheMeta(entryType, profileId, sourceType) {
            return {entryType, profileId, sourceType, scopeKey: "123", appIds: [123]};
        }
        function buildInventoryCacheKey() { return "cache"; }
        function getInventoryCacheEntry() { return null; }
        function setInventoryCacheEntry() {}
        function setTargetInventoryStatus(target, status) {
            target.InventoryStatus = status;
            inventoryScanStatuses[status] = (inventoryScanStatuses[status] || 0) + 1;
        }
        function showScanDiagnostic(error) { diagnostics.push(error); }
        function stopEventCleanup(reason) { stoppedReason = reason; finish(); }
        function compareCards(index, callback) { completed.push(index); callback(); }
        ${["finalizeBadgeCollection", "finalizeOwnInventoryAfterLoad", "finalizeTargetInventoryAfterLoad",
            "runIndexedWorkerPool", "fetchTargetBadgeWithRetry", "scanTargetBadges", "GetCards"].map(name => declaration(name)).join("\n")}
        finalizeOwnInventoryAfterLoad();
    `);
    await h.context.finished;
    assert.deepEqual(h.context.completed, [0, 1, 2, 5]);
    assert.equal(h.urls.length, 6);
    assert.ok(h.urls.every(url => /\/profiles\/\d+\/gamecards\/123$/.test(url)), h.urls.join("\n"));
    assert.ok(h.urls.every(url => !url.includes("/inventory/")), "own and target inventory endpoints must never be called");
    assert.equal(h.run("bots.Result[3].InventoryStatus"), "private/unavailable");
    assert.equal(h.run("bots.Result[4].InventoryStatus"), "failed");
    assert.equal(h.context.diagnostics.length, 2);
    assert.match(h.context.stoppedReason, /partial/);
    assert.equal(h.run("bots.Result[2].badgesSnapshot[0].cards.length"), 5);
    assert.equal(h.run("myBadges[0].inventoryProvenance"), undefined);
});

test("badge counts produce candidates without verified provenance; groups remain neutral+ even on ASF MatchEverything", () => {
    const h = harness();
    h.run(`
        globalSettings.scanGroups = true;
        const bots = {Result: [
            {SourceTypes: ["asf"], MatchEverything: true},
            {SourceTypes: ["asf", "groups"], MatchEverything: true},
            {SourceTypes: ["groups"], MatchEverything: true}
        ]};
        function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
        function badge(counts) {
            const result = {appId: 123, title: "Game", maxCards: 5,
                cards: counts.map((count, number) => ({
                    count, number, hash: "123-" + number, item: "Card " + number, iconUrl: "card.png"
                }))};
            finalizeBadgeCollection([result], false);
            return result;
        }
        ${["finalizeBadgeCollection", "calcState", "getDuplicateCount", "buildMatchesForTarget"].map(name => declaration(name)).join("\n")}
        const own = badge([4, 0, 1, 1, 1]);
        const unfairTarget = badge([4, 1, 1, 1, 1]);
        const fairTarget = badge([0, 4, 1, 1, 1]);
        const original = JSON.stringify([own, unfairTarget, fairTarget]);
    `);
    assert.ok(h.run("buildMatchesForTarget(0, [own], [unfairTarget]).itemsToSend.length") > 0);
    for (const index of [1, 2]) {
        assert.equal(h.run(`buildMatchesForTarget(${index}, [own], [unfairTarget]).itemsToSend.length`), 0);
        assert.ok(h.run(`buildMatchesForTarget(${index}, [own], [fairTarget]).itemsToSend.length`) > 0);
    }
    assert.equal(h.run("JSON.stringify([own, unfairTarget, fairTarget]) === original"), true);
});

function offerHarness() {
    const h = harness();
    h.context.moved = [];
    h.context.alerts = [];
    h.context.confirmations = [];
    h.context.waits = [];
    h.context.reloads = [];
    h.run(`
        function element() { return {style: {}, appendChild() {}, setAttribute() {}}; }
        const document = {
            querySelectorAll(selector) {
                if (selector.includes(",")) return moved;
                return moved.filter(item => item.side === (selector.startsWith("#your") ? 0 : 1));
            },
            createElement: element,
            createTextNode(text) { return {text}; },
            body: element(),
            getElementsByClassName() { return [element()]; },
            getElementById() { return {}; }
        };
        const unsafeWindow = {
            ShowAlertDialog(title, message) { alerts.push({title, message}); },
            MoveItemToTrade(item) { moved.push(item); },
            ToggleReady(value) { confirmations.push(value); },
            CTradeOfferStateManager: {ConfirmTradeOffer() { confirmations.push("sent"); }},
            TradePageSelectInventory() {},
            document: {getElementById() { return {show() {}}; }}
        };
        const window = {
            getComputedStyle() { return {}; },
            setTimeout(callback, delay) { waits.push(delay); }
        };
        const PENDING_TRADE_KEY = "pending", PENDING_TRADE_STORE_VERSION = 1;
        function restoreCookie() {}
        function item(side) {
            return {id: String(side + 1), tradable: 1, amount: "1", market_hash_name: "123-" + side,
                type: "Trading Card", element: {side},
                tags: [{category: "item_class", internal_name: "item_class_2"},
                    {category: "cardborder", internal_name: "cardborder_0"}]};
        }
        const settings = {order: "SORT", autoSend: true, doAfterTrade: "NOTHING"};
        const offer = {
            Cards: [["123-0"], ["123-1"]], manualReview: true, inventoryLoadStartedAt: 0,
            tradeTrackingContext: {partner: "39734273"},
            Users: [0, 1].map(side => ({
                strSteamId: side === 1 ? "76561198000000001" : "76561198000000000",
                cLoadsInFlight: 0,
                loadInventory() { reloads.push(side); },
                rgContexts: {753: {6: {inventory: {
                    BuildInventoryDisplayElements() {},
                    rgInventory: {[String(side + 1)]: item(side)}
                }}}}
            }))
        };
        ${["isUserSteamID64", "getPartner", "isNormalCard", "isTradableItem"].map(name => declaration(name)).join("\n")}
        ${["mySort", "getRandomInt", "addCards", "checkContexts"].map(name => declaration(name, 8)).join("\n")}
    `);
    return h;
}

test("group match safety persists and prevents auto-send after successful live preparation", () => {
    const h = offerHarness();
    h.run(`
        globalSettings.scanGroups = true;
        const bots = {Result: [{TradePartner: "39734273", SourceTypes: ["asf", "groups"], TradeAccess: "ASF token"}]};
        const tradeParams = {matches: {}, cardNames: []};
        function SaveParams() {}
        function updateResultSummary() {}
        ${declaration("storeMatches")}
        storeMatches("76561198000000001", [], []);
        offer.manualReview = tradeParams.targetSafety["39734273"].manualReview;
        addCards(settings, offer);
    `);
    assert.equal(h.run('tradeParams.targetSafety["39734273"].manualReview'), true);
    assert.equal(h.context.moved.length, 2);
    assert.equal(h.context.confirmations.length, 0);
    assert.equal(h.context.alerts.length, 0);
    assert.deepEqual(Array.from(h.run("offer.tradeTrackingContext.sendAssetIds")), ["1"]);
    const ordinary = offerHarness();
    ordinary.run("offer.manualReview = false; addCards(settings, offer)");
    assert.deepEqual(ordinary.context.confirmations, [true, "sent"], "non-group auto-send behavior is retained");
});

test("live offer checks reject locked, missing, foil and unusable cards on either side before adding anything", () => {
    const changes = [
        "card.tradable = 0",
        "delete inventory.rgInventory[card.id]",
        'card.tags[1].internal_name = "cardborder_1"',
        "delete card.tags",
        "card.amount = 2",
        "delete card.element",
        "offer.Cards[side].push(card.market_hash_name); inventory.rgInventory.duplicate = {...card}",
    ];
    for (const side of [0, 1]) {
        for (const change of changes) {
            const h = offerHarness();
            h.run(`
                const side = ${side}, inventory = offer.Users[side].rgContexts[753][6].inventory;
                const card = Object.values(inventory.rgInventory)[0];
                ${change};
            `);
            assert.throws(() => h.run("addCards(settings, offer)"), /Insufficient live tradable cards/);
            assert.equal(h.context.moved.length, 0, `side ${side}: ${change}`);
            assert.equal(h.context.confirmations.length, 0);
            assert.match(h.context.alerts[0].message, /Nothing was added/);
        }
    }
});

test("live offer checks reject partner mismatch and nonempty offers without adding cards", () => {
    for (const [change, expected] of [
        ['offer.Users[1].strSteamId = "76561198000000002"', /partner mismatch/i],
        ['offer.Users[1].strSteamId = "invalid"', /partner mismatch/i],
        ["moved.push({side: 0})", /Offer not empty/],
    ]) {
        const h = offerHarness();
        h.run(change);
        const count = h.context.moved.length;
        assert.throws(() => h.run("addCards(settings, offer)"), expected);
        assert.equal(h.context.moved.length, count);
        assert.equal(h.context.confirmations.length, 0);
    }
});

test("unavailable and loading live inventories wait in 500 ms steps and time out before adding cards", () => {
    for (const change of [
        "offer.Users[1].rgContexts[753][6].inventory = null",
        "offer.Users[1].cLoadsInFlight = 1",
    ]) {
        const h = offerHarness();
        h.run(`${change}; checkContexts(settings, offer)`);
        assert.deepEqual(h.context.waits, [500]);
        assert.equal(h.context.moved.length, 0);
        h.run("offer.inventoryLoadStartedAt = -60001; checkContexts(settings, offer)");
        assert.equal(h.context.alerts.at(-1).title, "Inventory unavailable");
        assert.equal(h.context.waits.length, 1, "timeout does not schedule another inventory wait");
        assert.equal(h.context.moved.length, 0);
        assert.equal(h.context.confirmations.length, 0);
    }
});

test("queued badge requests do not dispatch after worker-pool cancellation", async () => {
    const h = harness();
    h.run("steamCooldownUntil = 90000; let cancelled = false");
    h.context.onSleep = () => h.run("cancelled = true");
    await assert.rejects(h.run(`new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        sendPacedSteamRequest(xhr, 1, reject, () => !cancelled);
    })`), error => error.type === "stopped");
    assert.equal(h.starts.length, 0);
    assert.equal(h.now(), 250, "pool cancellation interrupts a long wait");
});

test("ordinary badge workers retain status, attempts, path and timeout/network events", async () => {
    for (const worker of ["fetchOwnBadgeWithRetry", "fetchTargetBadgeWithRetry"]) {
        for (const reply of [{status: 503}, {status: 403}, {status: 0, event: "timeout"}, {status: 0, event: "error"}]) {
            const h = harness([reply]);
            h.run(`
                globalSettings.maxErrors = 0;
                const myProfileLink = "id/me", myBadges = [];
                function updateProgress() {}
                function getTargetProfileLink() { return "id/target"; }
                ${declaration(worker)}
            `);
            const call = worker === "fetchOwnBadgeWithRetry" ?
                `fetchOwnBadgeWithRetry([{appId: 123, cards: []}], 0, new Set(), {cancelled: false})` :
                `fetchTargetBadgeWithRetry([{appId: 123, cards: []}], 0, {}, {value: undefined}, {cancelled: false})`;
            await assert.rejects(h.run(call), error => error.attempts === 1 &&
                error.status === reply.status && error.path.endsWith("/123") &&
                error.event === (reply.event === "error" ? "network" : reply.event || "load"));
            assert.equal(h.starts.length, 1);
            assert.equal(h.sleeps.length, 0);
        }
    }
});

test("ordinary target scan publishes structured failures and skips to the next target", async () => {
    const h = harness();
    h.run(`
        const inventoryCacheGeneration = 1;
        let bots = {Result: [{}]}, botBadges = [{appId: 123}];
        function getScanConcurrency() { return 1; }
        async function runIndexedWorkerPool() {
            throw requestFailure("https://steamcommunity.com/id/target/gamecards/123", "Target badge inventory", {status: 503, event: "load"}, 3);
        }
        function updateProgress() {}
        function setTargetInventoryStatus(target, status) { target.InventoryStatus = status; }
        function showScanDiagnostic(error) { diagnostic = error.message; }
        function GetCards(index, userindex) { advancedTo = userindex; }
        ${declaration("scanTargetBadges")}
        scanTargetBadges(0);
    `);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.equal(h.context.advancedTo, 1);
    assert.equal(h.run("bots.Result[0].InventoryStatus"), "failed");
    assert.match(h.context.diagnostic, /Target badge inventory.*HTTP 503, 3 attempt/);
});
