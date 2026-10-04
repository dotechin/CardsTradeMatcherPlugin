const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../CardsTradeMatcherPlugin.user.js"), "utf8");
function declaration(name) {
    const start = source.search(new RegExp(`^    (?:async )?function ${name}\\(`, "m"));
    assert.notEqual(start, -1, name);
    const rest = source.slice(start);
    const end = rest.slice(1).search(/\n    (?:(?:async )?function |\/\/Main)/);
    return end < 0 ? rest : rest.slice(0, end + 1);
}

function harness(responses = []) {
    let now = 0;
    const starts = [];
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
            getResponseHeader() { return this.reply.retryAfter || null; }
            send() {
                starts.push(now);
                this.reply = responses.shift();
                assert.ok(this.reply, "unexpected request");
                this.status = this.reply.status;
                this.response = this.reply.body ?? null;
                queueMicrotask(() => this[`on${this.reply.event || "load"}`]());
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
        ${["boundedRetryLimit", "assertCurrentScan", "scanDelay", "waitForSteamSlot",
            "retryAfterDelay", "sanitizeDiagnostic", "requestFailure", "requestWithRetries",
            "requestSteam", "requestSource", "sourceWarning", "showDiscoveryProgress",
            "renderScanStatus", "showScanDiagnostic"].map(declaration).join("\n")}
    `, context);
    return {context, starts, sleeps, run: code => vm.runInContext(code, context), now: () => now};
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
            ${["boundedLimit", "normalizeGroupUrl", "isUserSteamID64", "discoverGroupTargets"].map(declaration).join("\n")}
        `);
        const targets = await h.run("discoverGroupTargets(1)");
        assert.equal(targets.length, kind === "member" ? 1 : 2);
        assert.ok(h.run("groupDiscoveryReports.some(report => report.kind === 'limit')"));
        assert.doesNotMatch(h.run("sourceWarning({groupReports: groupDiscoveryReports})"), /source discovery incomplete/);
    }
});

test("own verified inventory failure stops safely; individual target failure advances", async () => {
    const h = harness();
    h.run(`
        globalSettings.scanGroups = true;
        let ownInventoryVerifiedGeneration = -1, ownBadgeTemplates, myBadges = [];
        function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
        async function resolveOwnSteamID64() { return "76561198000000000"; }
        async function loadVerifiedInventory() { throw {type: "private", message: "Your inventory: HTTP 403"}; }
        function showScanDiagnostic(error) { diagnostic = error.message; }
        function stopEventCleanup(reason) { stoppedReason = reason; }
        ${declaration("finalizeOwnInventoryAfterLoad")}
        finalizeOwnInventoryAfterLoad();
    `);
    await new Promise(setImmediate);
    assert.match(h.context.stoppedReason, /scan stopped safely/);
    assert.equal(h.run("ownInventoryVerifiedGeneration"), -1);
    h.run(`
        let bots = {Result: [{SteamID64: "76561198000000001"}]};
        let progressRadials = {botBadges: {textElement: {}}};
        function setTargetInventoryStatus(target, status) { target.InventoryStatus = status; }
        function updateProgress() {}
        function GetCards(index, userindex) { advancedTo = userindex; }
        function updateResultSummary() {}
        ${declaration("scanVerifiedTarget")}
        scanVerifiedTarget(0);
    `);
    await new Promise(setImmediate);
    assert.equal(h.context.advancedTo, 1);
    assert.equal(h.run("bots.Result[0].InventoryStatus"), "private/unavailable");
    assert.equal(h.run("bots.Result[0].inventorySnapshot"), undefined);
});
