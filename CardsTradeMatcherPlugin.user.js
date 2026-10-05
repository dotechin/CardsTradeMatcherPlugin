// ==UserScript==
// @name            CardsTradeMatcherPlugin
// @namespace       https://greasyfork.org/users/738914
// @description     ASF bot, friend and optional Steam group trade matcher
// @license         Apache-2.0
// @author          Rudokhvist
// @author          iBreakEverything
// @author          dotechin
// @match           *://steamcommunity.com/id/*/badges
// @match           *://steamcommunity.com/id/*/badges/
// @match           *://steamcommunity.com/profiles/*/badges
// @match           *://steamcommunity.com/profiles/*/badges/
// @match           *://steamcommunity.com/tradeoffer/new/*
// @version         6.5.0.2
// @homepageURL     https://github.com/dotechin/CardsTradeMatcherPlugin
// @supportURL      https://github.com/dotechin/CardsTradeMatcherPlugin/issues
// @downloadURL     https://raw.githubusercontent.com/dotechin/CardsTradeMatcherPlugin/main/CardsTradeMatcherPlugin.user.js
// @updateURL       https://raw.githubusercontent.com/dotechin/CardsTradeMatcherPlugin/main/CardsTradeMatcherPlugin.user.js
// @connect         asf.justarchi.net
// @grant           GM.xmlHttpRequest
// @grant           GM_addStyle
// @grant           GM_xmlhttpRequest
// ==/UserScript==

(function () {
    "use strict";

    let myProfileLink = "";
    let errors = 0;
    let bots = null;
    let myBadges = [];
    let botBadges = [];
    let maxPages;
    let stop = false;
    let botCacheTime = 5 * 60000;
    let cacheBypassActive = false;
    let globalSettings = null;
    let blacklist = [];
    let whitelist = [];
    let progressRadials = {
        scanPages: {currentStep: 0, steps: 0, radialElement: null, textElement: null},
        badges: {currentStep: 0, steps: 0, radialElement: null, textElement: null},
        bots: {currentStep: 0, steps: 0, radialElement: null, textElement: null},
        botBadges: {currentStep: 0, steps: 0, radialElement: null, textElement: null}
    };
    const STORAGE_PREFIX = "TempAsfStm.ASF.STM.Unified";
    const CACHE_SCHEMA_VERSION = 2;
    const INVENTORY_CACHE_KEY = `${STORAGE_PREFIX}.InventoryCache.v${CACHE_SCHEMA_VERSION}`;
    const PENDING_TRADE_STORE_VERSION = 1;
    const COMPLETED_TRADE_STORE_VERSION = 1;
    const PENDING_TRADE_KEY = `${STORAGE_PREFIX}.PendingTrades.v${PENDING_TRADE_STORE_VERSION}`;
    const COMPLETED_TRADE_KEY = `${STORAGE_PREFIX}.CompletedTrades.v${COMPLETED_TRADE_STORE_VERSION}`;
    const STM_TRADE_MARKER_PREFIX = "ASFSTM";
    const INVENTORY_CACHE_DEFAULT_MAX_ENTRIES = 1500;
    let defaultSettings = {
        scanBots: true,
        scanFriends: true,
        scanGroups: false,
        groups: [],
        groupLimit: 3,
        groupMemberLimit: 100,
        groupPageLimit: 10,
        tradeUrls: [],
        anyBots: true,
        fairBots: true,
        sortByName: true,
        sortBotsBy: ["MatchEverythingFirst", "TotalGamesCountDesc", "TotalItemsCountDesc", "TotalInventoryCountAsc", "None"],
        botMinItems: 0,
        botMaxItems: 0,
        weblimiter: 300,
        errorLimiter: 30000,
        debug: false,
        maxErrors: 3,
        scanConcurrency: 3,
        filterBackgroundColor: "rgba(23,26,33,0.8)",
        preventClose: true,
        // for trade offer
        tradeMessage: "ASF STM Matcher",
        autoSend: false,
        doAfterTrade: "NOTHING",
        order: "AS_IS",
        // scan filters
        useScanFilters: false,
        scanFilters: [],
        autoAddScanFilters: true,
        autoDeleteScanFilters: true,
        enableInventoryCache: true,
        inventoryCacheTtlMinutes: 5,
        inventoryCacheMaxEntries: INVENTORY_CACHE_DEFAULT_MAX_ENTRIES,
        forceFreshScan: false,
    };
    let cacheStats = {
        freshHits: 0,
        staleHits: 0,
        misses: 0,
        writes: 0,
        refreshWrites: 0,
        evictions: 0,
        refreshFailures: 0,
        saveFailures: 0,
        mode: "disabled",
    };
    let inventoryRefreshQueue = [];
    let inventoryRefreshRunning = false;
    let inventoryCacheStore = null;
    let inventoryCacheGeneration = 0;
    let scanGeneration = 0;
    let adaptiveRequestDelay = null;
    let lastAdaptiveDecayAt = 0;
    let ownInventorySnapshotTime = 0;
    let ownSteamID64 = null;
    let groupDiscoveryReports = [];
    let inventoryScanStatuses = {};
    const activeScanRequests = new Set();
    let steamCooldownUntil = 0;
    let nextSteamRequestAt = 0;
    let scanStatus = {progress: "", warning: "", diagnostic: ""};
    let pendingTradeStore = null;
    let completedTradeStore = null;
    let tradeRefreshInFlight = false;
    let tradeTrackingClearedAt = 0;
    let cardNames = new Set();
    let tradeParams = {
        matches: {},
        filter: [],
    };
    let resultView = {
        sourceFilter: "all",
        grouping: "combined",
    };
    /* Mutation observer for filter counting */
    const observer = new MutationObserver((mutationList, observer) => {
        for (const mutation of mutationList) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'data-count') {
                mutation.target.querySelector('b').innerText = `(${mutation.target.dataset.count})`
            }
        }
    });

    //styles
    const configCss = `
        .asf-stm-config{width:min(720px,calc(100vw - 64px));height:auto;margin:0;font-size:13px;line-height:1.5;color:#dfe3e6}
        .asf-stm-config *{box-sizing:border-box}
        .asf-stm-config .asf_stm_tabs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));width:100%;margin:0;padding:0;list-style:none}
        .asf-stm-config .asf_stm_tab{display:contents;float:none}
        .asf-stm-config .asf_stm_tab>label{display:flex;align-items:center;justify-content:center;grid-row:1;padding:10px 8px;text-align:center;background:#1b2838;border:1px solid #354658;color:#c7d5e0;overflow-wrap:anywhere}
        .asf-stm-config .asf_stm_tab>input:focus-visible+label{outline:2px solid #66c0f4;outline-offset:-3px}
        .asf-stm-config .asf_stm_tab>input:checked+label{background:#303030;border-bottom-color:#303030;color:#fff}
        .asf-stm-config .asf_stm_content{grid-column:1/-1;grid-row:2;position:static;width:100%;height:min(56vh,480px);min-height:180px;padding:16px;overflow:auto;background:#303030;border:1px solid #354658;border-top:0}
        .asf-stm-config fieldset{min-width:0;margin:0 0 14px;padding:12px;border:1px solid #4a515b;border-radius:3px}
        .asf-stm-config .asf-stm-scan-sources{display:flex;flex-direction:column;gap:8px}
        .asf-stm-config .asf-stm-scan-source{display:flex;align-items:center;gap:8px;min-height:24px;margin:0;line-height:1.4}
        .asf-stm-config .asf-stm-scan-source label{display:flex;align-items:center;gap:8px;margin:0;min-width:0}
        .asf-stm-config .asf-stm-scan-source input.asf-stm-checkbox{margin:0;flex-shrink:0}
        #asf_stm_status{position:static;margin:16px 0;padding:10px;border-top:1px solid #4a515b;line-height:1.5;overflow-wrap:anywhere;color:#c7d5e0}
        #asf_stm_status [data-status-row=warning]{color:#e5c07b}
        #asf_stm_status [data-status-row=diagnostic]{color:#ff7b72}
        .asf-stm-config legend{padding:0 6px;color:#66c0f4;font-size:11px;letter-spacing:.06em}
        .asf-stm-config .asf-stm-input,.asf-stm-config .asf-stm-select,.asf-stm-config .asf-stm-textarea{border:1px solid #4a515b;border-radius:3px;padding:6px 8px;max-width:100%;font:inherit}
        .asf-stm-config .asf-stm-input[type=number]{width:100px}
        .asf-stm-config .asf-stm-input[type=color]{width:48px;height:30px;padding:2px;vertical-align:middle}
        .asf-stm-config .asf-stm-textarea{display:block;width:100%;resize:vertical}
        .asf-stm-config .asf-stm-checkbox{vertical-align:middle;margin:4px 6px}
        .asf-stm-config .asf-stm-margin-bottom{margin-bottom:10px}
        .asf-stm-config .asf-stm-span{vertical-align:middle}
        .asf-stm-config .tooltip img{width:16px;height:16px;vertical-align:middle;margin-left:4px}
        .asf-stm-config button{cursor:pointer}
        .asf-stm-config p{margin:0 0 10px}
        .asf-stm-config .asf-stm-group-defaults{display:grid;grid-template-columns:minmax(0,1fr) 100px;gap:8px 12px;align-items:center;margin-bottom:12px}
        .asf-stm-config .asf-stm-group-add{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        .asf-stm-config #addGroupUrl{flex:1;min-width:160px}
        .asf-stm-config #groupSettingsStatus{margin-top:8px;color:#c7d5e0;overflow-wrap:anywhere}
        .asf-stm-config .asf-stm-group-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid #4a515b}
        .asf-stm-config .asf-stm-group-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#66c0f4}
        .asf-stm-config .asf-stm-group-row label{display:flex;align-items:center;gap:6px;white-space:nowrap}
        .asf-stm-config .asf-stm-group-row .asf-stm-input{width:76px}
        .asf-stm-config .asf-stm-group-row button{white-space:nowrap}
        @media(max-width:540px){
            .asf-stm-config .asf_stm_tabs{grid-template-columns:repeat(3,minmax(0,1fr))}
            .asf-stm-config .asf_stm_tab>label{grid-row:auto}
            .asf-stm-config .asf_stm_content{grid-row:3;padding:10px}
            .asf-stm-config .asf-stm-group-row{grid-template-columns:auto minmax(0,1fr) auto}
            .asf-stm-config .asf-stm-group-name{grid-column:2/-1}
            .asf-stm-config .asf-stm-group-row label{grid-column:span 1;flex-direction:column;align-items:flex-start;gap:2px}
        }
    `;
    const css = `#asf_stm_filters_body{max-height:calc(100vh - 95px);overflow-y:auto}.asf_stm_tabs{width:600px;display:block;margin:40px auto;position:relative}.asf_stm_tabs .asf_stm_tab{float:left;display:block}.asf_stm_tabs .asf_stm_tab>input[type="radio"]{position:absolute;top:-9999px;left:-9999px}.asf_stm_tabs .asf_stm_tab>label{display:block;padding:6px 21px;cursor:pointer;position:relative;color:#FFF;background:#4A83FD}.asf_stm_tabs .asf_stm_content{display:none;overflow:scroll;width:630px;height:380px;padding:5px;position:absolute;left:0;background:#303030;color:#DFDFDF}.asf_stm_tabs>.asf_stm_tab>[id^="asf_stm_tab"]:checked+label{top:0;background:#303030;color:#F5F5F5}.asf_stm_tabs>.asf_stm_tab>[id^="asf_stm_tab"]:checked~ [id^="asf_stm_tab-content"]{display:block}textarea{resize:none}.asf-stm-checkbox,.asf-stm-range{filter:invert(90%) hue-rotate(185deg) brightness(1.2)}.asf-stm-select,.asf-stm-input,.asf-stm-textarea{background-color:#171d25;color:white}.asf-stm-config{height:420px;margin-top:-20px;font-size:12px;margin-left:-20px;width:620px}.asf-stm-span{max-width:45%;width:45%;display:inline-block}.asf-stm-input{max-width:45%}.asf-stm-margin-right{margin-right:.4em}.asf-stm-margin-bottom{margin-bottom:.5em}.friendBlock{width:32%}input.appid-validity:invalid{background:#ff000030}input.appid-validity:valid{background:#00ff0030}.playerAvatar img.stretch:hover{width:85px}.progress-container{display:flex;justify-content:space-between;width:100%;max-width:600px;gap:1rem}.progress-step{display:flex;flex-direction:column;align-items:center;flex:1}.radial-progress{position:relative;width:74px;height:74px;border-radius:50%;background:conic-gradient(#90ba3c var(--progress), #333 0deg);display:flex;align-items:center;justify-content:center;transition:--progress 1s ease}.progress-inner{position:absolute;width:68px;height:68px;background:#121212;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:0.85rem;color:#fff;text-align:center}.full-blue{background:#53a4c4 !important;border-radius:50%;transition:none !important}.label{margin-top:0.5rem;font-size:0.9rem;color:#bbb;text-align:center}@property --progress{syntax:'<angle>';initial-value:0deg;inherits:false}`;

    function deepClone(object) {
        return JSON.parse(JSON.stringify(object));
    }

    function boundedLimit(value, fallback, maximum) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 1 ? Math.min(maximum, Math.floor(number)) : fallback;
    }

    function boundedRetryLimit(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.min(5, Math.floor(number))) : 3;
    }

    function isUserSteamID64(value) {
        if (!/^\d{17}$/.test(String(value))) {
            return false;
        }
        const id = BigInt(value);
        return id > 76561197960265728n && id <= 76561202255233023n;
    }

    function normalizeGroupUrl(value) {
        const url = new URL(String(value).trim());
        if (url.protocol !== "https:" || url.hostname !== "steamcommunity.com" || url.port || url.username || url.password || url.search || url.hash ||
            !/^\/(?:groups\/[A-Za-z0-9_-]+|gid\/\d{18})\/?$/.test(url.pathname)) {
            throw new Error("Use an https://steamcommunity.com/groups/name or /gid/ID group URL");
        }
        return `https://steamcommunity.com${url.pathname.replace(/\/$/, "")}`;
    }

    function parseTradeUrl(value, expectedPartner) {
        const url = new URL(String(value).trim());
        const partner = url.searchParams.get("partner");
        const token = url.searchParams.get("token");
        if (url.protocol !== "https:" || url.hostname !== "steamcommunity.com" || url.port || url.username || url.password || url.hash ||
            url.pathname !== "/tradeoffer/new/" || !/^[1-9]\d{0,9}$/.test(partner || "") || Number(partner) > 4294967295 ||
            (expectedPartner !== undefined && partner !== String(expectedPartner)) ||
            !/^[A-Za-z0-9_-]{8}$/.test(token || "") ||
            url.searchParams.getAll("partner").length !== 1 || url.searchParams.getAll("token").length !== 1 ||
            Array.from(url.searchParams.keys()).some(key => key !== "partner" && key !== "token")) {
            throw new Error("Invalid Steam trade URL or mismatched partner");
        }
        return {partner, token, url: `https://steamcommunity.com/tradeoffer/new/?partner=${partner}&token=${token}`};
    }

    function assertCurrentScan(generation) {
        if (stop || generation !== scanGeneration) {
            throw {type: "stopped"};
        }
    }

    async function scanDelay(delay, generation, isCurrent = () => true) {
        const deadline = Date.now() + Math.max(0, delay);
        while (Date.now() < deadline) {
            assertCurrentScan(generation);
            if (!isCurrent()) {
                throw {type: "stopped"};
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
        }
        assertCurrentScan(generation);
        if (!isCurrent()) {
            throw {type: "stopped"};
        }
    }

    async function waitForSteamSlot(generation, isCurrent = () => true) {
        while (true) {
            assertCurrentScan(generation);
            if (!isCurrent()) {
                throw {type: "stopped"};
            }
            const wait = Math.max(steamCooldownUntil, nextSteamRequestAt) - Date.now();
            if (wait > 0) {
                await scanDelay(wait, generation, isCurrent);
                continue;
            }
            nextSteamRequestAt = Date.now() + Math.max(Number(globalSettings.weblimiter) || 0, getAdaptiveRequestDelay());
            return;
        }
    }

    function sendPacedSteamRequest(xhr, generation, onCancelled, isCurrent = () => true, onDispatch = () => {}) {
        waitForSteamSlot(generation, isCurrent).then(() => {
            assertCurrentScan(generation);
            if (!isCurrent()) {
                throw {type: "stopped"};
            }
            activeScanRequests.add(xhr);
            xhr.addEventListener("loadend", () => {
                activeScanRequests.delete(xhr);
                if (generation === scanGeneration && xhr.status === 429) {
                    recordRequestError();
                    steamCooldownUntil = Math.max(steamCooldownUntil, Date.now() +
                        Math.max(5000, Number(globalSettings.errorLimiter) || 1000, retryAfterDelay(xhr.getResponseHeader("Retry-After"))));
                }
            });
            xhr.onabort = () => onCancelled({type: "stopped"});
            onDispatch();
            xhr.send();
        }).catch(onCancelled);
    }

    function retryAfterDelay(value, now = Date.now()) {
        if (!value) {
            return 0;
        }
        const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000 :
            /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value.trim()) ? Date.parse(value) - now : 0;
        return Number.isFinite(delay) ? Math.max(0, delay) : 0;
    }

    function sanitizeDiagnostic(value, maximum = 700) {
        return String(value ?? "").replace(/https?:\/\/[^\s<>"']+/gi, match => {
            try {
                const url = new URL(match);
                return `${url.origin}${url.pathname}`;
            } catch (_) {
                return "[URL removed]";
            }
        }).replace(/(?:token|access_token|key)\s*[=:]\s*[^&\s<>"']+/gi, "[credential removed]")
            .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
    }

    function requestFailure(url, stage, response, attempts) {
        const path = new URL(url).pathname;
        const steam = new URL(url).hostname === "steamcommunity.com";
        const status = Number(response.status) || 0;
        const event = response.event || "network";
        const detail = status ? `HTTP ${status}${event !== "load" ? ` (${event})` : ""}` : `${event}; no HTTP status`;
        const guidance = status === 429 ? "Server reported rate limiting (429). Wait before retrying; reduce parallel requests." :
            status === 401 || status === 403 ? steam ? "Check Steam sign-in and inventory/member-list privacy or permissions." : "Check authorization and access permissions for this source." :
            status === 404 ? "Check that the profile/group or endpoint still exists." :
            status >= 400 && status < 500 && status !== 408 ? "Check the request/endpoint; this response is not retried." :
            "Check connectivity and Steam/ASF availability. Try parallel requests 1 and web limiter 1500 ms; this is not a guaranteed fix.";
        return {
            type: status === 401 || status === 403 ? "private" : "failed",
            stage: sanitizeDiagnostic(stage), path, status, event, attempts,
            message: `${sanitizeDiagnostic(stage)}: ${path} — ${detail}, ${attempts} attempt(s). ${guidance}`,
        };
    }

    async function requestWithRetries(url, stage, generation, send) {
        const retries = boundedRetryLimit(globalSettings.maxErrors);
        for (let attempt = 0; attempt <= retries; attempt++) {
            assertCurrentScan(generation);
            const steam = new URL(url).hostname === "steamcommunity.com";
            if (steam) {
                await waitForSteamSlot(generation);
            }
            assertCurrentScan(generation);
            let response;
            try {
                response = await send();
            } catch (error) {
                if (error?.type === "stopped") {
                    throw error;
                }
                response = {status: 0, event: "network"};
            }
            assertCurrentScan(generation);
            if (response.event === "load" && response.status === 200 && response.body != null) {
                recordRequestSuccess();
                return response.body;
            }
            recordRequestError();
            const failure = requestFailure(url, stage, response, attempt + 1);
            const transient = response.event === "network" || response.event === "timeout" ||
                !response.status || response.status === 408 || response.status === 429 || response.status >= 500;
            const delay = Math.max(1000, Number(globalSettings.errorLimiter) || 1000) * (attempt + 1);
            const backoff = response.status === 429 ?
                Math.max(delay, 5000 * Math.pow(2, attempt), retryAfterDelay(response.retryAfter)) : delay;
            // Keep the cooldown even on exhaustion so other workers/refreshes cannot storm Steam.
            if (steam && transient) {
                steamCooldownUntil = Math.max(steamCooldownUntil, Date.now() + backoff);
            }
            if (!transient || attempt === retries) {
                throw failure;
            }
            await scanDelay(backoff, generation);
        }
    }

    async function requestSteam(url, responseType, generation, stage = "Steam request") {
        return requestWithRetries(url, stage, generation, () => {
            return new Promise(resolve => {
                const xhr = new XMLHttpRequest();
                xhr.open("GET", url, true);
                xhr.responseType = responseType;
                xhr.timeout = 30000;
                activeScanRequests.add(xhr);
                const finish = event => {
                    activeScanRequests.delete(xhr);
                    resolve({status: xhr.status, body: xhr.response, event,
                        retryAfter: xhr.getResponseHeader("Retry-After")});
                };
                xhr.onload = () => finish("load");
                xhr.onerror = () => finish("network");
                xhr.ontimeout = () => finish("timeout");
                xhr.onabort = () => finish("abort");
                xhr.send();
            });
        });
    }

    async function requestSource(url, stage, generation) {
        return requestWithRetries(url, stage, generation, () => {
            return new Promise(resolve => {
                let handle;
                let finished = false;
                const finish = (response, event) => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    activeScanRequests.delete(handle);
                    resolve({status: response?.status || 0, body: response?.responseText ?? response?.response, event,
                        retryAfter: response?.responseHeaders?.match(/^Retry-After:\s*(.+)$/im)?.[1]?.trim()});
                };
                handle = getRequestFunc()({
                    method: "GET", url, timeout: 30000,
                    headers: {"User-Agent": "ASF-STM/" + GM_info.version},
                    onload: response => finish(response, "load"),
                    onerror: response => finish(response, "network"),
                    ontimeout: response => finish(response, "timeout"),
                    onabort: response => finish(response, "abort"),
                });
                if (!finished && typeof handle?.abort === "function") {
                    activeScanRequests.add(handle);
                }
                if (typeof handle?.catch === "function") {
                    handle.catch(response => finish(response, "network"));
                }
            });
        });
    }

    async function resolveOwnSteamID64(generation) {
        assertCurrentScan(generation);
        if (ownSteamID64) {
            return ownSteamID64;
        }
        const numericId = myProfileLink.match(/^profiles\/(\d{17})$/)?.[1];
        if (isUserSteamID64(numericId)) {
            ownSteamID64 = numericId;
        } else {
            const profile = await requestSteam(`https://steamcommunity.com/${sanitizeSteamProfilePath(myProfileLink)}/?xml=1`, "document", generation, "Verify your profile");
            const id = profile.querySelector("profile > steamID64")?.textContent.trim();
            if (!isUserSteamID64(id)) {
                throw {type: "failed", message: "Could not verify your SteamID64"};
            }
            ownSteamID64 = id;
        }
        return ownSteamID64;
    }

    function showDiscoveryProgress(message) {
        message = sanitizeDiagnostic(message);
        const button = document.getElementById("asf_stm_button_div");
        if (button) {
            button.setAttribute("title", message);
        }
        scanStatus.progress = message;
        renderScanStatus();
        updateResultSummary();
    }

    function renderScanStatus() {
        const host = document.getElementsByClassName("maincontent")[0];
        if (!host) {
            return;
        }
        let status = document.getElementById("asf_stm_status");
        if (!status) {
            status = document.createElement("div");
            status.id = "asf_stm_status";
            status.setAttribute("role", "status");
            status.setAttribute("aria-live", "polite");
            status.setAttribute("aria-atomic", "true");
        }
        host.appendChild(status);
        status.textContent = "";
        for (const key of ["progress", "diagnostic", "warning"]) {
            const row = document.createElement("div");
            row.dataset.statusRow = key;
            row.textContent = scanStatus[key];
            row.hidden = !scanStatus[key];
            status.appendChild(row);
        }
    }

    function showScanDiagnostic(error) {
        scanStatus.diagnostic = sanitizeDiagnostic(error?.message || "Request failed; no HTTP status available");
        renderScanStatus();
    }

    function sourceWarning(cache) {
        const reports = Array.isArray(cache?.sourceReports) ? cache.sourceReports : [];
        const failures = reports.filter(report => !["complete", "limited", "partial"].includes(report.status))
            .map(report => `${report.name}: ${report.detail || report.status}`);
        const groups = Array.isArray(cache?.groupReports) ? cache.groupReports : [];
        const limits = groups.filter(report => report.kind === "limit" || /limit/.test(report.status));
        groups.filter(report => report.status !== "complete" && report.status !== "discovering" && !limits.includes(report))
            .forEach(report => failures.push(`Groups (${report.name}): ${report.detail || report.status}`));
        const parts = [];
        if (failures.length) {
            parts.push(`Warning: source discovery incomplete — ${failures.join("; ")}. Successfully discovered targets are retained.`);
        }
        if (limits.length) {
            parts.push(`Partial by configured limits — ${limits.map(report => `${report.name}: ${report.status}`).join("; ")}.`);
        }
        if (cache?.partialFailure && !reports.length && !failures.length) {
            parts.push("Warning: cached discovery was partial; older cache has no source details. Bypass the next scan cache to diagnose.");
        }
        return sanitizeDiagnostic(parts.join(" "), 20000);
    }

    async function discoverGroupTargets(generation) {
        await resolveOwnSteamID64(generation);
        assertCurrentScan(generation);
        const groups = globalSettings.groups.filter(group => group.enabled !== false);
        const limit = boundedLimit(globalSettings.groupLimit, 3, 100);
        const targets = [];
        groupDiscoveryReports = [];
        if (groups.length > limit) {
            groupDiscoveryReports.push({name: "Groups", members: 0, pages: 0, kind: "limit", status: `partial: ${groups.length - limit} groups omitted by limit`});
        }
        for (const group of groups.slice(0, limit)) {
            assertCurrentScan(generation);
            const report = {name: group.url, members: 0, pages: 0, status: "discovering"};
            groupDiscoveryReports.push(report);
            const seen = new Set();
            const pageLimit = boundedLimit(group.pageLimit, boundedLimit(globalSettings.groupPageLimit, 10, 1000), 1000);
            const memberLimit = boundedLimit(group.memberLimit, boundedLimit(globalSettings.groupMemberLimit, 100, 10000), 10000);
            try {
                const groupUrl = normalizeGroupUrl(group.url);
                let totalPages = 1;
                let totalMembers = 0;
                for (let page = 1; page <= totalPages && page <= pageLimit; page++) {
                    const xml = await requestSteam(`${groupUrl}/memberslistxml/?xml=1&p=${page}`, "document", generation, "Groups member discovery");
                    const currentPage = Number(xml.querySelector("currentPage")?.textContent);
                    totalPages = Number(xml.querySelector("totalPages")?.textContent);
                    totalMembers = Number(xml.querySelector("memberCount")?.textContent);
                    const members = Array.from(xml.querySelectorAll("members > steamID64"), node => node.textContent.trim());
                    if (xml.querySelector("parsererror") || currentPage !== page || !Number.isSafeInteger(totalPages) || (totalPages < page && !(totalPages === 0 && totalMembers === 0)) ||
                        !Number.isSafeInteger(totalMembers) || totalMembers < 0 || (members.length === 0 && totalMembers > 0) ||
                        members.some(id => !isUserSteamID64(id))) {
                        throw {type: "failed", message: "Unexpected Steam member XML"};
                    }
                    report.name = xml.querySelector("groupDetails > groupName")?.textContent.trim() || groupUrl;
                    report.pages++;
                    if (totalMembers === 0) {
                        report.status = "complete";
                        break;
                    }
                    let capped = false;
                    for (const id of members) {
                        if (seen.has(id)) {
                            continue;
                        }
                        seen.add(id);
                        const partner = getPartner(id);
                        if (id === ownSteamID64 || blacklist.includes(partner) || blacklist.includes(id)) {
                            continue;
                        }
                        if (report.members >= memberLimit) {
                            capped = true;
                            break;
                        }
                        const target = normalizeWhitelistSteamID(id);
                        target.SourceTypes = ["groups"];
                        target.GroupNames = [report.name];
                        target.TradeAccess = "unknown";
                        targets.push(target);
                        report.members++;
                    }
                    report.status = capped || (report.members >= memberLimit && page < totalPages) ? "partial: member limit" :
                        page === totalPages ? (seen.size < totalMembers ? "partial: member list incomplete" : "complete") : "discovering";
                    showDiscoveryProgress(`${report.name}: ${report.pages}/${totalPages} pages; ${report.members} eligible members; ${report.status}`);
                    if (capped || (report.members >= memberLimit && page < totalPages)) {
                        report.kind = "limit";
                        break;
                    }
                    if (page === pageLimit && page < totalPages) {
                        report.status = "partial: page limit";
                        report.kind = "limit";
                    }
                    if (page < totalPages && page < pageLimit) {
                        await scanDelay(getAdaptiveRequestDelay(), generation);
                    }
                }
            } catch (error) {
                if (error?.type === "stopped") {
                    throw error;
                }
                report.status = `partial: ${error?.type || "failed"}`;
                report.kind = "failure";
                report.detail = sanitizeDiagnostic(error?.message || report.status);
                report.diagnostic = error?.path ? {stage: error.stage, path: error.path, status: error.status, event: error.event, attempts: error.attempts} : undefined;
            }
        }
        return targets;
    }

    function isNormalCard(description) {
        const tags = description?.tags;
        return Array.isArray(tags) &&
            tags.some(tag => tag.category === "item_class" && tag.internal_name === "item_class_2") &&
            tags.some(tag => tag.category === "cardborder" && tag.internal_name === "cardborder_0");
    }

    function isTradableItem(item) {
        return item?.tradable === 1 || item?.tradable === "1" || item?.tradable === true;
    }

    function setTargetInventoryStatus(target, status) {
        if (target.CountedInventoryStatus) {
            inventoryScanStatuses[target.CountedInventoryStatus]--;
            if (inventoryScanStatuses[target.CountedInventoryStatus] <= 0) {
                delete inventoryScanStatuses[target.CountedInventoryStatus];
            }
        }
        target.InventoryStatus = status;
        target.CountedInventoryStatus = status;
        inventoryScanStatuses[status] = (inventoryScanStatuses[status] || 0) + 1;
        updateResultSummary();
    }

    function getRequestFunc() {
        if (typeof GM_xmlhttpRequest !== "function") {
            return GM.xmlHttpRequest.bind(GM);
        }
        return GM_xmlhttpRequest;
    }

    function buildEmptyTradeStore(version) {
        return {
            version: version,
            updatedAt: 0,
            trades: {},
        };
    }

    function loadTradeStore(storageKey, version) {
        try {
            const parsed = JSON.parse(localStorage.getItem(storageKey));
            if (parsed && parsed.version === version && parsed.trades && typeof parsed.trades === "object") {
                return parsed;
            }
        } catch (error) {
            console.warn(`Failed to parse ${storageKey}`, error);
        }
        return buildEmptyTradeStore(version);
    }

    function saveTradeStore(storageKey, store) {
        store.updatedAt = Date.now();
        localStorage.setItem(storageKey, JSON.stringify(store));
    }

    function getPendingTradeStore() {
        pendingTradeStore = loadTradeStore(PENDING_TRADE_KEY, PENDING_TRADE_STORE_VERSION);
        return pendingTradeStore;
    }

    function getCompletedTradeStore() {
        completedTradeStore = loadTradeStore(COMPLETED_TRADE_KEY, COMPLETED_TRADE_STORE_VERSION);
        return completedTradeStore;
    }

    function savePendingTradeStore(store) {
        pendingTradeStore = store;
        saveTradeStore(PENDING_TRADE_KEY, store);
    }

    function saveCompletedTradeStore(store) {
        completedTradeStore = store;
        saveTradeStore(COMPLETED_TRADE_KEY, store);
    }

    function clearTradeTrackingStores() {
        localStorage.removeItem(PENDING_TRADE_KEY);
        localStorage.removeItem(COMPLETED_TRADE_KEY);
        pendingTradeStore = null;
        completedTradeStore = null;
        tradeTrackingClearedAt = Date.now();
    }

    function getTrackedTradeCounts() {
        return {
            pending: Object.keys(getPendingTradeStore().trades).length,
            completed: Object.keys(getCompletedTradeStore().trades).length,
        };
    }

    function createTradeMarker() {
        return `${STM_TRADE_MARKER_PREFIX}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    function buildTrackedTradeMessage(message, marker) {
        const trimmedMessage = String(message ?? "").trim();
        const markerText = `[${marker}]`;
        return trimmedMessage ? `${trimmedMessage}\n${markerText}` : markerText;
    }

    function updateTradeStatus(message, isError = false) {
        const statusElement = document.querySelector("[data-asf-stm-trade-status]");
        if (!statusElement) {
            return;
        }
        const counts = getTrackedTradeCounts();
        const parts = [`Pending: ${counts.pending}`, `Completed: ${counts.completed}`];
        if (message) {
            parts.push(message);
        }
        statusElement.textContent = parts.join(" | ");
        statusElement.style.color = isError ? "#ff7b72" : "#8F98A0";
    }

    function getCompletedTradeConsumption() {
        const completedTrades = Object.values(getCompletedTradeStore().trades);
        const consumption = new Map();
        completedTrades.forEach((trade) => {
            const completedAt = Number(trade.completedAt);
            if (!isNaN(completedAt) && ownInventorySnapshotTime > 0 && completedAt <= ownInventorySnapshotTime) {
                return;
            }
            (trade.sendCardNames || []).forEach((hash) => {
                consumption.set(hash, (consumption.get(hash) || 0) + 1);
            });
        });
        return consumption;
    }

    function getReconciledMyBadges() {
        const consumption = getCompletedTradeConsumption();
        const reconciledBadges = deepClone(myBadges);
        reconciledBadges.forEach((badge) => {
            badge.cards.forEach((card) => {
                const consumed = consumption.get(card.hash) || 0;
                if (consumed > 0) {
                    card.count = Math.max(0, card.count - consumed);
                    if (Number.isFinite(card.tradableCount)) {
                        card.tradableCount = Math.max(0, card.tradableCount - consumed);
                    }
                }
            });
        });
        const finalizedBadges = deepClone(reconciledBadges);
        finalizeBadgeCollection(finalizedBadges, true);
        const finalizedByAppId = new Map(finalizedBadges.map((badge) => [badge.appId, badge]));
        reconciledBadges.forEach((badge) => {
            const finalizedBadge = finalizedByAppId.get(badge.appId);
            badge.unmatchable = finalizedBadge === undefined;
            if (finalizedBadge) {
                badge.cards = finalizedBadge.cards;
                badge.maxSets = finalizedBadge.maxSets;
                badge.lastSet = finalizedBadge.lastSet;
            }
        });
        return reconciledBadges;
    }

    function getReconciledTargetBadges(target, badges) {
        const reconciled = deepClone(badges);
        if (!target.InventorySnapshotTime) {
            return reconciled;
        }
        const consumption = new Map();
        Object.values(getCompletedTradeStore().trades).forEach(trade => {
            if (String(trade.partner) !== target.TradePartner || Number(trade.completedAt) <= target.InventorySnapshotTime) {
                return;
            }
            (trade.receiveCardNames || []).forEach(hash => consumption.set(hash, (consumption.get(hash) || 0) + 1));
        });
        reconciled.forEach(badge => badge.cards.forEach(card => {
            const used = consumption.get(card.hash) || 0;
            card.count = Math.max(0, card.count - used);
            if (Number.isFinite(card.tradableCount)) {
                card.tradableCount = Math.max(0, card.tradableCount - used);
            }
        }));
        return reconciled;
    }

    function parseTradeOfferState(documentElement) {
        const stateFromDataset = documentElement?.querySelector?.("[data-offer-state]")?.dataset?.offerState;
        const html = String(documentElement?.documentElement?.innerHTML ?? "");
        const stateMatch = stateFromDataset || html.match(/g_tradeOfferState\s*=\s*(\d+)/)?.[1] || html.match(/data-offer-state="(\d+)"/)?.[1];
        const state = Number(stateMatch);
        switch (state) {
            case 2:
            case 9:
            case 11:
                return "pending";
            case 3:
                return "accepted";
            case 4:
                return "countered";
            case 5:
                return "expired";
            case 6:
            case 10:
                return "cancelled";
            case 7:
            case 8:
                return "declined";
            default:
                break;
        }
        return "unknown";
    }

    function getPartner(str) {
        if (typeof BigInt !== "undefined") {
            return (BigInt(str) % BigInt(4294967296)).toString(); // eslint-disable-line
        } else {
            let result = 0;
            for (let i = 0; i < str.length; i++) {
                result = (result * 10 + Number(str[i])) % 4294967296;
            }
            return result.toString();
        }
    }

    function arrayToText(array) {
        return array.join(",\n");
    }

    function textToArray(text) {
        let res = [];
        text.split(",").forEach(function (elem) {
            if (/^\d+$/.test(elem.trim())) {
                res.push(elem.trim());
            }
        });
        return res;
    }

    function hexToRgba(hex) {
        return "rgba(" + [Number("0x" + hex.substring(1, 3)), Number("0x" + hex.substring(3, 5)), Number("0x" + hex.substring(5, 7))].join(",") + ",1)";
    }

    function rgbaToHex(rgba) {
        let re = /rgba\(([.\d]+),([.\d]+),([.\d]+),([.\d]+)\)/g;
        let result = re.exec(rgba);
        if (result === null || result.length !== 5) {
            return ["#171a21", 0.8];
        }
        return ["#" + Number(result[1]).toString(16) + Number(result[2]).toString(16) + Number(result[3]).toString(16), Number(result[4])];
    }

    function mixAlpha(rgba, alpha) {
        let re = /(rgba\([.\d]+,[.\d]+,[.\d]+,)([.\d]+)\)/g;
        let result = re.exec(rgba);
        if (result) {
            return result[1] + alpha + ")";
        }
        return rgba;
    }

    function getEnabledSources() {
        return {
            scanBots: globalSettings.scanBots !== false,
            scanFriends: globalSettings.scanFriends !== false,
            scanGroups: globalSettings.scanGroups === true,
            groupSettings: JSON.stringify([globalSettings.groups, globalSettings.groupLimit, globalSettings.groupMemberLimit, globalSettings.groupPageLimit, globalSettings.tradeUrls]),
        };
    }

    function getTargetProfileLink(target) {
        return target.ProfilePath;
    }

    function getTargetTradeUrl(target, match) {
        let tradeUrl = `https://steamcommunity.com/tradeoffer/new/?partner=${target.TradePartner}`;
        if (target.TradeToken) {
            tradeUrl += `&token=${target.TradeToken}`;
        }
        tradeUrl += '&source=asfstm';
        if (match !== undefined) {
            tradeUrl += `&match=${match}`;
        }
        if (target.SourceTypes.includes("groups")) {
            tradeUrl += "&groupmatch=1";
        }
        return tradeUrl;
    }

    function getTargetSourceLabel(target) {
        const labels = {asf: "ASF", friends: "Friend", whitelist: "Whitelist", groups: "Group"};
        let label = target.SourceTypes.map(source => labels[source] || source).join(" + ");
        if (target.SourceTypes.includes("groups")) {
            label += ` (${(target.GroupNames || []).join(", ") || "Steam group"}; ${target.InventoryStatus || "not scanned"}; trade access ${target.TradeAccess || "unknown"})`;
        }
        return label;
    }

    function getTargetSourceBadge(target) {
        const label = escapeHtml(getTargetSourceLabel(target));
        return `<span class="avatar_block_status_${target.SourceTypes.includes('asf') ? 'in-game' : 'online'}" style="font-size: 8px; cursor:help" title="Scanned via ${label}">&nbsp;${label}&nbsp;</span>`;
    }

    function normalizeBot(bot) {
        const steamID64 = String(bot.SteamID);
        const tradePartner = getPartner(steamID64);
        return {
            ...bot,
            SteamID: tradePartner,
            SteamID64: steamID64,
            TradePartner: tradePartner,
            ProfilePath: `profiles/${steamID64}`,
            SourceTypes: ['asf'],
        };
    }

    function normalizeFriend(profilePath, avatarHash, nickname, tradePartner) {
        return {
            SteamID: String(tradePartner),
            SteamID64: null,
            TradePartner: String(tradePartner),
            ProfilePath: profilePath,
            AvatarHash: avatarHash,
            MatchableTypes: [2, 3, 4, 5],
            MatchEverything: false,
            MaxTradeHoldDuration: 0,
            Nickname: nickname,
            TotalGamesCount: 0,
            TotalInventoryCount: 0,
            TotalItemsCount: 0,
            TradeToken: null,
            SourceTypes: ['friends'],
        };
    }

    function normalizeWhitelistSteamID(steamID64) {
        const normalizedSteamID64 = String(steamID64);
        return {
            SteamID: getPartner(normalizedSteamID64),
            SteamID64: normalizedSteamID64,
            TradePartner: getPartner(normalizedSteamID64),
            ProfilePath: `profiles/${normalizedSteamID64}`,
            AvatarHash: null,
            MatchableTypes: [2, 3, 4, 5],
            MatchEverything: false,
            MaxTradeHoldDuration: 0,
            Nickname: `SteamID ${normalizedSteamID64}`,
            TotalGamesCount: 0,
            TotalInventoryCount: 0,
            TotalItemsCount: 0,
            TradeToken: null,
            SourceTypes: ['whitelist'],
        };
    }

    function mergeTargets(targetGroups) {
        const merged = new Map();
        targetGroups.flat().forEach((target) => {
            const key = String(target.TradePartner);
            if (blacklist.includes(key) || blacklist.includes(String(target.SteamID64)) || (ownSteamID64 && key === getPartner(ownSteamID64))) {
                return;
            }
            if (!merged.has(key)) {
                merged.set(key, target);
                return;
            }
            const current = merged.get(key);
            current.GroupNames = Array.from(new Set([...(current.GroupNames || []), ...(target.GroupNames || [])]));
            current.SourceTypes = Array.from(new Set(current.SourceTypes.concat(target.SourceTypes))).sort();
            if ((!current.ProfilePath || current.ProfilePath.startsWith('profiles/')) && target.ProfilePath && !target.ProfilePath.startsWith('profiles/')) {
                current.ProfilePath = target.ProfilePath;
            }
            current.AvatarHash = current.AvatarHash || target.AvatarHash;
            current.Nickname = current.Nickname || target.Nickname;
            current.MatchEverything = current.MatchEverything || target.MatchEverything;
            current.TotalGamesCount = Math.max(current.TotalGamesCount ?? 0, target.TotalGamesCount ?? 0);
            current.TotalInventoryCount = Math.max(current.TotalInventoryCount ?? 0, target.TotalInventoryCount ?? 0);
            current.TotalItemsCount = Math.max(current.TotalItemsCount ?? 0, target.TotalItemsCount ?? 0);
            current.MatchableTypes = Array.from(new Set([...(current.MatchableTypes ?? []), ...(target.MatchableTypes ?? [])]));
            if (!current.TradeToken && target.TradeToken) {
                current.TradeToken = target.TradeToken;
            }
        });
        return Array.from(merged.values());
    }

    function getTargetSourceKey(target) {
        if (target.SourceTypes.length > 1) {
            return "shared";
        }
        return target.SourceTypes[0] === "friends" ? "friends" : target.SourceTypes[0] === "whitelist" ? "whitelist" : target.SourceTypes[0] === "groups" ? "groups" : "asf";
    }

    function getSourceLabel(sourceKey) {
        switch (sourceKey) {
            case "asf":
                return "ASF only";
            case "friends":
                return "Friends only";
            case "whitelist":
                return "Whitelist only";
            case "groups":
                return "Groups only";
            case "shared":
                return "Shared";
            default:
                return "All";
        }
    }

    function getSourceOrder(sourceKey) {
        switch (sourceKey) {
            case "shared":
                return 0;
            case "asf":
                return 1;
            case "friends":
                return 2;
            case "whitelist":
                return 3;
            default:
                return 4;
        }
    }

    function updateResultSummary() {
        const summary = document.getElementById("asf_stm_results_summary");
        if (!summary) {
            return;
        }

        const targetCounts = { all: 0, asf: 0, friends: 0, whitelist: 0, groups: 0, shared: 0 };
        const matchCounts = { all: 0, asf: 0, friends: 0, whitelist: 0, groups: 0, shared: 0, visible: 0 };

        if (bots?.Result) {
            targetCounts.all = bots.Result.length;
            bots.Result.forEach((target) => {
                targetCounts[getTargetSourceKey(target)] += 1;
            });
        }

        document.querySelectorAll(".asf-stm-result-row").forEach((row) => {
            const sourceKey = row.dataset.sourceKey;
            matchCounts.all += 1;
            matchCounts[sourceKey] += 1;
            if (row.style.display !== "none") {
                matchCounts.visible += 1;
            }
        });

        summary.innerHTML = [
            `Targets: <b>${targetCounts.all}</b>`,
            `ASF: <b>${targetCounts.asf}</b>`,
            `Friends: <b>${targetCounts.friends}</b>`,
            `Whitelist: <b>${targetCounts.whitelist}</b>`,
            `Groups: <b>${targetCounts.groups}</b>`,
            `Shared: <b>${targetCounts.shared}</b>`,
            `Matches: <b>${matchCounts.all}</b>`,
            `Visible: <b>${matchCounts.visible}</b>`,
        ].join("&ensp;|&ensp;");
        const detail = document.createElement("div");
        detail.style.color = "#e5c07b";
        detail.textContent = ["Potential matches from badge counts; tradability is checked when preparing offers."].concat(
            groupDiscoveryReports.map(report => `${report.name}: ${report.members} members, ${report.pages} pages (${report.status})`),
            Object.entries(inventoryScanStatuses).map(([status, count]) => `${status}: ${count}`)
        ).join(" | ");
        summary.appendChild(detail);
    }

    function syncResultControlStates() {
        document.querySelectorAll("[data-result-filter]").forEach((element) => {
            const active = element.dataset.resultFilter === resultView.sourceFilter;
            element.style.opacity = active ? "1" : "0.6";
            element.style.borderColor = active ? "#67c1f5" : "#4a83fd55";
        });
        document.querySelectorAll("[data-result-grouping]").forEach((element) => {
            const active = element.dataset.resultGrouping === resultView.grouping;
            element.style.opacity = active ? "1" : "0.6";
            element.style.borderColor = active ? "#67c1f5" : "#4a83fd55";
        });
    }

    function applyResultView() {
        document.querySelectorAll(".asf-stm-result-row").forEach((row) => {
            const isVisibleSource = resultView.sourceFilter === "all" || row.dataset.sourceKey === resultView.sourceFilter || (resultView.sourceFilter === "groups" && row.dataset.sources.split(",").includes("groups"));
            row.dataset.sourceHidden = isVisibleSource ? "false" : "true";
            row.style.order = resultView.grouping === "source" ? String(getSourceOrder(row.dataset.sourceKey) * 1000000 + Number(row.dataset.resultIndex)) : row.dataset.resultIndex;
            checkRow(row);
        });
        syncResultControlStates();
        updateResultSummary();
    }

    function resultControlEventHandler(event) {
        const control = event.target.closest("[data-result-filter],[data-result-grouping],[data-trade-action]");
        if (!control) {
            return;
        }
        event.preventDefault();
        if (control.dataset.tradeAction) {
            if (control.dataset.tradeAction === "refresh-completed") {
                refreshCompletedTrades();
            } else if (control.dataset.tradeAction === "clear-tracked") {
                clearTrackedTradesEventHandler();
            }
            return;
        }
        if (control.dataset.resultFilter) {
            resultView.sourceFilter = control.dataset.resultFilter;
        }
        if (control.dataset.resultGrouping) {
            resultView.grouping = control.dataset.resultGrouping;
        }
        applyResultView();
    }

    function refreshCompletedTrades(options = {}) {
        if (tradeRefreshInFlight) {
            updateTradeStatus("Refresh already running");
            return Promise.resolve();
        }
        const refreshStartedAt = Date.now();
        const pendingTrades = Object.values(deepClone(getPendingTradeStore()).trades);
        if (pendingTrades.length === 0) {
            updateTradeStatus("No pending STM trades");
            if (options.render !== false) {
                renderStoredMatches();
            }
            return Promise.resolve();
        }

        tradeRefreshInFlight = true;
        updateTradeStatus(`Refreshing ${pendingTrades.length} trade(s)…`);
        const requestFunc = getRequestFunc();
        const terminalStates = new Set(["accepted", "declined", "cancelled", "expired", "countered"]);
        const removedPendingOfferIds = new Set();
        const acceptedTrades = {};
        let completedNow = 0;

        let refreshChain = Promise.resolve();
        pendingTrades.forEach((trade) => {
            refreshChain = refreshChain.then(() => new Promise((resolve) => {
                requestFunc({
                    method: "GET",
                    url: `https://steamcommunity.com/tradeoffer/${encodeURIComponent(trade.offerId)}/`,
                    headers: {
                        "User-Agent": "ASF-STM/" + GM_info.version,
                    },
                    timeout: 30000,
                    onload: function (response) {
                        if (response.status !== 200) {
                            resolve();
                            return;
                        }
                        try {
                            const parser = new DOMParser();
                            const tradeDocument = parser.parseFromString(response.responseText ?? response.response, "text/html");
                            const tradeState = parseTradeOfferState(tradeDocument);
                            if (tradeState === "accepted") {
                                acceptedTrades[String(trade.offerId)] = {
                                    ...trade,
                                    state: tradeState,
                                    completedAt: Date.now(),
                                };
                                removedPendingOfferIds.add(String(trade.offerId));
                                completedNow++;
                            } else if (terminalStates.has(tradeState)) {
                                removedPendingOfferIds.add(String(trade.offerId));
                            }
                        } catch (error) {
                            console.warn("Failed to parse trade offer page", error);
                        }
                        resolve();
                    },
                    onerror: function () {
                        resolve();
                    },
                    ontimeout: function () {
                        resolve();
                    }
                });
            }));
        });

        return refreshChain
            .then(() => {
                if (tradeTrackingClearedAt > refreshStartedAt) {
                    updateTradeStatus("Refresh cancelled");
                    return;
                }
                const pendingStore = deepClone(getPendingTradeStore());
                const completedStore = deepClone(getCompletedTradeStore());
                removedPendingOfferIds.forEach((offerId) => {
                    delete pendingStore.trades[offerId];
                });
                Object.keys(acceptedTrades).forEach((offerId) => {
                    completedStore.trades[offerId] = acceptedTrades[offerId];
                });
                savePendingTradeStore(pendingStore);
                saveCompletedTradeStore(completedStore);
                if (options.render !== false) {
                    renderStoredMatches();
                } else {
                    updateTradeStatus(completedNow > 0 ? `Completed +${completedNow}` : "No completed trades found");
                }
            })
            .catch((error) => {
                console.warn("Failed to refresh completed trades", error);
                updateTradeStatus("Refresh failed", true);
            })
            .finally(() => {
                tradeRefreshInFlight = false;
            });
    }

    function clearTrackedTradesEventHandler() {
        unsafeWindow.ShowConfirmDialog("CONFIRMATION", "Are you sure you want to clear tracked STM trades?").done(function () {
            clearTradeTrackingStores();
            renderStoredMatches();
            updateTradeStatus("Tracked STM trades cleared");
        });
    }

    function isCacheValid(cache, enabledSources) {
        return !(cache === null ||
            cache.cacheTime === undefined ||
            cache.cacheTime === null ||
            cache.profileLink !== myProfileLink ||
            cache.cacheTime + botCacheTime < Date.now() ||
            cache.sourceState === undefined ||
            cache.sourceState.scanBots !== enabledSources.scanBots ||
            cache.sourceState.scanFriends !== enabledSources.scanFriends ||
            cache.sourceState.scanGroups !== enabledSources.scanGroups ||
            cache.sourceState.groupSettings !== enabledSources.groupSettings ||
            cache.sourceState.whitelist !== whitelist.join(","));
    }

    function isInventoryCacheEnabled() {
        return globalSettings.enableInventoryCache !== false;
    }

    function getInventoryCacheTtlMs() {
        const ttlMinutes = Number(globalSettings.inventoryCacheTtlMinutes);
        if (isNaN(ttlMinutes) || ttlMinutes <= 0) {
            return 5 * 60000;
        }
        return ttlMinutes * 60000;
    }

    function getInventoryCacheMaxEntries() {
        const maxEntries = Number(globalSettings.inventoryCacheMaxEntries);
        if (isNaN(maxEntries) || maxEntries <= 0) {
            return INVENTORY_CACHE_DEFAULT_MAX_ENTRIES;
        }
        return Math.floor(maxEntries);
    }

    function getScanConcurrency() {
        const concurrency = Number(globalSettings.scanConcurrency);
        if (isNaN(concurrency) || concurrency < 1) {
            return 1;
        }
        return Math.floor(concurrency);
    }

    // Adaptive request delay: starts at the configured web limiter and eases down toward a
    // floor after consecutive successes, resetting back up on any error. This lets healthy
    // scans speed up over time while keeping the configured weblimiter as a safety ceiling.
    function getAdaptiveDelayFloor() {
        return Math.min(globalSettings.weblimiter, Math.max(50, Math.round(globalSettings.weblimiter / 3)));
    }

    function resetAdaptiveRequestDelay() {
        adaptiveRequestDelay = globalSettings.weblimiter;
        lastAdaptiveDecayAt = 0;
    }

    function getAdaptiveRequestDelay() {
        if (adaptiveRequestDelay === null) {
            resetAdaptiveRequestDelay();
        }
        return adaptiveRequestDelay;
    }

    function recordRequestSuccess() {
        // With concurrency > 1 several requests can succeed within the same scheduling
        // round; only ease the delay down once per elapsed round (gated by wall-clock time)
        // so the decay doesn't compound N times per round.
        const now = Date.now();
        if (now - lastAdaptiveDecayAt < getAdaptiveRequestDelay()) {
            return;
        }
        lastAdaptiveDecayAt = now;
        const floor = getAdaptiveDelayFloor();
        adaptiveRequestDelay = Math.max(floor, Math.round(getAdaptiveRequestDelay() * 0.8));
    }

    function recordRequestError() {
        adaptiveRequestDelay = globalSettings.weblimiter;
        lastAdaptiveDecayAt = 0;
    }

    // Runs a bounded number of `worker(index, cancelToken)` calls concurrently over indices
    // [0, total), pacing new dispatches with the adaptive request delay. `worker` must resolve
    // when the item is fully handled (including its own retries) or reject to abort the whole
    // pool. `cancelToken.cancelled` is set as soon as the pool settles (success or failure) so
    // any still-in-flight worker can detect it and avoid mutating shared state afterwards.
    function runIndexedWorkerPool(total, concurrency, worker) {
        const generation = scanGeneration;
        return new Promise((resolve, reject) => {
            const cancelToken = {cancelled: false};
            if (total <= 0) {
                resolve();
                return;
            }
            let nextIndex = 0;
            let active = 0;
            let settled = false;
            function settleOnce(fn, arg) {
                if (settled) {
                    return;
                }
                settled = true;
                cancelToken.cancelled = true;
                fn(arg);
            }
            function launchNext() {
                if (settled) {
                    return;
                }
                if (stop || generation !== scanGeneration) {
                    settleOnce(reject, {type: 'stopped'});
                    return;
                }
                if (active >= concurrency) {
                    return;
                }
                if (nextIndex >= total) {
                    if (active === 0) {
                        settleOnce(resolve);
                    }
                    return;
                }
                const currentIndex = nextIndex++;
                active++;
                worker(currentIndex, cancelToken)
                    .then(() => {
                        active--;
                        if (settled) {
                            return;
                        }
                        setTimeout(launchNext, getAdaptiveRequestDelay());
                    })
                    .catch((error) => {
                        active--;
                        settleOnce(reject, error);
                    });
            }
            const initialWorkers = Math.min(Math.max(concurrency, 1), total);
            for (let i = 0; i < initialWorkers; i++) {
                setTimeout(launchNext, i * getAdaptiveRequestDelay());
            }
        });
    }

    function resetCacheStats() {
        cacheStats = {
            freshHits: 0,
            staleHits: 0,
            misses: 0,
            writes: 0,
            refreshWrites: 0,
            evictions: 0,
            refreshFailures: 0,
            saveFailures: 0,
            mode: cacheBypassActive ? "force-fresh" : isInventoryCacheEnabled() ? "enabled" : "disabled",
        };
        updateCacheStatus();
    }

    function updateCacheStatus() {
        const statuses = document.querySelectorAll("[data-asf-stm-cache-status]");
        if (statuses.length === 0) {
            return;
        }
        let text;
        if (cacheStats.mode === "disabled") {
            text = "Inventory cache: disabled";
        } else if (cacheStats.mode === "force-fresh") {
            text = `Inventory cache: bypassed this run (writes: ${cacheStats.writes}, refreshes: ${cacheStats.refreshWrites})`;
        } else {
            text = `Inventory cache: fresh ${cacheStats.freshHits} | stale ${cacheStats.staleHits} | misses ${cacheStats.misses} | writes ${cacheStats.writes} | refreshes ${cacheStats.refreshWrites} | evictions ${cacheStats.evictions}`;
            if (cacheStats.refreshFailures > 0 || cacheStats.saveFailures > 0) {
                text += ` | failures ${cacheStats.refreshFailures + cacheStats.saveFailures}`;
            }
        }
        statuses.forEach((status) => {
            status.textContent = text;
        });
    }

    function getInventoryScopeAppIds(badges = myBadges) {
        return badges.map((badge) => Number(badge.appId)).filter(appId => !isNaN(appId)).sort((a, b) => a - b);
    }

    function getInventoryScopeKey(badges = myBadges) {
        return getInventoryScopeAppIds(badges).join(",");
    }

    function buildInventoryCacheKey(entryType, profileId, sourceType, scopeKey) {
        return `${entryType}|${profileId}|${sourceType}|${scopeKey}`;
    }

    function buildInventoryCacheMeta(entryType, profileId, sourceType, badges = myBadges) {
        const appIds = getInventoryScopeAppIds(badges);
        return {
            entryType: entryType,
            profileId: profileId,
            sourceType: sourceType,
            scopeKey: getInventoryScopeKey(badges),
            appIds: appIds,
        };
    }

    function getTargetInventorySourceType(target) {
        return Array.from(new Set(target.SourceTypes ?? [])).sort().join("+") || "unknown";
    }

    function loadInventoryCacheStore() {
        if (inventoryCacheStore !== null) {
            return inventoryCacheStore;
        }
        try {
            const parsed = JSON.parse(localStorage.getItem(INVENTORY_CACHE_KEY));
            if (!parsed || parsed.version !== CACHE_SCHEMA_VERSION || typeof parsed.entries !== "object" || parsed.entries === null) {
                inventoryCacheStore = { version: CACHE_SCHEMA_VERSION, entries: {} };
                return inventoryCacheStore;
            }
            inventoryCacheStore = parsed;
            return parsed;
        } catch (error) {
            inventoryCacheStore = { version: CACHE_SCHEMA_VERSION, entries: {} };
            return inventoryCacheStore;
        }
    }

    function saveInventoryCacheStore(store) {
        try {
            localStorage.setItem(INVENTORY_CACHE_KEY, JSON.stringify(store));
            inventoryCacheStore = store;
            return true;
        } catch (error) {
            const entries = Object.entries(store.entries);
            if (entries.length > 1) {
                entries.sort((a, b) => (a[1].lastUsedTime ?? a[1].cacheTime ?? 0) - (b[1].lastUsedTime ?? b[1].cacheTime ?? 0));
                const toRemove = Math.max(1, Math.ceil(entries.length * 0.1));
                for (let i = 0; i < toRemove; i++) {
                    delete store.entries[entries[i][0]];
                    cacheStats.evictions++;
                }
                try {
                    localStorage.setItem(INVENTORY_CACHE_KEY, JSON.stringify(store));
                    inventoryCacheStore = store;
                    return true;
                } catch (retryError) {
                    console.warn("Failed to save inventory cache", retryError);
                }
            } else {
                console.warn("Failed to save inventory cache", error);
            }
            cacheStats.saveFailures++;
            return false;
        }
    }

    function clearInventoryCacheStore() {
        localStorage.removeItem(INVENTORY_CACHE_KEY);
        inventoryCacheStore = null;
        inventoryCacheGeneration++;
        inventoryRefreshQueue.length = 0;
    }

    function clearInventoryCacheEventHandler() {
        clearInventoryCacheStore();
        resetCacheStats();
    }

    function isValidCardSnapshot(card) {
        return !(card === null ||
            typeof card !== "object" ||
            typeof card.hash !== "string" ||
            typeof card.item !== "string" ||
            typeof card.iconUrl !== "string" ||
            typeof card.number !== "number" ||
            typeof card.count !== "number" ||
            isNaN(card.count) ||
            isNaN(card.number));
    }

    function isValidBadgeSnapshot(badge) {
        if (badge === null || typeof badge !== "object") {
            return false;
        }
        if (typeof badge.appId !== "number" || isNaN(badge.appId) || typeof badge.title !== "string" || typeof badge.maxCards !== "number" || isNaN(badge.maxCards) || !Array.isArray(badge.cards) || badge.cards.length !== badge.maxCards) {
            return false;
        }
        return badge.cards.every(isValidCardSnapshot);
    }

    function isInventoryCacheEntryShapeValid(entry, expected) {
        if (entry === null || typeof entry !== "object") {
            return false;
        }
        if (entry.version !== CACHE_SCHEMA_VERSION || typeof entry.cacheTime !== "number") {
            return false;
        }
        if (entry.entryType !== expected.entryType || entry.profileId !== expected.profileId || entry.sourceType !== expected.sourceType || entry.scopeKey !== expected.scopeKey) {
            return false;
        }
        if (!Array.isArray(entry.appIds) || entry.appIds.join(",") !== expected.appIds.join(",")) {
            return false;
        }
        if (!Array.isArray(entry.badges) || entry.badges.length !== expected.appIds.length) {
            return false;
        }
        return entry.provenance === "badge-counts" && Number.isFinite(entry.snapshotTime) && entry.badges.every(isValidBadgeSnapshot);
    }

    function isInventoryCacheEntryFresh(entry) {
        return entry.cacheTime + getInventoryCacheTtlMs() >= Date.now();
    }

    function getInventoryCacheEntry(cacheKey, expectedMeta) {
        if (!isInventoryCacheEnabled() || cacheBypassActive) {
            updateCacheStatus();
            return null;
        }
        const store = loadInventoryCacheStore();
        const entry = store.entries[cacheKey] ?? null;
        if (entry && isInventoryCacheEntryShapeValid(entry, expectedMeta)) {
            const stale = !isInventoryCacheEntryFresh(entry);
            entry.lastUsedTime = Date.now();
            if (stale) {
                cacheStats.staleHits++;
            } else {
                cacheStats.freshHits++;
            }
            updateCacheStatus();
            return {
                badges: deepClone(entry.badges),
                cacheTime: entry.cacheTime,
                snapshotTime: entry.snapshotTime,
                stale: stale,
            };
        }
        if (entry) {
            delete store.entries[cacheKey];
            saveInventoryCacheStore(store);
        }
        cacheStats.misses++;
        updateCacheStatus();
        return null;
    }

    function evictInventoryCacheEntries(store) {
        const entries = Object.entries(store.entries);
        const maxEntries = getInventoryCacheMaxEntries();
        if (entries.length <= maxEntries) {
            return;
        }
        entries.sort((a, b) => (a[1].lastUsedTime ?? a[1].cacheTime ?? 0) - (b[1].lastUsedTime ?? b[1].cacheTime ?? 0));
        const toRemove = entries.length - maxEntries;
        for (let i = 0; i < toRemove; i++) {
            delete store.entries[entries[i][0]];
            cacheStats.evictions++;
        }
    }

    function setInventoryCacheEntry(cacheKey, payload, isRefresh = false) {
        if (!isInventoryCacheEnabled() || cacheBypassActive) {
            updateCacheStatus();
            return;
        }
        const now = Date.now();
        const store = loadInventoryCacheStore();
        store.entries[cacheKey] = {
            version: CACHE_SCHEMA_VERSION,
            provenance: "badge-counts",
            snapshotTime: payload.snapshotTime || now,
            cacheTime: now,
            lastUsedTime: now,
            entryType: payload.entryType,
            sourceType: payload.sourceType,
            profileId: payload.profileId,
            scopeKey: payload.scopeKey,
            appIds: payload.appIds,
            badges: deepClone(payload.badges),
        };
        evictInventoryCacheEntries(store);
        if (saveInventoryCacheStore(store)) {
            if (isRefresh) {
                cacheStats.refreshWrites++;
            } else {
                cacheStats.writes++;
            }
        }
        updateCacheStatus();
    }

    function enqueueInventoryCacheRefresh(cacheKey, refreshFunction) {
        if (!isInventoryCacheEnabled() || cacheBypassActive || inventoryRefreshQueue.some(task => task.cacheKey === cacheKey)) {
            return;
        }
        inventoryRefreshQueue.push({cacheKey: cacheKey, refreshFunction: refreshFunction});
        runInventoryCacheRefreshQueue();
    }

    function runInventoryCacheRefreshQueue() {
        if (inventoryRefreshRunning || inventoryRefreshQueue.length === 0 || !isInventoryCacheEnabled() || cacheBypassActive) {
            return;
        }
        if (stop) {
            inventoryRefreshQueue.length = 0;
            return;
        }
        const task = inventoryRefreshQueue.shift();
        inventoryRefreshRunning = true;
        setTimeout(function () {
            task.refreshFunction(function () {
                inventoryRefreshRunning = false;
                runInventoryCacheRefreshQueue();
            });
        }, globalSettings.weblimiter);
    }

    function failInventoryCacheRefresh(done) {
        cacheStats.refreshFailures++;
        updateCacheStatus();
        done();
    }

    function isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration) {
        return !stop && cacheGeneration === inventoryCacheGeneration && refreshScanGeneration === scanGeneration;
    }

    function refreshOwnInventoryCacheEntry(cacheKey, cacheMeta, badgeTemplates) {
        const cacheGeneration = inventoryCacheGeneration;
        const refreshScanGeneration = scanGeneration;
        enqueueInventoryCacheRefresh(cacheKey, function (done) {
            const snapshotTime = Date.now();
            const refreshedBadges = deepClone(badgeTemplates);
            let refreshErrors = 0;
            function refreshBadge(index) {
                if (!isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration)) {
                    done();
                    return;
                }
                if (index >= refreshedBadges.length) {
                    if (!isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration)) {
                        done();
                        return;
                    }
                    setInventoryCacheEntry(cacheKey, {
                        entryType: cacheMeta.entryType,
                        sourceType: cacheMeta.sourceType,
                        profileId: cacheMeta.profileId,
                        scopeKey: cacheMeta.scopeKey,
                        appIds: cacheMeta.appIds,
                        badges: refreshedBadges,
                        snapshotTime,
                    }, true);
                    done();
                    return;
                }
                refreshedBadges[index].cards.length = 0;
                let xhr = new XMLHttpRequest();
                xhr.open("GET", `https://steamcommunity.com/${myProfileLink}/ajaxgetbadgeinfo/${refreshedBadges[index].appId}`, true);
                xhr.responseType = "json";
                xhr.timeout = 30000;
                xhr.onload = function () {
                    if (!isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration)) {
                        done();
                        return;
                    }
                    const status = xhr.status;
                    try {
                        if (status === 200 && xhr.response !== undefined && xhr.response.eresult == 1 && xhr.response.badgedata.rgCards.length >= 5) {
                            refreshErrors = 0;
                            refreshedBadges[index].maxCards = xhr.response.badgedata.rgCards.length;
                            for (let i = 0; i < refreshedBadges[index].maxCards; i++) {
                                refreshedBadges[index].cards.push({
                                    item: xhr.response.badgedata.rgCards[i].title,
                                    hash: xhr.response.badgedata.rgCards[i].markethash,
                                    count: xhr.response.badgedata.rgCards[i].owned,
                                    iconUrl: xhr.response.badgedata.rgCards[i].imgurl,
                                    number: i,
                                });
                            }
                            setTimeout(function () {
                                refreshBadge(index + 1);
                            }, globalSettings.weblimiter);
                            return;
                        }
                    } catch (error) {
                        // Retry below.
                    }
                    refreshErrors++;
                    if ((status < 400 || status === 408 || status === 429 || status >= 500) && refreshErrors <= boundedRetryLimit(globalSettings.maxErrors)) {
                        setTimeout(function () {
                            refreshBadge(index);
                        }, globalSettings.weblimiter + globalSettings.errorLimiter * refreshErrors);
                    } else {
                        failInventoryCacheRefresh(done);
                    }
                };
                xhr.onerror = function () {
                    if (!isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration)) {
                        done();
                        return;
                    }
                    refreshErrors++;
                    if (refreshErrors <= boundedRetryLimit(globalSettings.maxErrors)) {
                        setTimeout(function () {
                            refreshBadge(index);
                        }, globalSettings.weblimiter + globalSettings.errorLimiter * refreshErrors);
                    } else {
                        failInventoryCacheRefresh(done);
                    }
                };
                xhr.ontimeout = xhr.onerror;
                sendPacedSteamRequest(xhr, refreshScanGeneration, done, () => isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration));
            }
            refreshBadge(0);
        });
    }

    function refreshTargetInventoryCacheEntry(cacheKey, cacheMeta, target, badgeTemplates) {
        const cacheGeneration = inventoryCacheGeneration;
        const refreshScanGeneration = scanGeneration;
        const cardHashes = myBadges.map((badge) => Object.fromEntries(badge.cards.map((card) => [card.number, card.hash])));
        enqueueInventoryCacheRefresh(cacheKey, function (done) {
            const refreshedBadges = deepClone(badgeTemplates);
            let refreshErrors = 0;
            function refreshBadge(index, idLink) {
                if (!isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration)) {
                    done();
                    return;
                }
                if (index >= refreshedBadges.length) {
                    if (!isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration)) {
                        done();
                        return;
                    }
                    setInventoryCacheEntry(cacheKey, {
                        entryType: cacheMeta.entryType,
                        sourceType: cacheMeta.sourceType,
                        profileId: cacheMeta.profileId,
                        scopeKey: cacheMeta.scopeKey,
                        appIds: cacheMeta.appIds,
                        badges: refreshedBadges,
                    }, true);
                    done();
                    return;
                }
                refreshedBadges[index].cards.length = 0;
                let xhr = new XMLHttpRequest();
                xhr.open("GET", `https://steamcommunity.com/${idLink ?? getTargetProfileLink(target)}/gamecards/${refreshedBadges[index].appId}`, true);
                xhr.responseType = "document";
                xhr.timeout = 30000;
                xhr.onload = function () {
                    if (!isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration)) {
                        done();
                        return;
                    }
                    const status = xhr.status;
                    if (status === 200) {
                        const badgeCards = xhr.response.documentElement.querySelectorAll(".badge_card_set_card");
                        if (badgeCards.length >= 5) {
                            refreshErrors = 0;
                            refreshedBadges[index].maxCards = badgeCards.length;
                            for (let i = 0; i < badgeCards.length; i++) {
                                const quantityElement = badgeCards[i].querySelector(".badge_card_set_text_qty");
                                let quantity = quantityElement === null ? "(0)" : quantityElement.innerText.trim();
                                quantity = quantity.slice(1, -1);
                                let name = "";
                                badgeCards[i].querySelector(".badge_card_set_title").childNodes.forEach(function (element) {
                                    if (element.nodeType === Node.TEXT_NODE) {
                                        name = name + element.textContent;
                                    }
                                });
                                const cardHash = cardHashes[index]?.[i];
                                if (cardHash === undefined) {
                                    failInventoryCacheRefresh(done);
                                    return;
                                }
                                refreshedBadges[index].cards.push({
                                    item: name.trim(),
                                    hash: cardHash,
                                    count: Number(quantity),
                                    iconUrl: badgeCards[i].querySelector(".gamecard").src.trim(),
                                    number: i,
                                });
                            }
                            const nextIdLink = idLink ?? xhr.responseURL.match(/(id\/.+?)\//)?.[1];
                            setTimeout(function () {
                                refreshBadge(index + 1, nextIdLink);
                            }, globalSettings.weblimiter);
                            return;
                        }
                    }
                    refreshErrors++;
                    if ((status < 400 || status === 408 || status === 429 || status >= 500) && refreshErrors <= boundedRetryLimit(globalSettings.maxErrors)) {
                        setTimeout(function () {
                            refreshBadge(index, idLink);
                        }, globalSettings.weblimiter + globalSettings.errorLimiter * refreshErrors);
                    } else {
                        failInventoryCacheRefresh(done);
                    }
                };
                xhr.onerror = function () {
                    if (!isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration)) {
                        done();
                        return;
                    }
                    refreshErrors++;
                    if (refreshErrors <= boundedRetryLimit(globalSettings.maxErrors)) {
                        setTimeout(function () {
                            refreshBadge(index, idLink);
                        }, globalSettings.weblimiter + globalSettings.errorLimiter * refreshErrors);
                    } else {
                        failInventoryCacheRefresh(done);
                    }
                };
                xhr.ontimeout = xhr.onerror;
                sendPacedSteamRequest(xhr, refreshScanGeneration, done, () => isInventoryRefreshCurrent(cacheGeneration, refreshScanGeneration));
            }
            refreshBadge(0);
        });
    }

    function rememberCardNames(badges) {
        badges.forEach((badge) => {
            badge.cards.forEach((card) => {
                cardNames.add(card.hash);
            });
        });
    }

    function finalizeBadgeCollection(badges, removeUnmatchable) {
        for (let i = badges.length - 1; i >= 0; i--) {
            if (badges[i].cards.length === 0) {
                badges.splice(i, 1);
                continue;
            }
            badges[i].cards.sort((a, b) => b.count - a.count);
            if (removeUnmatchable && badges[i].cards[0].count - badges[i].cards[badges[i].cards.length - 1].count < 2) {
                badges.splice(i, 1);
                continue;
            }
            let totalCards = 0;
            for (let j = 0; j < badges[i].cards.length; j++) {
                totalCards += badges[i].cards[j].count;
            }
            badges[i].maxSets = Math.floor(totalCards / badges[i].maxCards);
            badges[i].lastSet = Math.ceil(totalCards / badges[i].maxCards);
        }
    }

    function finalizeOwnInventoryAfterLoad() {
        finalizeBadgeCollection(myBadges, true);
        if (globalSettings.autoDeleteScanFilters) {
            const inactiveScanFilters = globalSettings.scanFilters.filter(x => !x.active);
            const activeValidScanFilters = globalSettings.scanFilters.filter(aFilter => aFilter.active && myBadges.find(aBadge => aFilter.appId == aBadge.appId));
            globalSettings.scanFilters = inactiveScanFilters.concat(activeValidScanFilters);
        }
        if (globalSettings.autoAddScanFilters) {
            const addToScanFilters = myBadges.filter(aBadge => !globalSettings.scanFilters.find(aFilter => aFilter.appId == aBadge.appId));
            const newScanFilters = Array.from(addToScanFilters, aBadge => ({appId: aBadge.appId, title: aBadge.title, active: true}));
            globalSettings.scanFilters = globalSettings.scanFilters.concat(newScanFilters);
        }
        if (globalSettings.autoDeleteScanFilters || globalSettings.autoAddScanFilters) {
            SaveConfig();
        }
        if (myBadges.length === 0) {
            stopEventCleanup('No badges to match');
            return;
        }
        SaveParams();
        progressRadials.bots.steps = bots.Result.length;
        GetCards(0, 0);
    }

    function finalizeTargetInventoryAfterLoad(userindex) {
        const generation = scanGeneration;
        finalizeBadgeCollection(botBadges, false);
        bots.Result[userindex].badgesSnapshot = deepClone(botBadges);
        compareCards(userindex, function () {
            setTimeout(
                (function (userindex) {
                    return function () {
                        if (!stop && generation === scanGeneration) {
                            GetCards(0, userindex);
                        }
                    };
                })(userindex + 1),
                getAdaptiveRequestDelay(),
            );
        });
    }

    function markProgressComplete(radial) {
        progressRadials[radial].currentStep = progressRadials[radial].steps;
        progressRadials[radial].radialElement.classList.add('full-blue');
        progressRadials[radial].textElement.textContent = '✓';
    }

    function createScanFilterElement(active, appId, gameName) {
        const safeAppId = sanitizeAppId(appId);
        const safeProfileLink = sanitizeSteamProfilePath(myProfileLink);
        const safeGameName = escapeHtml(gameName);
        return `
            <div id="scan-filter-${safeAppId}" class="friendBlock" style="cursor: auto;">
                <div class="playerAvatar ${active ? 'ingame' : 'offline'}">
                    <a target="_blank" rel="noopener noreferrer" href="https://steamcommunity.com/${safeProfileLink}/gamecards/${safeAppId}/">
                        <img class="stretch" src="https://steamcdn-a.akamaihd.net/steam/apps/${safeAppId}/capsule_184x69.jpg">
                    </a>
                </div>
                <div id="scan-filter-name-${safeAppId}" class="friendBlockContent">${safeGameName}<br>
                    <input type="checkbox" data-app-id="${safeAppId}" ${active ? 'checked' : ''}>
                </div>
            </div>
        `.replaceAll(/(  |\n)/g, '');
    }

    function createGroupSettingsPanel(configDialog) {
        const tab = document.createElement("li");
        tab.className = "asf_stm_tab";
        tab.innerHTML = `<input type="radio" id="asf_stm_tab_groups" name="asf_stm_tabs"><label for="asf_stm_tab_groups">Groups</label>
            <div id="asf_stm_tab-content-groups" class="asf_stm_content">
            <fieldset><legend>SCAN LIMITS</legend>
            <div class="asf-stm-group-defaults">
            <label for="groupLimit">Groups per scan</label><input id="groupLimit" class="asf-stm-input" type="number" min="1" max="100">
            <label for="groupMemberLimit">Default members/group</label><input id="groupMemberLimit" class="asf-stm-input" type="number" min="1" max="10000">
            <label for="groupPageLimit">Default pages/group</label><input id="groupPageLimit" class="asf-stm-input" type="number" min="1" max="1000">
            </div>
            <p>Limits may produce partial scans. Groups do not grant trade permission. Unknown access requires manual review; group offers never auto-send.</p>
            </fieldset>
            <fieldset><legend>SAVED GROUPS</legend>
            <div class="asf-stm-group-add">
            <input id="addGroupUrl" class="asf-stm-input" type="url" aria-label="Steam group URL" placeholder="https://steamcommunity.com/groups/name">
            <button id="addGroupButton" type="button" class="btn_blue_steamui btn_small"><span>Add group</span></button>
            </div>
            <div id="groupSettingsStatus" role="status"></div>
            <div id="savedGroups"></div>
            </fieldset>
            <fieldset><legend>TRADE URLS</legend>
            <p>Optional Steam trade URLs (one per line, including partner and token). Tokens are stored locally. Only the matching partner receives a token.</p>
            <textarea id="groupTradeUrls" class="asf-stm-textarea" aria-label="Steam trade URLs" rows="4" autocomplete="off"></textarea>
            </fieldset>
            </div>`;
        configDialog.querySelector(".asf_stm_tabs").appendChild(tab);
        for (const key of ["groupLimit", "groupMemberLimit", "groupPageLimit"]) {
            tab.querySelector(`#${key}`).value = globalSettings[key];
        }
        tab.querySelector("#groupTradeUrls").value = globalSettings.tradeUrls.join("\n");
        function addRow(group) {
            const row = document.createElement("div");
            row.className = "asf-stm-group-row";
            row.dataset.groupUrl = group.url;
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "asf-stm-checkbox";
            checkbox.setAttribute("aria-label", `Scan ${group.url}`);
            checkbox.checked = group.enabled !== false;
            checkbox.dataset.groupEnabled = "true";
            row.appendChild(checkbox);
            const label = document.createElement("a");
            label.className = "asf-stm-group-name";
            label.href = normalizeGroupUrl(group.url);
            label.textContent = new URL(label.href).pathname.replace(/^\/|\/$/g, "");
            label.title = group.url;
            label.target = "_blank";
            label.rel = "noopener noreferrer";
            row.appendChild(label);
            for (const [key, title, max] of [["memberLimit", "Members", 10000], ["pageLimit", "Pages", 1000]]) {
                const field = document.createElement("label");
                field.textContent = title;
                const input = document.createElement("input");
                input.type = "number";
                input.min = "1";
                input.max = String(max);
                input.className = "asf-stm-input";
                input.placeholder = "default";
                input.dataset.groupLimit = key;
                input.value = group[key] || "";
                field.appendChild(input);
                row.appendChild(field);
            }
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "btn_darkred_white_innerfade btn_small";
            const removeLabel = document.createElement("span");
            removeLabel.textContent = "Remove";
            remove.appendChild(removeLabel);
            remove.setAttribute("aria-label", `Remove ${group.url}`);
            remove.addEventListener("click", () => row.remove());
            row.appendChild(remove);
            tab.querySelector("#savedGroups").appendChild(row);
        }
        globalSettings.groups.forEach(addRow);
        tab.querySelector("#addGroupButton").addEventListener("click", () => {
            const status = tab.querySelector("#groupSettingsStatus");
            try {
                const url = normalizeGroupUrl(tab.querySelector("#addGroupUrl").value);
                if (Array.from(tab.querySelectorAll("[data-group-url]")).some(row => row.dataset.groupUrl.toLowerCase() === url.toLowerCase())) {
                    throw new Error("Group already saved");
                }
                addRow({url, enabled: true});
                tab.querySelector("#addGroupUrl").value = "";
                status.textContent = "Group added; click Save to persist.";
            } catch (error) {
                status.textContent = error.message;
            }
        });
    }

    function readGroupSettings(configDialog) {
        const tradeUrls = configDialog.querySelector("#groupTradeUrls").value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => parseTradeUrl(line).url);
        const partners = tradeUrls.map(url => parseTradeUrl(url).partner);
        if (new Set(partners).size !== partners.length) {
            throw new Error("Provide only one trade URL per partner");
        }
        return {
            scanGroups: configDialog.querySelector("#scanGroups").checked,
            groupLimit: boundedLimit(configDialog.querySelector("#groupLimit").value, 3, 100),
            groupMemberLimit: boundedLimit(configDialog.querySelector("#groupMemberLimit").value, 100, 10000),
            groupPageLimit: boundedLimit(configDialog.querySelector("#groupPageLimit").value, 10, 1000),
            groups: Array.from(configDialog.querySelectorAll("[data-group-url]"), row => ({
                url: normalizeGroupUrl(row.dataset.groupUrl),
                enabled: row.querySelector("[data-group-enabled]").checked,
                memberLimit: row.querySelector('[data-group-limit="memberLimit"]').value ? boundedLimit(row.querySelector('[data-group-limit="memberLimit"]').value, 100, 10000) : null,
                pageLimit: row.querySelector('[data-group-limit="pageLimit"]').value ? boundedLimit(row.querySelector('[data-group-limit="pageLimit"]').value, 10, 1000) : null,
            })),
            tradeUrls,
        };
    }

    function ShowConfigDialog() {
        let filterBG = rgbaToHex(globalSettings.filterBackgroundColor);
        const questionmarkURL = 'https://store.cloudflare.steamstatic.com/public/shared/images/ico/icon_questionmark.png';
        const options = [
            { value: "MatchEverythingFirst", text: '"Any" bots first' },
            { value: "MatchEverythingLast", text: '"Any" bots last' },
            { value: "TotalGamesCountDesc", text: "Total games count, descending" },
            { value: "TotalGamesCountAsc", text: "Total games count, ascending" },
            { value: "TotalItemsCountDesc", text: "Total matchable items count, descending" },
            { value: "TotalItemsCountAsc", text: "Total matchable items count, ascending" },
            { value: "TotalInventoryCountDesc", text: "Total inventory count, descending" },
            { value: "TotalInventoryCountAsc", text: "Total inventory count, ascending" },
            { value: "None", text: "None" },
        ];

        function createSortSelect(idx) {
            return `
            <div>
                <span style="width: 80px; display: inline-block;">
                    ${idx === 0 ? "Sort bots by:" : "…then by:"}
                </span>
                <select class="asf-stm-select" id="sortBotsBy${idx}">
                    ${options.map( ({ value, text }) =>
                        `<option value="${value}" ${globalSettings.sortBotsBy[idx] === value ? 'selected' : ''}>${text}</option>`
                    ).join('')}
                </select>
            </div>`.replaceAll(/(  |\n)/g, '');
        }

        try {
            globalSettings.scanFilters.sort((x, y) => x.title < y.title ? -1 : x.title > y.title ? 1 : x.appId - y.appId);
        } catch (error) {
            globalSettings.scanFilters = deepClone(defaultSettings.scanFilters);
            SaveConfig();
        }
        const scanFiltersTemplate = globalSettings.scanFilters.map(x => createScanFilterElement(x.active, x.appId, x.title)).join('');

        const configDialogTemplate = `<div class="asf-stm-config"><ul class="asf_stm_tabs" style="margin: 0;padding: 0;"><li class="asf_stm_tab"><input type="radio" id="asf_stm_tab1" name="asf_stm_tabs" checked><label for="asf_stm_tab1">Matcher</label><div id="asf_stm_tab-content1" class="asf_stm_content"><fieldset><legend>SCAN SOURCES</legend><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">Bots</span><input type="checkbox" id="scanBots" ${globalSettings.scanBots ? 'checked' : ''} class="asf-stm-checkbox"><br><span class="asf-stm-margin-right">Friends</span><input type="checkbox" id="scanFriends" ${globalSettings.scanFriends ? 'checked' : ''} class="asf-stm-checkbox"><a class="tooltip hover_tooltip" data-tooltip-text="All enabled sources are scanned together in one run."><img src="${questionmarkURL}"></a></div></fieldset><fieldset><legend>ASF BOTS</legend><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">Match with "Any" bots</span><input type="checkbox" id="anyBots" ${globalSettings.anyBots ? 'checked' : ''} class="asf-stm-checkbox"><br><span class="asf-stm-margin-right">Match with "Fair" bots</span><input type="checkbox" id="fairBots" ${globalSettings.fairBots ? 'checked' : ''} class="asf-stm-checkbox"></div><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">Minimum items:</span><input type="number" id="botMinItems" value=${globalSettings.botMinItems} min="0" class="asf-stm-input"><br><span class="asf-stm-margin-right">Maximum items:</span><input type="number" id="botMaxItems" value=${globalSettings.botMaxItems} min="0" class="asf-stm-input"><a class="tooltip hover_tooltip" data-tooltip-text="Don't match with bots that has less or more than required limit of items in steam inventory. 0 means no limit on number of items"><img src="${questionmarkURL}"></a></div><div class="asf-stm-margin-bottom">${Array.from({ length: 4 }, (_, i) => createSortSelect(i)).join('')}</div></fieldset><fieldset><legend>INTERFACE</legend><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">Game filter pop-up background color:</span><input type="color" id="filterBackgroundColor" value="${filterBG[0]}" class="asf-stm-input" style="margin-right: 1.5em;"><span class="asf-stm-margin-right">opacity:</span><input type="range" id="filterBackgroundAlpha" value=${filterBG[1]} min=0 max=1 step=0.01 class="asf-stm-range" style="height: 4px;"><br></div><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">Sort results by game name</span><input type="checkbox" id="sortByName" class="asf-stm-checkbox" ${globalSettings.sortByName ? 'checked' : ''}></div><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">Prevent navigation or page leave</span><input type="checkbox" id="preventClose" class="asf-stm-checkbox" ${globalSettings.preventClose ? 'checked' : ''}><a class="tooltip hover_tooltip" data-tooltip-text="A dialog box will prevent navigation and exitting the page to avoid losing progess."><img src="${questionmarkURL}"></a></div></fieldset><fieldset><legend>INVENTORY CACHE</legend><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">Enable cache</span><input type="checkbox" id="enableInventoryCache" ${globalSettings.enableInventoryCache ? 'checked' : ''} class="asf-stm-checkbox"><br><span class="asf-stm-span">Refresh after (minutes):</span><input type="number" id="inventoryCacheTtlMinutes" value=${globalSettings.inventoryCacheTtlMinutes} min="1" class="asf-stm-input"><br><span class="asf-stm-span">Max entries:</span><input type="number" id="inventoryCacheMaxEntries" value=${globalSettings.inventoryCacheMaxEntries} min="1" class="asf-stm-input"><br><span class="asf-stm-margin-right">Bypass next scan</span><input type="checkbox" id="forceFreshScan" ${globalSettings.forceFreshScan ? 'checked' : ''} class="asf-stm-checkbox"><a class="tooltip hover_tooltip" data-tooltip-text="Skips cached scan-target and inventory data once, then turns itself off after that run. Stale inventory stays saved and can refresh later."><img src="${questionmarkURL}"></a></div><div class="asf-stm-margin-bottom"><button id="clearInventoryCache" class="btn_darkred_white_innerfade btn_small asf-stm-margin-right"><span>Clear inventory cache</span></button><span data-asf-stm-cache-status style="color:#8F98A0;"></span></div></fieldset><fieldset style="display: grid;grid-template-columns: repeat(2, 1fr);grid-template-rows: repeat(4, 1fr);gap: 12px;"><legend>SETTINGS</legend><fieldset style="grid-row: span 4 / span 4;grid-column-start: 2;grid-row-start: 1;"><legend>DEVELOPER</legend><div><span class="asf-stm-margin-right">Debug</span><input type="checkbox" id="debug" ${globalSettings.debug ? 'checked' : ''} class="asf-stm-checkbox"><a class="tooltip hover_tooltip" data-tooltip-text="Enable additional output to console"><img src="${questionmarkURL}"></a></div></fieldset><div><span class="asf-stm-span">Web limiter delay (ms):</span><input type="number" id="weblimiter" value= ${globalSettings.weblimiter} min=0 class="asf-stm-input"></div><div style="grid-column-start: 1;grid-row-start: 2;"><span class="asf-stm-span">Delay on error (ms):</span><input type="number" id="errorLimiter" value=${globalSettings.errorLimiter} min=0 class="asf-stm-input"></div><div style="grid-column-start: 1;grid-row-start: 3;"><span class="asf-stm-span">Max errors:</span><input type="number" id="maxErrors" value=${globalSettings.maxErrors} min=0 class="asf-stm-input"></div><div style="grid-column-start: 1;grid-row-start: 4;"><span class="asf-stm-span">Parallel requests:</span><input type="number" id="scanConcurrency" value=${globalSettings.scanConcurrency} min=1 class="asf-stm-input"><a class="tooltip hover_tooltip" data-tooltip-text="Number of badge requests to fetch at the same time per scan target. Higher values scan faster but increase the risk of rate limiting."><img src="${questionmarkURL}"></a></div></fieldset></div></li><li class="asf_stm_tab"><input type="radio" id="asf_stm_tab2" name="asf_stm_tabs"><label for="asf_stm_tab2">Trade helper</label><div id="asf_stm_tab-content2" class="asf_stm_content"><fieldset><legend>TRADE OFFER MESSAGE</legend><textarea id="tradeMessage" name="tradeMessage" rows="4" cols="60" class="asf-stm-textarea"></textarea><a class="tooltip hover_tooltip" data-tooltip-text="Custom text that will be included automatically with your trade offers created through STM while using this userscript. To remove this functionality, simply delete the text."><img src="${questionmarkURL}"></a></fieldset><fieldset><legend>ACTION AFTER TRADE</legend><label for="after-trade" class="asf-stm-margin-right">After trade...</label><select id="doAfterTrade" name="after-trade" class="asf-stm-select asf-stm-margin-bottom"><option value="NOTHING" ${globalSettings.doAfterTrade === "NOTHING" ? 'selected' : ''}>Do Nothing</option><option value="CLOSE_WINDOW" ${globalSettings.doAfterTrade === "CLOSE_WINDOW" ? 'selected' : ''}>Close window</option><option value="CLICK_OK" ${globalSettings.doAfterTrade === "CLICK_OK" ? 'selected' : ''}>Click OK</option></select><a class="tooltip hover_tooltip" data-tooltip-html="<p>Determines what happens when you complete a trade offer.</p><ul><li><strong>Do nothing</strong>: Will do nothing more than the normal behavior.</li><li><strong>Close window</strong>: Will close the window after the trade offer is sent.</li><li><strong>Click OK</strong>: Will redirect you to the trade offers recap page.</li></ul>"><img src="${questionmarkURL}"></a></fieldset><fieldset><legend>CARDS OFFER</legend><label for="cards-order" class="asf-stm-margin-right">Cards order</label><select id="order" name="cards-order" class="form-control asf-stm-select asf-stm-margin-bottom"><option value="SORT" ${globalSettings.order === "SORT" ? 'selected' : ''}>Sorted</option><option value="RANDOM" ${globalSettings.order === "RANDOM" ? 'selected' : ''}>Random</option><option value="AS_IS" ${globalSettings.order === "AS_IS" ? 'selected' : ''}>As is</option></select><a class="tooltip hover_tooltip" data-tooltip-html="<p>Determines which card is added to trade.</p><ul><li><strong>Sorted</strong>: Will sort cards by their IDs before adding to trade. If you make several trade offers with the same card and one of them is accepted, the rest will have message &quot;cards unavilable to trade&quot;.</li><li><strong>Random</strong>: Will add cards to trade randomly. If you make several trade offers and one of them is accepted, only some of them will be unavilable for trade.</li><li><strong>As is</strong>: Script doesn't change anything in order. Results vary depending on browser, steam servers, weather...</li></ul>"><img src="${questionmarkURL}"></a></fieldset><fieldset><legend>AUTO-SEND TRADE OFFER</legend><div class="asf-stm-margin-bottom"><label for="auto-send" class="asf-stm-margin-right">Enable</label><input type="checkbox" id="autoSend" name="auto-send" value="1" ${globalSettings.autoSend ? 'checked' : ''} class="asf-stm-checkbox asf-stm-margin-bottom"><a class="tooltip hover_tooltip" data-tooltip-text="Makes it possible for the script to automatically send trade offers without any action on your side. This is not recommended as you should always check your trade offers, but, well, this is a possible thing. Please note that incomplete trade offers (missing cards, ...) won't be sent automatically even when this parameter is set to true."><img src="${questionmarkURL}"></a></div></fieldset></div></li><li class="asf_stm_tab"><input type="radio" id="asf_stm_tab3" name="asf_stm_tabs"><label for="asf_stm_tab3">Blacklist</label><div id="asf_stm_tab-content3" class="asf_stm_content"><div class="title_text profile_xp_block_remaining"><h1 style="margin: 0.5em;">Ignored SteamIDs</h1><textarea class="asf-stm-textarea" id="blacklist" name="Blacklist" rows="17" cols="63"></textarea></div></div></li><li class="asf_stm_tab"><input type="radio" id="asf_stm_tab4" name="asf_stm_tabs"><label for="asf_stm_tab4">Whitelist</label><div class="asf_stm_content" id="asf_stm_tab-content4"><div class="title_text profile_xp_block_remaining"><h1 style="margin: 0.5em;">Additional SteamIDs to scan</h1><textarea class="asf-stm-textarea" id="whitelist" name="Whitelist" rows="17" cols="63"></textarea></div></div></li><li class="asf_stm_tab"><input type="radio" id="asf_stm_tab5" name="asf_stm_tabs"><label for="asf_stm_tab5">Scan filters</label><div class="asf_stm_content" id="asf_stm_tab-content5"><fieldset><legend>SETTINGS</legend><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">Use scan filters</span><input type="checkbox" id="useScanFilters" ${globalSettings.useScanFilters ? 'checked' : ''} class="asf-stm-checkbox"><a class="tooltip hover_tooltip" data-tooltip-text="Filter badges to cut short the duration of the scan."><img src="${questionmarkURL}"></a><br><span class="asf-stm-margin-right">Auto add new scan filters</span><input type="checkbox" id="autoAddScanFilters" ${globalSettings.autoAddScanFilters ? 'checked' : ''} class="asf-stm-checkbox"><a class="tooltip hover_tooltip" data-tooltip-text="Add new scan filters from a fresh scan (clear all your filters)."><img src="${questionmarkURL}"></a><br><span class="asf-stm-margin-right">Auto delete old scan filters</span><input type="checkbox" id="autoDeleteScanFilters" ${globalSettings.autoDeleteScanFilters ? 'checked' : ''} class="asf-stm-checkbox"><a class="tooltip hover_tooltip" data-tooltip-text="Delete scan filters from badges without duplicates."><img src="${questionmarkURL}"></a></div></fieldset><fieldset><legend>MANAGE SCAN FILTERS</legend><div class="asf-stm-margin-bottom"><span class="asf-stm-margin-right">App Id:</span><input type="number" id="addScanFilterAppId" step="10" required class="asf-stm-input asf-stm-margin-right appid-validity"><button id="addScanFilterButton" class="btn_blue_steamui btn_small asf-stm-margin-right"><span>Add scan filter</span></button><span id="addScanFilterStatus"></span></div><div class="asf-stm-margin-bottom"><button onclick="document.querySelector('#clearScanFilters').style.visibility = 'visible'" class="btn_plum btn_small asf-stm-margin-right"><span>Clear scan filters</span></button><button id="clearScanFilters" class="btn_darkred_white_innerfade btn_small" style="visibility: hidden;"><span>Are you sure?</span></button></div></fieldset><fieldset><legend>FILTERS</legend><div id="asf-stm-filters" style="column-gap: 4px;display: flex;flex-wrap: wrap;justify-content: flex-start;">${scanFiltersTemplate}</div></fieldset></div></li></ul></div>`;
        let templateElement = document.createElement("template");
        const scanSourcesTemplate = `<fieldset><legend>SCAN SOURCES</legend><div class="asf-stm-scan-sources">${[
            ["scanBots", "ASF bots", "Discover matching bots from the ASF listing."],
            ["scanFriends", "Friends", "All enabled sources are scanned together in one run."],
            ["scanGroups", "Groups", "Discover members of enabled saved Steam groups within configured limits."],
        ].map(([id, name, tooltip]) => `<div class="asf-stm-scan-source"><label for="${id}"><input type="checkbox" id="${id}" class="asf-stm-checkbox" ${globalSettings[id] ? "checked" : ""}><span>${name}</span></label><a class="tooltip hover_tooltip" data-tooltip-text="${tooltip}"><img src="${questionmarkURL}" alt="Help"></a></div>`).join("")}</div></fieldset>`;
        templateElement.innerHTML = configDialogTemplate.replace(/<fieldset><legend>SCAN SOURCES<\/legend>.*?<\/fieldset>/, scanSourcesTemplate);
        let configDialog = templateElement.content.firstChild;
        createGroupSettingsPanel(configDialog);
        configDialog.querySelector("#tradeMessage").value = globalSettings.tradeMessage;
        configDialog.querySelector("#blacklist").value = arrayToText(blacklist);
        configDialog.querySelector("#whitelist").value = arrayToText(whitelist);

        configDialog.querySelector("#addScanFilterButton").addEventListener("click", addScanFilterEventHandler, false);
        configDialog.querySelector("#clearScanFilters").addEventListener("click", clearScanFiltersEventHandler, false);
        configDialog.querySelector("#clearInventoryCache").addEventListener("click", clearInventoryCacheEventHandler, false);

        unsafeWindow.ShowConfirmDialog("ASF STM Configuration", configDialog, "Save", "Cancel", "Reset").done(function (button) {
            if (button === "OK") {
                let groupSettings;
                try {
                    groupSettings = readGroupSettings(configDialog);
                } catch (error) {
                    unsafeWindow.ShowAlertDialog("Settings not saved", error.message);
                    return;
                }
                Object.assign(globalSettings, groupSettings);
                globalSettings.scanBots = configDialog.querySelector("#scanBots").checked;
                globalSettings.scanFriends = configDialog.querySelector("#scanFriends").checked;
                globalSettings.anyBots = configDialog.querySelector("#anyBots").checked;
                globalSettings.fairBots = configDialog.querySelector("#fairBots").checked;
                globalSettings.sortByName = configDialog.querySelector("#sortByName").checked;
                let newsortBotsBy = [];
                configDialog.querySelectorAll("[id^=sortBotsBy]").forEach(function (elem) {
                    newsortBotsBy.push(elem.selectedOptions[0].value);
                });
                globalSettings.sortBotsBy = newsortBotsBy;
                let newbotMinItems = Number(configDialog.querySelector("#botMinItems").value);
                globalSettings.botMinItems = isNaN(newbotMinItems) ? globalSettings.botMinItems : newbotMinItems;
                let newbotMaxItems = Number(configDialog.querySelector("#botMaxItems").value);
                globalSettings.botMaxItems = isNaN(newbotMaxItems) ? globalSettings.botMaxItems : newbotMaxItems;
                let newweblimiter = Number(configDialog.querySelector("#weblimiter").value);
                globalSettings.weblimiter = isNaN(newweblimiter) ? globalSettings.weblimiter : newweblimiter;
                let newerrorLimiter = Number(configDialog.querySelector("#errorLimiter").value);
                globalSettings.errorLimiter = isNaN(newerrorLimiter) ? globalSettings.errorLimiter : newerrorLimiter;
                globalSettings.debug = configDialog.querySelector("#debug").checked;
                let newmaxErrors = Number(configDialog.querySelector("#maxErrors").value);
                globalSettings.maxErrors = isNaN(newmaxErrors) ? globalSettings.maxErrors : newmaxErrors;
                let newscanConcurrency = Number(configDialog.querySelector("#scanConcurrency").value);
                globalSettings.scanConcurrency = isNaN(newscanConcurrency) || newscanConcurrency < 1 ? globalSettings.scanConcurrency : Math.floor(newscanConcurrency);
                globalSettings.filterBackgroundColor = mixAlpha(hexToRgba(configDialog.querySelector("#filterBackgroundColor").value), configDialog.querySelector("#filterBackgroundAlpha").value);
                globalSettings.preventClose = configDialog.querySelector("#preventClose").checked;
                globalSettings.tradeMessage = configDialog.querySelector("#tradeMessage").value;
                globalSettings.autoSend = configDialog.querySelector("#autoSend").checked;
                globalSettings.doAfterTrade = configDialog.querySelector("#doAfterTrade").selectedOptions[0].value;
                globalSettings.order = configDialog.querySelector("#order").selectedOptions[0].value;
                globalSettings.enableInventoryCache = configDialog.querySelector("#enableInventoryCache").checked;
                let newInventoryCacheTtlMinutes = Number(configDialog.querySelector("#inventoryCacheTtlMinutes").value);
                globalSettings.inventoryCacheTtlMinutes = isNaN(newInventoryCacheTtlMinutes) || newInventoryCacheTtlMinutes <= 0 ? defaultSettings.inventoryCacheTtlMinutes : newInventoryCacheTtlMinutes;
                let newInventoryCacheMaxEntries = Number(configDialog.querySelector("#inventoryCacheMaxEntries").value);
                globalSettings.inventoryCacheMaxEntries = isNaN(newInventoryCacheMaxEntries) || newInventoryCacheMaxEntries <= 0 ? defaultSettings.inventoryCacheMaxEntries : Math.floor(newInventoryCacheMaxEntries);
                globalSettings.forceFreshScan = configDialog.querySelector("#forceFreshScan").checked;
                if (!globalSettings.scanBots && !globalSettings.scanFriends && !globalSettings.scanGroups && whitelist.length === 0) {
                    globalSettings.scanBots = true;
                }
                globalSettings.useScanFilters = configDialog.querySelector("#useScanFilters").checked;
                globalSettings.autoAddScanFilters = configDialog.querySelector("#autoAddScanFilters").checked;
                globalSettings.autoDeleteScanFilters = configDialog.querySelector("#autoDeleteScanFilters").checked;
                let filters = Object.fromEntries(Array.from(configDialog.querySelectorAll('input[data-app-id]'), x => [x.dataset.appId, x.checked]));
                globalSettings.scanFilters.forEach(x => {x.active = filters[String(x.appId)]});
                blacklist = textToArray(configDialog.querySelector("#blacklist").value);
                whitelist = textToArray(configDialog.querySelector("#whitelist").value);
                SaveConfig();
                resetCacheStats();
            } else if (button !== "CANCEL") {
                unsafeWindow.ShowConfirmDialog("CONFIRMATION", "Are you sure you want to restore default settings?").done(function () {
                    ResetConfig();
                    SaveConfig();
                });
            }
        });
        setTimeout(updateCacheStatus, 0);
    }

    function ResetConfig() {
        //we won't clear blacklist here!
        globalSettings = deepClone(defaultSettings);
        cacheBypassActive = false;
    }

    function SaveConfig() {
        localStorage.setItem(`${STORAGE_PREFIX}.Settings`, JSON.stringify(globalSettings));
        localStorage.setItem(`${STORAGE_PREFIX}.Blacklist`, JSON.stringify(blacklist));
        localStorage.setItem(`${STORAGE_PREFIX}.Whitelist`, JSON.stringify(whitelist));
    }

    function LoadConfig() {
        globalSettings = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}.Settings`));
        blacklist = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}.Blacklist`));
        whitelist = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}.Whitelist`));
        if (globalSettings === null) {
            ResetConfig();
        }
        if (blacklist === null) {
            blacklist = [];
        }
        if (!Array.isArray(whitelist)) {
            whitelist = [];
        }
        Object.keys(defaultSettings).forEach(function (key) {
            if (!Object.prototype.hasOwnProperty.call(globalSettings, key)) {
                globalSettings[key] = deepClone(defaultSettings[key]);
            }
        });
        if (globalSettings.matchFriends === true) {
            globalSettings.scanFriends = true;
            globalSettings.scanBots = false;
            delete globalSettings.matchFriends;
            SaveConfig();
        }
        if (globalSettings.scanBots === false && globalSettings.scanFriends === false && !globalSettings.scanGroups && whitelist.length === 0) {
            globalSettings.scanBots = true;
        }
        globalSettings.groups = Array.isArray(globalSettings.groups) ? globalSettings.groups.flatMap(group => {
            try {
                return [{...group, url: normalizeGroupUrl(group.url)}];
            } catch (error) {
                return [];
            }
        }) : [];
        globalSettings.tradeUrls = Array.isArray(globalSettings.tradeUrls) ? globalSettings.tradeUrls.flatMap(url => {
            try {
                return [parseTradeUrl(url).url];
            } catch (error) {
                return [];
            }
        }) : [];
        if (isNaN(Number(globalSettings.inventoryCacheTtlMinutes)) || Number(globalSettings.inventoryCacheTtlMinutes) <= 0) {
            globalSettings.inventoryCacheTtlMinutes = defaultSettings.inventoryCacheTtlMinutes;
        }
        if (isNaN(Number(globalSettings.inventoryCacheMaxEntries)) || Number(globalSettings.inventoryCacheMaxEntries) <= 0) {
            globalSettings.inventoryCacheMaxEntries = defaultSettings.inventoryCacheMaxEntries;
        } else {
            globalSettings.inventoryCacheMaxEntries = Math.floor(Number(globalSettings.inventoryCacheMaxEntries));
        }
        cacheBypassActive = false;
        resetCacheStats();
    }

    function SaveParams() {
        if (tradeParams.cardNames === undefined) {
            tradeParams.cardNames = Array.from(cardNames);
        }
        localStorage.setItem(`${STORAGE_PREFIX}.Params`, JSON.stringify(tradeParams));
    }

    function LoadParams() {
        return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}.Params`));
    }

    function AddScanFilter(appId) {
        if (appId <= 0) {
            return {success: false, message: 'Invalid AppID'};
        }
        if (globalSettings.scanFilters.findIndex(x => x.appId == appId) != -1) {
            return {success: false, message: 'Filter exists'};
        }
        globalSettings.scanFilters.push({appId: appId, title: appId, active: true});
        return {success: true, message: 'Added'};
    }

    function ResetScanFilters() {
        globalSettings.scanFilters = [];
    }

    function enableButton() {
        let buttonDiv = document.getElementById("asf_stm_button_div");
        buttonDiv.setAttribute("class", "profile_small_header_additional");
        buttonDiv.setAttribute("title", "Scan ASF STM");
        let button = document.getElementById("asf_stm_button");
        button.addEventListener("click", buttonPressedEvent, false);
    }

    function disableButton() {
        let buttonDiv = document.getElementById("asf_stm_button_div");
        buttonDiv.setAttribute("class", "profile_small_header_additional btn_disabled");
        buttonDiv.setAttribute("title", "Scan is in process");
        let button = document.getElementById("asf_stm_button");
        button.removeEventListener("click", buttonPressedEvent, false);
    }

    function updateProgress(radial) {
        progressRadials[radial].currentStep++;
        const totalSteps = progressRadials[radial].steps;
        const ratio = progressRadials[radial].currentStep / totalSteps;
        const degrees = ratio * 360;

        progressRadials[radial].radialElement.style.setProperty('--progress', `${degrees}deg`);
        if (progressRadials[radial].currentStep >= totalSteps) {
            progressRadials[radial].textElement.textContent = '✓';
        } else {
            progressRadials[radial].textElement.textContent = `${progressRadials[radial].currentStep} / ${totalSteps}`
        }
    }

    function blacklistEventHandler(event) {
        let steamID = event.currentTarget.id.split("_")[1];
        if (blacklist.includes(steamID)) {
            return;
        }

        unsafeWindow.ShowConfirmDialog("CONFIRMATION", `Are you sure you want to blacklist bot ${steamID} ?`).done(function () {
            blacklist.push(steamID);
            SaveConfig();
        });
    }

    function filterAllEventHandler(event) {
        let appIds = event.target.dataset.appids.split(",");
        appIds = appIds.map((id) => "astm_" + id);
        for (let appId of appIds) {
            let target = document.querySelector("#" + appId);
            if (target && target.checked) {
                target.click();
            }
        }
    }

    /**
     * Simple function to sanitize nicknames before adding them to the DOM.
     * Taken from https://stackoverflow.com/a/48226843/5853386
     */
    function escapeHtml(value) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#x27;',
            "/": '&#x2F;',
        };
        const reg = /[&<>"'/]/ig;
        return String(value ?? "").replace(reg, (match)=>(map[match]));
    }

    function sanitizeNickname(nickname) {
        return escapeHtml(nickname);
    }

    function sanitizeAppId(value) {
        const stringValue = String(value ?? "");
        return /^\d+$/.test(stringValue) ? stringValue : "0";
    }

    function sanitizeSteamProfilePath(value) {
        return String(value ?? "").replace(/[^a-zA-Z0-9/_-]/g, "").replace(/^\/+|\/+$/g, "");
    }

    function sanitizeSteamCommunityUrl(value) {
        try {
            const url = new URL(String(value ?? ""));
            if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname === "steamcommunity.com") {
                return url.toString();
            }
        } catch (error) {
            // ignored
        }
        return "#";
    }

    function sanitizeSteamMediaUrl(value) {
        try {
            const url = new URL(String(value ?? ""));
            if (url.protocol === "https:" && /(^|\.)steamstatic\.com$|(^|\.)akamaihd\.net$/i.test(url.hostname)) {
                return url.toString().replace(/\/+$/, "");
            }
        } catch (error) {
            // ignored
        }
        return "https://store.akamai.steamstatic.com/public/images/gift/steam_logo_digitalgiftcard.png";
    }

    function sanitizeAvatarHash(value) {
        const stringValue = String(value ?? "");
        return /^[0-9a-f]+$/i.test(stringValue) ? stringValue : "fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb";
    }

    function sanitizeFilterBackgroundColor(value) {
        const stringValue = String(value ?? "");
        if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(stringValue) || /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(stringValue)) {
            return stringValue;
        }
        return "rgba(23,26,33,0.8)";
    }

    function getDuplicateCount(count) {
        return Math.max(Number(count) - 1, 0);
    }

    function populateCards(item, options = {}) {
        const showDuplicateCount = options.showDuplicateCount === true;
        let htmlCards = "";
        for (let j = 0; j < item.cards.length; j++) {
            const itemIcon = sanitizeSteamMediaUrl(item.cards[j].iconUrl);
            const itemName = escapeHtml(item.cards[j].item);
            const itemCount = Number(item.cards[j].count) || 0;
            const duplicateCount = Number(item.cards[j].duplicateCount);
            const countBadge = itemCount > 1
                ? `<div class="commentthread_subscribe_hint" style="position:absolute;top:4px;right:4px;min-width:20px;padding:0 4px;text-align:center;border-radius:999px;background:rgba(23,26,33,0.9);"><b>x${itemCount}</b></div>`
                : "";
            const duplicateLabel = showDuplicateCount && Number.isFinite(duplicateCount)
                ? `<div class="commentthread_subscribe_hint" style="width: 98px;">Dupes: ${duplicateCount}</div>`
                : "";
            let cardTemplate = `
                <div class="showcase_slot">
                    <div style="position:relative;display:inline-block;">
                        <img class="image-container" src="${itemIcon}/98x115">
                        ${countBadge}
                    </div>
                    <div class="commentthread_subscribe_hint" style="width: 98px;">${itemName}</div>
                    ${duplicateLabel}
                </div>
            `;
            htmlCards += cardTemplate.replaceAll(/(  |\n)/g, '');
        }
        return htmlCards;
    }

    function checkRow(row) {
        if (row.dataset.sourceHidden === "true") {
            row.style.display = "none";
            return;
        }
        let matches = row.getElementsByClassName("badge_row");
        let visible = false;
        for (let i = 0; i < matches.length; i++) {
            if (matches[i].parentElement.style.display !== "none") {
                visible = true;
                break;
            }
        }
        if (visible) {
            row.style.display = "block";
        } else {
            row.style.display = "none";
        }
    }

    function addMatchRow(index) {
        let itemsToSend = bots.Result[index].itemsToSend;
        let itemsToReceive = bots.Result[index].itemsToReceive;

        function compareNames(a, b) {
            const nameA = a.title;
            const nameB = b.title;
            if (nameA < nameB) {
                return -1;
            }
            if (nameA > nameB) {
                return 1;
            }
            return 0;
        }

        if (globalSettings.sortByName) {
            itemsToSend.sort(compareNames);
            itemsToReceive.sort(compareNames);
        }

        const target = bots.Result[index];
        const botProfileLink = getTargetProfileLink(target);
        let matches = "";
        let any = "";
        let appIdList = [];
        if (target.MatchEverything) {
            any = `&nbsp;<sup><span class="avatar_block_status_in-game" style="font-size: 8px; cursor:help" title="This bot trades for any cards within same set">&nbsp;ANY&nbsp;</span></sup>`;
        }
        const sourceBadge = `&nbsp;<sup>${getTargetSourceBadge(target)}</sup>`;
        for (let i = 0; i < itemsToSend.length; i++) {
            let appId = itemsToSend[i].appId;
            appIdList.push(appId);
            let itemToReceive = itemsToReceive.find((a) => a.appId == appId);
            let gameName = itemsToSend[i].title;
            let display = "inline-block";

            let filterWidget = document.getElementById("asf_stm_filters_body");
            let placeholder = document.getElementById("asf_stm_placeholder");
            if (placeholder !== null) {
                placeholder.parentNode.removeChild(placeholder);
            }
            let checkBox = document.getElementById("astm_" + appId);
            if (checkBox === null) {
                const safeAppId = sanitizeAppId(appId);
                const safeGameName = escapeHtml(gameName);
                let newFilter = `<span style="margin-right: 15px; white-space: nowrap; display: inline-block;"><input type="checkbox" id="astm_${safeAppId}" checked="" /><label for="astm_${safeAppId}" data-count="1">${safeGameName} <b>(1)</b></label></span>`;
                let spanTemplate = document.createElement("template");
                spanTemplate.innerHTML = newFilter.trim();
                filterWidget.appendChild(spanTemplate.content.firstChild);
                tradeParams.filter.push(Number(appId));
                SaveParams();
            } else {
                const label = checkBox.parentElement.querySelector('label');
                label.dataset.count = parseInt(label.dataset.count) + 1;
                if (checkBox.checked === false) {
                    display = "none";
                }
            }

            let sendResult = populateCards(itemsToSend[i], { showDuplicateCount: true });
            let receiveResult = populateCards(itemToReceive);
            let tradeUrlApp = getTargetTradeUrl(target, appId);
            const safeAppId = sanitizeAppId(appId);
            const safeGameName = escapeHtml(gameName);
            const safeMyProfileLink = sanitizeSteamProfilePath(myProfileLink);
            const safeTradeUrlApp = sanitizeSteamCommunityUrl(tradeUrlApp);
            const safeBotProfileLink = sanitizeSteamProfilePath(botProfileLink);

            let matchTemplate = `<div class="asf_stm_appid_${safeAppId}" style="display:${display}"><div class="badge_row is_link goo_untradable_note showcase_slot"><div class="notLoggedInText"><div title="View badge progress for this game"><a target="_blank" rel="noopener noreferrer" href="https://steamcommunity.com/${safeMyProfileLink}/gamecards/${safeAppId}/"><img style="background-color: var(--gpStoreDarkerGrey);" height=69 alt="${safeGameName}" src="https://steamcdn-a.akamaihd.net/steam/apps/${safeAppId}/capsule_184x69.jpg"onerror="this.onerror=null;this.src='https://store.akamai.steamstatic.com/public/images/gift/steam_logo_digitalgiftcard.png'"><div>${safeGameName}</div></a></div><a href="${safeTradeUrlApp}" target="_blank" rel="noopener noreferrer"><div class="btn_darkblue_white_innerfade btn_medium"><span>Offer a trade</span></div></a></div><div class="showcase_slot"><div class="showcase_slot profile_header"><div class="badge_info_unlocked profile_xp_block_mid avatar_block_status_in-game badge_info_title badge_row_overlay" style="height: 15px;">You</div>${sendResult}</div><span class="showcase_slot badge_info_title booster_creator_actions"><h1>&#10145;</h1></span></div><div class="showcase_slot profile_header"><a href="https://steamcommunity.com/${safeBotProfileLink}/gamecards/${safeAppId}/" target="_blank" rel="noopener noreferrer"><div class="badge_info_unlocked profile_xp_block_mid avatar_block_status_online badge_info_title badge_row_overlay ellipsis" style="height: 15px;">${sanitizeNickname(target.Nickname)}</div></a>${receiveResult}</div></div></div>`;
            matches += matchTemplate;
        }
        let tradeUrlFull = getTargetTradeUrl(target, 'all');
        const sourceKey = getTargetSourceKey(target);
        const safeTradeUrlFull = sanitizeSteamCommunityUrl(tradeUrlFull);
        const safeAppIdList = appIdList.map((value) => sanitizeAppId(value)).filter(Boolean).join();
        const safeAvatarHash = sanitizeAvatarHash(target.AvatarHash);
        const safeInventoryCount = Number.isFinite(Number(target.TotalInventoryCount)) ? Number(target.TotalInventoryCount) : 0;
        const safeSourceTypes = target.SourceTypes.filter((value) => value === "asf" || value === "friends" || value === "whitelist" || value === "groups").join(',');
        const safeSteamId = sanitizeAppId(target.SteamID);
        const safeBotProfileLink = sanitizeSteamProfilePath(botProfileLink);
        let rowTemplate = `<div id="asfstmbot_${index}" class="badge_row asf-stm-result-row" data-result-index="${index}" data-source-key="${sourceKey}" data-source-hidden="false" data-sources="${safeSourceTypes}" style="order:${index};"><div class="badge_row_inner"><div class="badge_title_row guide_showcase_contributors"><div class="badge_title_stats"><a class="filter_all" target="_blank" rel="noopener noreferrer" style="margin-right: 1em"><div class="btn_darkblue_white_innerfade btn_medium" data-appids="${safeAppIdList}"><span data-appids="${safeAppIdList}">Filter All</span></div></a><a class="full_trade_url" href="${safeTradeUrlFull}" target="_blank" rel="noopener noreferrer"><div class="btn_darkblue_white_innerfade btn_medium"><span>Offer a trade for all</span></div></a></div><div style="float: left;" class=""><div class="user_avatar playerAvatar online"><a target="_blank" rel="noopener noreferrer" href="https://steamcommunity.com/${safeBotProfileLink}"><img src="https://avatars.cloudflare.steamstatic.com/${safeAvatarHash}.jpg" /></a></div></div><div class="badge_title">&nbsp;<a target="_blank" rel="noopener noreferrer" href="https://steamcommunity.com/${safeBotProfileLink}">${sanitizeNickname(target.Nickname)}</a>${sourceBadge}${any}&ensp;<span style="color: #8F98A0;">(${safeInventoryCount} items)</span></div><div class="badge_title_stats"><span style="color:#8F98A0;margin-right:0.75em;">${getSourceLabel(sourceKey)}</span><a id="blacklist_${safeSteamId}" data-tooltip-text="Blacklist this target" class="tooltip hover_tooltip"><img src="https://community.cloudflare.steamstatic.com/public/images/skin_1/iconForumBan.png?v=1"></a></div></div><div class="badge_title_rule"></div>${matches}</div></div>`;
        let template = document.createElement("template");
        template.innerHTML = rowTemplate.trim();
        let mainContentDiv = document.getElementById("asf_stm_results_body") || document.getElementsByClassName("maincontent")[0];
        let newChild = template.content.firstChild;
        newChild.querySelector(`#blacklist_${safeSteamId}`).addEventListener("click", blacklistEventHandler, true);
        newChild.querySelector(".filter_all").addEventListener("click", filterAllEventHandler);
        mainContentDiv.appendChild(newChild);
        applyResultView();
    }

    function calcState(badge) {
        //state 0 - less than max sets; state 1 - we have max sets, even out the rest, state 2 - all even
        if (badge.cards[badge.maxCards - 1].count === badge.maxSets) {
            if (badge.cards[0].count === badge.lastSet) {
                return 2; //nothing to do
            } else {
                return 1; //max sets are here, but we can distribute cards further
            }
        } else {
            return 0; //less than max sets
        }
    }

    function storeMatches(steamID, itemsToSend, itemsToReceive) {
        let partner = getPartner(steamID);
        const target = bots?.Result?.find(entry => entry.TradePartner === partner);
        tradeParams.targetSafety = tradeParams.targetSafety || {};
        tradeParams.targetSafety[partner] = {
            manualReview: target?.SourceTypes.includes("groups") === true || (globalSettings.scanGroups && (!target?.TradeAccess || target.TradeAccess === "unknown")),
            tradeAccess: target?.TradeAccess || "unknown",
        };
        tradeParams.matches[partner] = {};
        for (let i = 0; i < itemsToSend.length; i++) {
            if (tradeParams.matches[partner][itemsToSend[i].appId] === undefined) {
                tradeParams.matches[partner][itemsToSend[i].appId] = { send: [], receive: [] };
            }
            for (let c = 0; c < itemsToSend[i].cards.length; c++) {
                for (let a = 0; a < itemsToSend[i].cards[c].count; a++) {
                    let cardID = tradeParams.cardNames.indexOf(itemsToSend[i].cards[c].hash);
                    tradeParams.matches[partner][itemsToSend[i].appId].send.push(cardID);
                }
            }
        }
        for (let i = 0; i < itemsToReceive.length; i++) {
            if (tradeParams.matches[partner][itemsToReceive[i].appId] === undefined) {
                throw new Error("Sent and received appIDs don't match!");
            }
            for (let c = 0; c < itemsToReceive[i].cards.length; c++) {
                for (let a = 0; a < itemsToReceive[i].cards[c].count; a++) {
                    let cardID = tradeParams.cardNames.indexOf(itemsToReceive[i].cards[c].hash);
                    tradeParams.matches[partner][itemsToReceive[i].appId].receive.push(cardID);
                }
            }
            if (tradeParams.matches[partner][itemsToReceive[i].appId].send.length !== tradeParams.matches[partner][itemsToReceive[i].appId].receive.length) {
                throw new Error("Sent and received card count don't match for " + tradeParams.matches[partner][itemsToReceive[i].appId] + " !");
            }
        }
        SaveParams();
        updateResultSummary();
    }

    function buildMatchesForTarget(index, availableMyBadges, targetBadges) {
        let itemsToSend = [];
        let itemsToReceive = [];
        const ownBadgesByAppId = new Map(availableMyBadges.map(badge => [Number(badge.appId), badge]));

        for (let i = 0; i < targetBadges.length; i++) {
            const targetBadge = targetBadges[i];
            const ownBadge = targetBadge && ownBadgesByAppId.get(Number(targetBadge.appId));
            if (!ownBadge || ownBadge.unmatchable || !Number.isSafeInteger(Number(targetBadge.appId)) || Number(targetBadge.appId) <= 0 ||
                !Array.isArray(targetBadge.cards) || targetBadge.cards.length === 0) {
                continue;
            }
            let myBadge = deepClone(ownBadge);
            let theirBadge = deepClone(targetBadge);
            const originalCardsByNumber = new Map(ownBadge.cards.map((card) => [card.number, card]));
            let myState = calcState(myBadge);
            while (myState < 2) {
                let foundMatch = false;
                for (let j = 0; j < theirBadge.maxCards; j++) {
                    //index of card they give
                    if (theirBadge.cards[j].count > 0 && (theirBadge.cards[j].tradableCount ?? theirBadge.cards[j].count) > 0) {
                        //try to match
                        let myInd = myBadge.cards.findIndex((a) => a.number === theirBadge.cards[j].number); //index of slot where we receive card
                        if (myInd < 0) {
                            continue;
                        }
                        if ((myState === 0 && myBadge.cards[myInd].count < myBadge.maxSets) || (myState === 1 && myBadge.cards[myInd].count < myBadge.lastSet)) {
                            //we need this for the Emperor
                            //find a card to match.
                            for (let k = 0; k < myInd; k++) {
                                //index of card we give
                                if ((myBadge.cards[k].tradableCount ?? myBadge.cards[k].count) > 0 &&
                                    ((myState === 0 && myBadge.cards[k].count > myBadge.maxSets) || (myState === 1 && myBadge.cards[k].count > myBadge.lastSet))) {
                                    //that's fine for us
                                    let theirInd = theirBadge.cards.findIndex((a) => a.number === myBadge.cards[k].number); //index of slot where they will receive card
                                    if (theirInd < 0) {
                                        continue;
                                    }
                                    if (!bots.Result[index].MatchEverything || bots.Result[index].SourceTypes.includes("groups")) {
                                        //make sure it's neutral+ for them
                                        if (theirBadge.cards[theirInd].count >= theirBadge.cards[j].count) {
                                            continue; //it's not neutral+, check other options
                                        }
                                    }
                                    const originalMyCard = originalCardsByNumber.get(myBadge.cards[k].number) || myBadge.cards[k];
                                    let itemToSend = {
                                        item: myBadge.cards[k].item,
                                        count: 1,
                                        iconUrl: myBadge.cards[k].iconUrl,
                                        hash: myBadge.cards[k].hash,
                                        duplicateCount: getDuplicateCount(originalMyCard.count),
                                    };
                                    let itemToReceive = {
                                        item: theirBadge.cards[j].item,
                                        count: 1,
                                        iconUrl: theirBadge.cards[j].iconUrl,
                                        hash: theirBadge.cards[j].hash,
                                    };
                                    //fill items to send
                                    let sendmatch = itemsToSend.find((item) => item.appId == myBadge.appId);
                                    if (sendmatch === undefined) {
                                        let newMatch = {
                                            appId: myBadge.appId,
                                            title: myBadge.title,
                                            cards: [itemToSend],
                                        };
                                        itemsToSend.push(newMatch);
                                    } else {
                                        let existingCard = sendmatch.cards.find((a) => a.hash === itemToSend.hash);
                                        if (existingCard === undefined) {
                                            sendmatch.cards.push(itemToSend);
                                        } else {
                                            existingCard.count += 1;
                                            existingCard.duplicateCount = itemToSend.duplicateCount;
                                        }
                                    }
                                    //add this item to their inventory
                                    theirBadge.cards[theirInd].count += 1;
                                    //remove this item from our inventory
                                    myBadge.cards[k].count -= 1;
                                    if (Number.isFinite(myBadge.cards[k].tradableCount)) {
                                        myBadge.cards[k].tradableCount -= 1;
                                    }

                                    //fill items to receive
                                    let receiveMatch = itemsToReceive.find((item) => item.appId == myBadge.appId);
                                    if (receiveMatch === undefined) {
                                        let newMatch = {
                                            appId: myBadge.appId,
                                            title: myBadge.title,
                                            cards: [itemToReceive],
                                        };
                                        itemsToReceive.push(newMatch);
                                    } else {
                                        let existingCard = receiveMatch.cards.find((a) => a.hash === itemToReceive.hash);
                                        if (existingCard === undefined) {
                                            receiveMatch.cards.push(itemToReceive);
                                        } else {
                                            existingCard.count += 1;
                                        }
                                    }
                                    //add this item to our inventory
                                    myBadge.cards[myInd].count += 1;
                                    //remove this item from their inventory
                                    theirBadge.cards[j].count -= 1;
                                    if (Number.isFinite(theirBadge.cards[j].tradableCount)) {
                                        theirBadge.cards[j].tradableCount -= 1;
                                    }
                                    foundMatch = true;
                                    break; //found a match!
                                }
                            }
                            if (foundMatch) {
                                //if we found something - we need to sort cards again and start over.
                                myBadge.cards.sort((a, b) => b.count - a.count);
                                myState = calcState(myBadge);
                            }
                        }
                    }
                }
                if (!foundMatch) {
                    break; //found no matches - move to next badge
                }
                theirBadge.cards.sort((a, b) => b.count - a.count);
            }
        }

        return { itemsToSend: itemsToSend, itemsToReceive: itemsToReceive };
    }

    function compareCards(index, callback) {
        const target = bots.Result[index];
        const targetBadges = getReconciledTargetBadges(target, Array.isArray(target.badgesSnapshot) ? target.badgesSnapshot : botBadges);
        const availableMyBadges = getReconciledMyBadges();
        const computedMatches = buildMatchesForTarget(index, availableMyBadges, targetBadges);
        let itemsToSend = computedMatches.itemsToSend;
        let itemsToReceive = computedMatches.itemsToReceive;

        bots.Result[index].itemsToSend = itemsToSend;
        bots.Result[index].itemsToReceive = itemsToReceive;
        if (itemsToSend.length > 0) {
            storeMatches(bots.Result[index].TradePartner, itemsToSend, itemsToReceive);
            addMatchRow(index);
            callback();
        } else {
            callback();
        }
    }

    function resetRenderedMatches() {
        const resultsBody = document.getElementById("asf_stm_results_body");
        const filtersBody = document.getElementById("asf_stm_filters_body");
        if (resultsBody) {
            resultsBody.innerHTML = "";
        }
        if (filtersBody) {
            filtersBody.innerHTML = `<span id="asf_stm_placeholder" style="margin-right: 15px;">No matches to filter</span>`;
        }
        tradeParams.matches = {};
        tradeParams.filter = [];
        SaveParams();
        updateResultSummary();
    }

    function renderStoredMatches() {
        if (!bots?.Result || !document.getElementById("asf_stm_results_body")) {
            return;
        }
        resetRenderedMatches();
        const availableMyBadges = getReconciledMyBadges();
        for (let i = 0; i < bots.Result.length; i++) {
            const storedTargetBadges = bots.Result[i].badgesSnapshot;
            const targetBadges = Array.isArray(storedTargetBadges) ? getReconciledTargetBadges(bots.Result[i], storedTargetBadges) : null;
            if (!Array.isArray(targetBadges)) {
                continue;
            }
            const computedMatches = buildMatchesForTarget(i, availableMyBadges, targetBadges);
            bots.Result[i].itemsToSend = computedMatches.itemsToSend;
            bots.Result[i].itemsToReceive = computedMatches.itemsToReceive;
            if (computedMatches.itemsToSend.length > 0) {
                storeMatches(bots.Result[i].TradePartner, computedMatches.itemsToSend, computedMatches.itemsToReceive);
                addMatchRow(i);
            }
        }
        applyResultView();
        updateTradeStatus();
    }

    function fetchOwnBadgeWithRetry(badges, index, invalidIndices, cancelToken) {
        const generation = scanGeneration;
        return new Promise((resolve, reject) => {
            let localErrors = 0;
            let attempts = 0;
            function attempt() {
                if (stop || generation !== scanGeneration || cancelToken.cancelled) {
                    reject({type: 'stopped'});
                    return;
                }
                updateProgress('badges');

                let url = "https://steamcommunity.com/" + myProfileLink + "/ajaxgetbadgeinfo/" + badges[index].appId;
                let xhr = new XMLHttpRequest();
                xhr.open("GET", url, true);
                xhr.responseType = "json";
                xhr.timeout = 30000;
                // eslint-disable-next-line
                xhr.onload = function () {
                    if (stop || generation !== scanGeneration || cancelToken.cancelled) {
                        reject({type: 'stopped'});
                        return;
                    }
                    let status = xhr.status;
                    if (status === 200) {
                        try {
                            if (Object.keys(xhr.response).length === 1) {
                                // invalid badge
                                invalidIndices.add(index);
                                progressRadials.badges.currentStep--;
                                resolve();
                                return;
                            }
                            if (xhr.response != undefined && xhr.response.eresult == 1) {
                                if (xhr.response.badgedata.rgCards.length >= 5) {
                                    recordRequestSuccess();
                                    badges[index].maxCards = xhr.response.badgedata.rgCards.length;
                                    for (let i = 0; i < badges[index].maxCards; i++) {
                                        let newcard = {
                                            item: xhr.response.badgedata.rgCards[i].title,
                                            hash: xhr.response.badgedata.rgCards[i].markethash,
                                            count: xhr.response.badgedata.rgCards[i].owned,
                                            iconUrl: xhr.response.badgedata.rgCards[i].imgurl,
                                            number: i,
                                        };
                                        badges[index].cards.push(newcard);
                                        cardNames.add(xhr.response.badgedata.rgCards[i].markethash);
                                    }
                                    resolve();
                                    return;
                                } else {
                                    localErrors++;
                                }
                            } else {
                                reject(requestFailure(url, "Your badge inventory", {status, event: "load"}, attempts));
                                return;
                            }
                        } catch (error) {
                            localErrors++;
                        }
                    } else {
                        localErrors++;
                    }
                    recordRequestError();
                    if ((status < 400 || status === 408 || status === 429 || status >= 500) && localErrors <= boundedRetryLimit(globalSettings.maxErrors)) {
                        setTimeout(attempt, globalSettings.weblimiter + globalSettings.errorLimiter * localErrors);
                    } else {
                        reject(requestFailure(url, "Your badge inventory", {status, event: "load"}, attempts));
                    }
                };
                // eslint-disable-next-line
                xhr.onerror = function (event) {
                    if (stop || generation !== scanGeneration || cancelToken.cancelled) {
                        reject({type: 'stopped'});
                        return;
                    }
                    localErrors++;
                    recordRequestError();
                    if (localErrors <= boundedRetryLimit(globalSettings.maxErrors)) {
                        setTimeout(attempt, globalSettings.weblimiter + globalSettings.errorLimiter * localErrors);
                    } else {
                        reject(requestFailure(url, "Your badge inventory", {status: xhr.status, event: event === "timeout" ? "timeout" : "network"}, attempts));
                    }
                };
                xhr.ontimeout = () => xhr.onerror("timeout");
                sendPacedSteamRequest(xhr, generation, reject, () => !cancelToken.cancelled, () => attempts++);
            }
            attempt();
        });
    }

    function GetOwnCards(index, generation = scanGeneration) {
        const cacheGeneration = inventoryCacheGeneration;
        if (stop || generation !== scanGeneration) {
            return;
        }

        if (index === 0) {
            ownInventorySnapshotTime = 0;
            for (let i = 0; i < myBadges.length; i++) {
                myBadges[i].cards.length = 0;
            }
            progressRadials.badges.steps = myBadges.length;
            const cacheMeta = buildInventoryCacheMeta("self", myProfileLink, "self", myBadges);
            const cacheKey = buildInventoryCacheKey(cacheMeta.entryType, cacheMeta.profileId, cacheMeta.sourceType, cacheMeta.scopeKey);
            const cachedInventory = getInventoryCacheEntry(cacheKey, cacheMeta);
            if (cachedInventory !== null) {
                if (cachedInventory.stale) {
                    refreshOwnInventoryCacheEntry(cacheKey, cacheMeta, myBadges);
                }
                myBadges = cachedInventory.badges;
                ownInventorySnapshotTime = cachedInventory.snapshotTime;
                rememberCardNames(myBadges);
                markProgressComplete('badges');
                finalizeOwnInventoryAfterLoad();
                return;
            }

            const badges = myBadges;
            const snapshotTime = Date.now();
            const invalidIndices = new Set();
            runIndexedWorkerPool(badges.length, getScanConcurrency(), (i, cancelToken) => fetchOwnBadgeWithRetry(badges, i, invalidIndices, cancelToken))
                .then(() => {
                    if (stop || generation !== scanGeneration) {
                        return;
                    }
                    Array.from(invalidIndices).sort((a, b) => b - a).forEach((invalidIndex) => {
                        badges.splice(invalidIndex, 1);
                    });
                    const finalCacheMeta = buildInventoryCacheMeta("self", myProfileLink, "self", badges);
                    if (cacheGeneration === inventoryCacheGeneration) {
                        setInventoryCacheEntry(buildInventoryCacheKey(finalCacheMeta.entryType, finalCacheMeta.profileId, finalCacheMeta.sourceType, finalCacheMeta.scopeKey), {
                            entryType: finalCacheMeta.entryType,
                            sourceType: finalCacheMeta.sourceType,
                            profileId: finalCacheMeta.profileId,
                            scopeKey: finalCacheMeta.scopeKey,
                            appIds: finalCacheMeta.appIds,
                            badges: badges,
                            snapshotTime,
                        });
                    }
                    ownInventorySnapshotTime = snapshotTime;
                    finalizeOwnInventoryAfterLoad();
                })
                .catch((error) => {
                    if (generation !== scanGeneration) {
                        return;
                    }
                    if (stop || error?.type === 'stopped') {
                        stopEventCleanup('User interrupt');
                        return;
                    }
                    showScanDiagnostic(error);
                    stopEventCleanup(error?.message ?? 'Error getting badge data');
                });
        }
    }

    function fetchTargetBadgeWithRetry(badges, index, target, idLinkRef, cancelToken) {
        const generation = scanGeneration;
        const ownBadge = myBadges.find(badge => Number(badge.appId) === Number(badges[index].appId));
        const ownCardsByNumber = new Map((ownBadge?.cards || []).map(card => [card.number, card.hash]));
        return new Promise((resolve, reject) => {
            let localErrors = 0;
            let attempts = 0;
            function attempt() {
                if (stop || generation !== scanGeneration || cancelToken.cancelled) {
                    reject({type: 'stopped'});
                    return;
                }
                let profileLink = getTargetProfileLink(target);
                updateProgress('botBadges');

                let url = `https://steamcommunity.com/${idLinkRef.value ?? profileLink}/gamecards/${badges[index].appId}`;
                let xhr = new XMLHttpRequest();
                xhr.open("GET", url, true);
                xhr.responseType = "document";
                xhr.timeout = 30000;
                // eslint-disable-next-line
                xhr.onload = function () {
                    if (stop || generation !== scanGeneration || cancelToken.cancelled) {
                        reject({type: 'stopped'});
                        return;
                    }
                    let status = xhr.status;
                    if (status === 200) {
                        if (null === xhr.response.documentElement.querySelector(".badge_card_set_cards")) {
                            reject({...requestFailure(url, "Target badge inventory", {status, event: "load"}, attempts),
                                type: "private", message: `Target badge inventory: ${new URL(url).pathname} — HTTP 200, ${attempts} attempt(s); cards unavailable/private. Check inventory privacy.`});
                            return;
                        }
                        let badgeCards = xhr.response.documentElement.querySelectorAll(".badge_card_set_card");
                        if (badgeCards.length >= 5) {
                            recordRequestSuccess();
                            badges[index].maxCards = badgeCards.length;
                            for (let i = 0; i < badgeCards.length; i++) {
                                let quantityElement = badgeCards[i].querySelector(".badge_card_set_text_qty");
                                let quantity = quantityElement === null ? "(0)" : quantityElement.innerText.trim();
                                quantity = quantity.slice(1, -1);
                                let name = "";
                                badgeCards[i].querySelector(".badge_card_set_title").childNodes.forEach(function (element) {
                                    if (element.nodeType === Node.TEXT_NODE) {
                                        name = name + element.textContent;
                                    }
                                });
                                name = name.trim();
                                let markethash = ownCardsByNumber.get(i);
                                if (!markethash) {
                                    reject({type: 'fatal', message: `Missing card template for ${badges[index].appId}`});
                                    return;
                                }
                                let icon = badgeCards[i].querySelector(".gamecard").src.trim();
                                let newcard = {
                                    item: name,
                                    hash: markethash,
                                    count: Number(quantity),
                                    iconUrl: icon,
                                    number: i,
                                };
                                badges[index].cards.push(newcard);
                            }

                            if (idLinkRef.value === undefined) {
                                idLinkRef.value = xhr.responseURL.match(/(id\/.+?)\//)?.[1];
                            }

                            resolve();
                            return;
                        } else {
                            // private inventory?
                            localErrors++;
                        }
                    } else {
                        localErrors++;
                    }
                    recordRequestError();
                    if ((status < 400 || status === 408 || status === 429 || status >= 500) && localErrors <= boundedRetryLimit(globalSettings.maxErrors)) {
                        setTimeout(attempt, globalSettings.weblimiter + globalSettings.errorLimiter * localErrors);
                    } else {
                        reject(requestFailure(url, "Target badge inventory", {status, event: "load"}, attempts));
                    }
                };
                // eslint-disable-next-line
                xhr.onerror = function (event) {
                    if (stop || generation !== scanGeneration || cancelToken.cancelled) {
                        reject({type: 'stopped'});
                        return;
                    }
                    localErrors++;
                    recordRequestError();
                    if (localErrors <= boundedRetryLimit(globalSettings.maxErrors)) {
                        setTimeout(attempt, globalSettings.weblimiter + globalSettings.errorLimiter * localErrors);
                    } else {
                        reject(requestFailure(url, "Target badge inventory", {status: xhr.status, event: event === "timeout" ? "timeout" : "network"}, attempts));
                    }
                };
                xhr.ontimeout = () => xhr.onerror("timeout");
                sendPacedSteamRequest(xhr, generation, reject, () => !cancelToken.cancelled, () => attempts++);
            }
            attempt();
        });
    }

    function scanTargetBadges(userindex) {
        const generation = scanGeneration;
        const cacheGeneration = inventoryCacheGeneration;
        const target = bots.Result[userindex];
        const badges = botBadges;
        const snapshotTime = Date.now();
        const idLinkRef = {value: undefined};
        runIndexedWorkerPool(badges.length, getScanConcurrency(), (i, cancelToken) => fetchTargetBadgeWithRetry(badges, i, target, idLinkRef, cancelToken))
            .then(() => {
                if (stop || generation !== scanGeneration) {
                    return;
                }
                const cacheMeta = buildInventoryCacheMeta("target", target.SteamID, getTargetInventorySourceType(target), badges);
                if (cacheGeneration === inventoryCacheGeneration) {
                    setInventoryCacheEntry(buildInventoryCacheKey(cacheMeta.entryType, cacheMeta.profileId, cacheMeta.sourceType, cacheMeta.scopeKey), {
                        entryType: cacheMeta.entryType,
                        sourceType: cacheMeta.sourceType,
                        profileId: cacheMeta.profileId,
                        scopeKey: cacheMeta.scopeKey,
                        appIds: cacheMeta.appIds,
                        badges: badges,
                        snapshotTime,
                    });
                }
                target.InventorySnapshotTime = snapshotTime;
                setTargetInventoryStatus(target, "badge counts");
                finalizeTargetInventoryAfterLoad(userindex);
            })
            .catch((error) => {
                if (generation !== scanGeneration) {
                    return;
                }
                if (stop || error?.type === 'stopped') {
                    stopEventCleanup('User interrupt');
                    return;
                }
                if (error?.type === 'private' || error?.type === 'fatal' || error?.type === 'failed') {
                    updateProgress('bots');
                    setTargetInventoryStatus(target, error.type === "private" ? "private/unavailable" : "failed");
                    showScanDiagnostic(error);
                    setTimeout(
                        (function (userindex) {
                            return function () {
                                if (!stop && generation === scanGeneration) {
                                    GetCards(0, userindex);
                                }
                            };
                        })(userindex + 1),
                        globalSettings.weblimiter,
                    );
                    return;
                }
                stopEventCleanup(error?.message ?? 'Error getting badge data');
            });
    }

    function GetCards(index, userindex) {
        if (stop) {
            return;
        }

        if (index === 0 && userindex === 0) {
            progressRadials.botBadges.steps = myBadges.length;
        }

        if (userindex >= bots.Result.length) {
            markProgressComplete("bots");
            const partial = bots.partialFailure || groupDiscoveryReports.some(report => report.status !== "complete") ||
                Object.keys(inventoryScanStatuses).some(status => /failed|private|stale/.test(status));
            stopEventCleanup(partial ? "Scan finished (partial or stale results)" : "Scan completed");
            return;
        }

        const target = bots.Result[userindex];
        const isAsfTarget = target.SourceTypes.includes('asf') && !target.SourceTypes.includes("groups");
        if (
            (isAsfTarget && target.MatchEverything && !globalSettings.anyBots) ||
            (isAsfTarget && !target.MatchEverything && !globalSettings.fairBots) ||
            (isAsfTarget && target.TotalInventoryCount < globalSettings.botMinItems) ||
            (isAsfTarget && globalSettings.botMaxItems > 0 && target.TotalInventoryCount > globalSettings.botMaxItems) ||
            blacklist.includes(target.SteamID) || blacklist.includes(String(target.SteamID64)) || (ownSteamID64 && getPartner(ownSteamID64) === target.TradePartner)
        ) {
            updateProgress('bots');
            updateProgress('botBadges');
            GetCards(0, userindex + 1);
            return;
        }
        // scan bot badge step
        if (index === 0) {
            botBadges.length = 0;
            botBadges = deepClone(myBadges);
            for (let i = 0; i < botBadges.length; i++) {
                botBadges[i].cards.length = 0;
            }
            progressRadials.botBadges.currentStep = 0;
            updateProgress('bots');
            const cacheMeta = buildInventoryCacheMeta("target", target.SteamID, getTargetInventorySourceType(target), botBadges);
            const cacheKey = buildInventoryCacheKey(cacheMeta.entryType, cacheMeta.profileId, cacheMeta.sourceType, cacheMeta.scopeKey);
            const cachedInventory = getInventoryCacheEntry(cacheKey, cacheMeta);
            if (cachedInventory !== null) {
                if (cachedInventory.stale) {
                    refreshTargetInventoryCacheEntry(cacheKey, cacheMeta, target, botBadges);
                }
                botBadges = cachedInventory.badges;
                target.InventorySnapshotTime = cachedInventory.snapshotTime;
                setTargetInventoryStatus(target, cachedInventory.stale ? "stale badge counts (refresh queued)" : "cached badge counts");
                markProgressComplete('botBadges');
                finalizeTargetInventoryAfterLoad(userindex);
                return;
            }
        }

        if (index < botBadges.length) {
            scanTargetBadges(userindex);
            return;
        }

        const cacheMeta = buildInventoryCacheMeta("target", target.SteamID, getTargetInventorySourceType(target), botBadges);
        setInventoryCacheEntry(buildInventoryCacheKey(cacheMeta.entryType, cacheMeta.profileId, cacheMeta.sourceType, cacheMeta.scopeKey), {
            entryType: cacheMeta.entryType,
            sourceType: cacheMeta.sourceType,
            profileId: cacheMeta.profileId,
            scopeKey: cacheMeta.scopeKey,
            appIds: cacheMeta.appIds,
            badges: botBadges,
        });
        finalizeTargetInventoryAfterLoad(userindex);
    }

    function getBadges(page, generation = scanGeneration) {
        if (stop || generation !== scanGeneration) {
            return;
        }
        const activeScanFilters = globalSettings.scanFilters.filter(x => x.active);
        if (globalSettings.useScanFilters && activeScanFilters.length) {
            for (let filter of activeScanFilters) {
                let badgeStub = {
                    appId: filter.appId,
                    title: filter.title,
                    maxCards: 0,
                    maxSets: 0,
                    lastSet: 0,
                    cards: [],
                };
                myBadges.push(badgeStub);
            }
            progressRadials.scanPages.steps = 1;
            progressRadials.scanPages.radialElement.classList.add('full-blue');
            updateProgress('scanPages');
            setTimeout(
                function () {
                    GetOwnCards(0, generation);
                },
                globalSettings.weblimiter + globalSettings.errorLimiter * errors,
            );
            return;
        }
        let url = "https://steamcommunity.com/" + myProfileLink + "/badges?p=" + page;
        let xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "document";
        xhr.timeout = 30000;
        xhr.onload = function () {
            if (generation !== scanGeneration) {
                return;
            }
            if (stop) {
                stopEventCleanup('User interrupt');
                return;
            }
            let status = xhr.status;
            if (status === 200) {
                errors = 0;
                if (page === 1) {
                    let pageLinks = xhr.response.documentElement.getElementsByClassName("pagelink");
                    if (pageLinks.length > 0) {
                        maxPages = Number(pageLinks[pageLinks.length - 1].textContent.trim());
                    }
                    progressRadials.scanPages.steps = maxPages;
                }
                updateProgress('scanPages');
                let badges = xhr.response.documentElement.getElementsByClassName("badge_row_inner");
                for (let i = 0; i < badges.length; i++) {
                    if (badges[i].getElementsByClassName("owned").length > 0) {
                        //we only need badges where we have at least one card, and no special badges
                        if (!badges[i].parentElement.querySelector(".badge_row_overlay").href.endsWith("border=1")) {
                            //ignore foil badges completely for now. TODO: match foils too.
                            let appidNodes = badges[i].getElementsByClassName("card_drop_info_dialog");
                            if (appidNodes.length > 0) {
                                let appidText = appidNodes[0].getAttribute("id");
                                let appidSplitted = appidText.split("_");
                                if (appidSplitted.length >= 5) {
                                    let appId = Number(appidSplitted[4]);
                                    let title = badges[i].querySelector(".badge_title").childNodes[0].textContent.trim();
                                    let badgeStub = {
                                        appId: appId,
                                        title: title,
                                        maxCards: 0,
                                        maxSets: 0,
                                        lastSet: 0,
                                        cards: [],
                                    };
                                    myBadges.push(badgeStub);
                                }
                            }
                        }
                    }
                }
                page++;
            } else {
                errors++;
            }
            if ((status < 400 || status === 408 || status === 429 || status >= 500) && errors <= boundedRetryLimit(globalSettings.maxErrors)) {
                if (page <= maxPages) {
                    setTimeout(
                        (function (page) {
                            return function () {
                                getBadges(page, generation);
                            };
                        })(page),
                        globalSettings.weblimiter + globalSettings.errorLimiter * errors,
                    );
                } else {
                    if (myBadges.length === 0) {
                        stopEventCleanup('No badges to match');
                        return;
                    } else {
                        setTimeout(
                            function () {
                                GetOwnCards(0, generation);
                            },
                            globalSettings.weblimiter + globalSettings.errorLimiter * errors,
                        );
                    }
                }
            } else {
                showScanDiagnostic(requestFailure(url, "Your badge pages", {status, event: "load"}, errors));
                stopEventCleanup('Your badge pages unavailable; scan stopped');
                return;
            }
        };
        xhr.onerror = function (event) {
            if (generation !== scanGeneration) {
                return;
            }
            if (stop) {
                stopEventCleanup('User interrupt');
                return;
            }
            errors++;
            if (errors <= boundedRetryLimit(globalSettings.maxErrors)) {
                setTimeout(
                    (function (page) {
                        return function () {
                            getBadges(page, generation);
                        };
                    })(page),
                    globalSettings.weblimiter + globalSettings.errorLimiter * errors,
                );
            } else {
                showScanDiagnostic(requestFailure(url, "Your badge pages", {status: xhr.status, event: event === "timeout" ? "timeout" : "network"}, errors));
                stopEventCleanup('Your badge pages unavailable; scan stopped');
                return;
            }
        };
        xhr.ontimeout = () => xhr.onerror("timeout");
        sendPacedSteamRequest(xhr, generation, () => {});
    }

    function addScanFilterEventHandler() {
        const appIdBox = document.querySelector('#addScanFilterAppId');
        const appId = appIdBox.value;
        const response = AddScanFilter(appId);
        updateScanFilterAppName(appId);
        const statusElement = document.querySelector('#addScanFilterStatus');
        statusElement.style.transition = null;
        statusElement.style.opacity = 1;
        statusElement.innerText = response.message;
        if (response.success) {
            const newScanFilter = createScanFilterElement(true, appId, appId);
            const filtersElement = document.querySelector('#asf-stm-filters');
            const template = document.createElement("template");
            template.innerHTML = newScanFilter;
            filtersElement.appendChild(template.content.firstChild);
            statusElement.style.color = '#88ff88';
        } else {
            statusElement.style.color = '#ffa7a2';
        }
        appIdBox.value = null;
        setTimeout(function() {
            statusElement.style.transition = "opacity 3s ease-out";
            statusElement.style.opacity = 0;
        }, 0);
    }

    function updateScanFilterAppName(appId) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://steamcommunity.com/${myProfileLink}/gamecards/${appId}`,
                onload: (response) => {
                    try {
                        const selector = response.responseText.split('profile_small_header_location">')[2];
                        if (!selector) {
                            const element = document.querySelector(`#scan-filter-${appId}`);
                            if (element) {
                                element.remove();
                            }
                            globalSettings.scanFilters = globalSettings.scanFilters.filter(x => x.appId !== Number(appId));
                            resolve(`Invalid appId: ${appId}`);
                            return;
                        }
                        const title = selector.split('</span')[0];
                        const scanFilter = globalSettings.scanFilters.find(x => x.appId == appId);
                        if (scanFilter) {
                            scanFilter.title = title;
                        }
                        const anchor = document.querySelector(`#scan-filter-name-${appId}`);
                        if (anchor) {
                            [...anchor.childNodes].find(x => x.nodeType === Node.TEXT_NODE).nodeValue = title;
                        }
                        resolve(title);
                    } catch (error) {reject(error);}
                },
                onerror: (error) => {reject(error);},
                ontimeout: (error) => {reject(error);}
            });
        });
    }

    function clearScanFiltersEventHandler() {
        unsafeWindow.ShowConfirmDialog("CONFIRMATION", "Are you sure you want to clear all scan filters?").done(function () {
            ResetScanFilters();
            SaveConfig();
        });
    }

    function filterEventHandler(event) {
        let appId = event.target.id.split("_")[1];
        let matches = document.getElementsByClassName("asf_stm_appid_" + appId);
        for (let i = 0; i < matches.length; i++) {
            if (event.target.checked) {
                matches[i].style.display = "inline-block";
                if (!tradeParams.filter.includes(Number(appId))) {
                    tradeParams.filter.push(Number(appId));
                }
            } else {
                matches[i].style.display = "none";
                let index = tradeParams.filter.indexOf(Number(appId));
                if (index !== -1) {
                    tradeParams.filter.splice(index, 1);
                }
            }
            checkRow(matches[i].parentElement.parentElement);
        }
        SaveParams();
    }

    function filterSwitchesHandler(event) {
        let action = event.target.id.split("_")[3];
        let filterWidget = document.getElementById("asf_stm_filters_body");
        let checkboxes = filterWidget.getElementsByTagName("input");
        for (let i = 0; i < checkboxes.length; i++) {
            if (action === "all") {
                if (!checkboxes[i].checked) {
                    checkboxes[i].checked = true;
                    filterEventHandler({ target: checkboxes[i] });
                }
            } else if (action === "none") {
                if (checkboxes[i].checked) {
                    checkboxes[i].checked = false;
                    filterEventHandler({ target: checkboxes[i] });
                }
            } else if (action === "invert") {
                checkboxes[i].checked = !checkboxes[i].checked;
                filterEventHandler({ target: checkboxes[i] });
            }
        }
    }

    function filtersButtonEvent() {
        let filterWidget = document.getElementById("asf_stm_filters");
        if (filterWidget.style.marginRight === "-50%") {
            filterWidget.style.marginRight = "unset";
        } else {
            filterWidget.style.marginRight = "-50%";
        }
    }

    function stopButtonEvent() {
        document.querySelector('#asf_stm_stop_div').hidden = true;
        stop = true;
        scanGeneration++;
        activeScanRequests.forEach(xhr => xhr.abort());
        activeScanRequests.clear();
        inventoryRefreshQueue.length = 0;
        Object.values(progressRadials).forEach(x => {if (x.textElement) x.textElement.textContent = '❌'});
        stopEventCleanup("User interrupt; discovery/results may be partial");
    }

    function stopEventCleanup(reason) {
        // Hide throbber
        const throbber = document.querySelector('#throbber');
        if (throbber) {
            throbber.style.display = 'none';
        }
        enableButton();
        document.querySelector('#asf_stm_stop_div').hidden = true;
        if (cacheBypassActive) {
            if (globalSettings.forceFreshScan) {
                globalSettings.forceFreshScan = false;
                SaveConfig();
            }
            cacheBypassActive = false;
            cacheStats.mode = isInventoryCacheEnabled() ? "enabled" : "disabled";
            updateCacheStatus();
        }
        console.log(`Stopping: ${sanitizeDiagnostic(reason)}`);
        showDiscoveryProgress(reason);
    }

    function buttonPressedEvent(targetsReady = false) {
        if (targetsReady !== true) {
            scanGeneration++;
            stop = false;
            groupDiscoveryReports = [];
            inventoryScanStatuses = {};
            inventoryRefreshQueue.length = 0;
            errors = 0;
            scanStatus = {progress: "", warning: "", diagnostic: ""};
            resetAdaptiveRequestDelay();
            renderScanStatus();
        }
        if (globalSettings.preventClose) {
            window.addEventListener('beforeunload', function (e) {
                e.preventDefault();
            });
        }
        const enabledSources = getEnabledSources();
        if (!enabledSources.scanBots && !enabledSources.scanFriends && !enabledSources.scanGroups && whitelist.length === 0) {
            enableButton();
            return;
        }
        cacheBypassActive = globalSettings.forceFreshScan === true;
        resetCacheStats();
        if (targetsReady === true || isCacheValid(bots, enabledSources)) {
            scanStatus.warning = sourceWarning(bots);
            renderScanStatus();
        }
        if (targetsReady !== true && (cacheBypassActive || !isCacheValid(bots, enabledSources) || bots.Result === undefined || bots.Success !== true)) {
            disableButton();
            document.querySelector('#asf_stm_stop_div').hidden = false;
            fetchBots();
            return;
        }
        if (bots.Result.length === 0) {
            groupDiscoveryReports = bots.groupReports || [];
            stopEventCleanup(bots.partialFailure ? "No eligible targets; discovery was partial" : "No eligible targets");
            return;
        }
        bots.Result.sort(botSorter);
        bots.Result.forEach(target => {
            delete target.badgesSnapshot;
            delete target.itemsToSend;
            delete target.itemsToReceive;
            delete target.CountedInventoryStatus;
            delete target.InventorySnapshotTime;
            target.InventoryStatus = "not scanned";
        });
        groupDiscoveryReports = bots.groupReports || [];
        disableButton();
        let mainContentDiv = document.getElementsByClassName("maincontent")[0];
        mainContentDiv.textContent = "";
        mainContentDiv.style.width = "90%";
        const partialSourceWarning = "";
        mainContentDiv.innerHTML = `<div class="profile_badges_header"><div id="throbber"><div class="LoadingWrapper"><div class="LoadingThrobber"><div class="Bar Bar1"></div><div class="Bar Bar2"></div><div class="Bar Bar3"></div></div></div></div><div style="display: flex;flex-direction: column;align-items: center;">${partialSourceWarning}<div class="progress-container"><div class="progress-step"><div id="scan-pages-radial" class="radial-progress" style="--progress: 0deg;"><div id="scan-pages-text" class="progress-inner">?</div></div><span id="scan-pages-label" class="label">${globalSettings.useScanFilters && globalSettings.scanFilters.filter(x => x.active).length ? 'Filters' : 'Badge Pages'}</span></div><div class="progress-step"><div id="scan-badges-radial" class="radial-progress" style="--progress: 0deg;"><div id="scan-badges-text" class="progress-inner">?</div></div><span id="scan-badges-label" class="label">Badges</span></div><div class="progress-step"><div id="scan-bots-radial" class="radial-progress" style="--progress: 0deg;"><div id="scan-bots-text" class="progress-inner">?</div></div><span id="scan-bots-label" class="label">Targets</span></div><div class="progress-step"><div id="bots-badges-radial" class="radial-progress" style="--progress: 0deg;"><div id="bots-badges-text" class="progress-inner">?</div></div><span id="bots-badges-label" class="label">Target Badges</span></div></div></div></div><div id="asf_stm_results_summary" style="margin:1rem 0 0.75rem;text-align:center;color:#c7d5e0;"></div><div id="asf_stm_results_controls" style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;justify-content:center;margin-bottom:1rem;"><span style="color:#8F98A0;">Show:</span><a href="#" data-result-filter="all" class="commentthread_pagelinks" style="padding:0.2rem 0.6rem;border:1px solid #4a83fd55;border-radius:999px;">All</a><a href="#" data-result-filter="asf" class="commentthread_pagelinks" style="padding:0.2rem 0.6rem;border:1px solid #4a83fd55;border-radius:999px;">ASF only</a><a href="#" data-result-filter="friends" class="commentthread_pagelinks" style="padding:0.2rem 0.6rem;border:1px solid #4a83fd55;border-radius:999px;">Friends only</a><a href="#" data-result-filter="shared" class="commentthread_pagelinks" style="padding:0.2rem 0.6rem;border:1px solid #4a83fd55;border-radius:999px;">Shared</a><span style="color:#8F98A0;margin-left:0.5rem;">Order:</span><a href="#" data-result-grouping="combined" class="commentthread_pagelinks" style="padding:0.2rem 0.6rem;border:1px solid #4a83fd55;border-radius:999px;">Combined</a><a href="#" data-result-grouping="source" class="commentthread_pagelinks" style="padding:0.2rem 0.6rem;border:1px solid #4a83fd55;border-radius:999px;">By source</a><span style="color:#8F98A0;margin-left:0.5rem;">Trades:</span><a href="#" data-trade-action="refresh-completed" class="commentthread_pagelinks" style="padding:0.2rem 0.6rem;border:1px solid #4a83fd55;border-radius:999px;">Refresh completed</a><a href="#" data-trade-action="clear-tracked" class="commentthread_pagelinks" style="padding:0.2rem 0.6rem;border:1px solid #4a83fd55;border-radius:999px;">Clear tracked</a><span data-asf-stm-trade-status style="color:#8F98A0;margin-left:0.5rem;"></span></div><div id="asf_stm_results_body" style="display:flex;flex-direction:column;gap:0.75rem;"></div><div id="asf_stm_filters" style="position: fixed; z-index: 1000; right: 5px; bottom: 45px; transition-duration: 500ms; transition-timing-function: ease; margin-right: -50%; padding: 5px; max-width: 40%; display: inline-block; border-radius: 2px; background:rgba(23,26,33,0.8); color: #67c1f5;"><div style="white-space: nowrap;">Select:<a id="asf_stm_filter_all" class="commentthread_pagelinks">all</a><a id="asf_stm_filter_none" class="commentthread_pagelinks">none</a><a id="asf_stm_filter_invert" class="commentthread_pagelinks">invert</a></div><hr /><div id="asf_stm_filters_body"><span id="asf_stm_placeholder" style="margin-right: 15px;">No matches to filter</span></div></div><div style="position: fixed;z-index: 1000;right: 5px;bottom: 5px;" id="asf_stm_filters_button_div"><a id="asf_stm_filters_button" class="btnv6_blue_hoverfade btn_medium"><span>Filters</span></a></div>`;
        renderScanStatus();
        document.getElementById("asf_stm_filters").style.background = sanitizeFilterBackgroundColor(globalSettings.filterBackgroundColor);
        if (globalSettings.scanGroups) {
            const groupControl = document.createElement("a");
            groupControl.href = "#";
            groupControl.dataset.resultFilter = "groups";
            groupControl.className = "commentthread_pagelinks";
            groupControl.textContent = "Groups (including shared)";
            document.getElementById("asf_stm_results_controls").prepend(groupControl);
        }
        document.getElementById("asf_stm_filters_body").addEventListener("change", filterEventHandler);
        document.getElementById("asf_stm_filter_all").addEventListener("click", filterSwitchesHandler);
        document.getElementById("asf_stm_filter_none").addEventListener("click", filterSwitchesHandler);
        document.getElementById("asf_stm_filter_invert").addEventListener("click", filterSwitchesHandler);
        document.getElementById("asf_stm_filters_button").addEventListener("click", filtersButtonEvent, false);
        document.getElementById("asf_stm_results_controls").addEventListener("click", resultControlEventHandler);
        observer.observe(document.querySelector('#asf_stm_filters_body'), { attributes: true, childList: true, subtree: true });
        document.querySelector('#asf_stm_stop_div').hidden = false;
        resetRadials();
        maxPages = 1;
        stop = false;
        resetAdaptiveRequestDelay();
        myBadges.length = 0;
        cardNames = new Set();
        tradeParams = {
            matches: {},
            filter: [],
        };
        resultView = {
            sourceFilter: "all",
            grouping: "combined",
        };
        syncResultControlStates();
        updateResultSummary();
        updateTradeStatus();
        getBadges(1);
    }

    function resetRadials() {
        progressRadials = {
            scanPages: {
                currentStep: 0,
                steps: 0,
                radialElement: document.querySelector('#scan-pages-radial'),
                textElement: document.querySelector('#scan-pages-text'),
            },
            badges: {
                currentStep: 0,
                steps: 0,
                radialElement: document.querySelector('#scan-badges-radial'),
                textElement: document.querySelector('#scan-badges-text'),
            },
            bots: {
                currentStep: 0,
                steps: 0,
                radialElement: document.querySelector('#scan-bots-radial'),
                textElement: document.querySelector('#scan-bots-text'),
            },
            botBadges: {
                currentStep: 0,
                steps: 0,
                radialElement: document.querySelector('#bots-badges-radial'),
                textElement: document.querySelector('#bots-badges-text'),
            },
        };

        const radialElements = [...document.querySelectorAll('.radial-progress')];
        for (let radialElement of radialElements) {
            radialElement.classList.remove('full-blue');
            radialElement.style.setProperty('--progress', '0deg');
        }

        const textElements = [...document.querySelectorAll('.progress-inner')];
        for (let textElement of textElements) {
            textElement.textContent = '?';
        }
    }

    function botSorter(a, b) {
        let result = 0;
        for (let i = 0; i < globalSettings.sortBotsBy.length; i++) {
            switch (globalSettings.sortBotsBy[i]) {
                case "MatchEverythingFirst":
                    result = (b.MatchEverything ? 1 : 0) - (a.MatchEverything ? 1 : 0);
                    break;
                case "MatchEverythingLast":
                    result = (a.MatchEverything ? 1 : 0) - (b.MatchEverything ? 1 : 0);
                    break;
                case "TotalGamesCountDesc":
                    result = (b.TotalGamesCount ?? 0) - (a.TotalGamesCount ?? 0);
                    break;
                case "TotalGamesCountAsc":
                    result = (a.TotalGamesCount ?? 0) - (b.TotalGamesCount ?? 0);
                    break;
                case "TotalItemsCountDesc":
                    result = (b.TotalItemsCount ?? 0) - (a.TotalItemsCount ?? 0);
                    break;
                case "TotalItemsCountAsc":
                    result = (a.TotalItemsCount ?? 0) - (b.TotalItemsCount ?? 0);
                    break;
                case "TotalInventoryCountDesc":
                    result = (b.TotalInventoryCount ?? 0) - (a.TotalInventoryCount ?? 0);
                    break;
                case "TotalInventoryCountAsc":
                    result = (a.TotalInventoryCount ?? 0) - (b.TotalInventoryCount ?? 0);
                    break;
                default:
                    result = 0;
            }
            if (result !== 0) {
                break;
            }
        }
        if (result !== 0) {
            return result;
        }
        return a.Nickname.localeCompare(b.Nickname);
    }

    function fetchBots() {
        const generation = scanGeneration;
        const enabledSources = getEnabledSources();

        async function fetchAsfTargets() {
            const body = await requestSource("https://asf.justarchi.net/Api/Listing/Bots", "ASF discovery", generation);
            assertCurrentScan(generation);
            let re = /("SteamID":)(\d+)/g;
            let parsed;
            try {
                parsed = JSON.parse(String(body).replace(re, '$1"$2"'));
            } catch (_) {
                throw new Error("ASF returned an invalid listing response (HTTP 200)");
            }
            if (!parsed.Success || !Array.isArray(parsed.Result)) {
                throw new Error("ASF backend did not return a successful listing (HTTP 200)");
            }
            return parsed.Result.filter(bot => (bot.MatchableTypes ?? []).includes(5)).map(normalizeBot);
        }

        async function fetchFriendTargets() {
            const body = await requestSource("https://steamcommunity.com/actions/PlayerList/?type=friends", "Friends discovery", generation);
            assertCurrentScan(generation);
            const parser = new DOMParser();
            const friendListDocument = parser.parseFromString(body, 'text/html');
            // A login/private/error page must not be cached as a successful empty friend list.
            if (!friendListDocument.querySelector("div.friendBlock, #search_results, #friends_list, .friends_content") ||
                friendListDocument.querySelector("#loginForm, .profile_private_info, .error_ctn")) {
                throw new Error("Friends list unavailable or unexpected page (HTTP 200); check Steam sign-in/privacy");
            }
            let accountIDs = Array.from(friendListDocument.querySelectorAll('div.friendBlock'), x => x.dataset.miniprofile);
            let profile = Array.from(friendListDocument.querySelectorAll('a.friendBlockLinkOverlay'), x => x.href.replace(/https:\/\/steamcommunity.com\//g, ''));
            let avatarHash = Array.from(friendListDocument.querySelectorAll('div.friendBlock img'), img => img.src).map(str => str.match(/[a-z0-9]{40}/)?.[0] ?? null);
            let nickname = Array.from(friendListDocument.querySelectorAll('div.friendBlockContent'), x => x.childNodes[0]?.data?.trim() ?? 'Unknown friend');
            return profile.map((profileLink, index) => normalizeFriend(profileLink, avatarHash[index], nickname[index], accountIDs[index]));
        }

        let fetchers = [];
        if (enabledSources.scanBots) {
            fetchers.push({name: "ASF", promise: fetchAsfTargets()});
        }
        if (enabledSources.scanFriends) {
            fetchers.push({name: "Friends", promise: fetchFriendTargets()});
        }
        if (enabledSources.scanGroups) {
            fetchers.push({name: "Groups", promise: discoverGroupTargets(generation)});
        }
        if (fetchers.length === 0 && whitelist.length === 0) {
            enableButton();
            document.getElementById("asf_stm_button_div").setAttribute("title", "Enable at least one source");
            return;
        }

        showDiscoveryProgress("Discovering enabled scan sources…");
        Promise.allSettled(fetchers.map(fetcher => fetcher.promise)).then((results) => {
            if (stop || generation !== scanGeneration) {
                return;
            }
            const successfulResults = results.filter(result => result.status === "fulfilled").map(result => result.value);
            const successfulSource = results.some((result, index) => result.status === "fulfilled" &&
                (fetchers[index].name !== "Groups" || result.value.length > 0 ||
                    groupDiscoveryReports.some(report => report.status === "complete")));
            const sourceReports = results.map((result, index) => ({
                name: fetchers[index].name,
                status: result.status !== "fulfilled" ? "failed" :
                    fetchers[index].name === "Groups" && groupDiscoveryReports.some(report => report.status !== "complete") ?
                        groupDiscoveryReports.every(report => report.status === "complete" || report.kind === "limit") ? "limited" : "partial" : "complete",
                detail: result.status === "fulfilled" ? "" : sanitizeDiagnostic(result.reason?.message || "Request failed; no HTTP status available"),
                diagnostic: result.reason?.path ? {
                    stage: result.reason.stage, path: result.reason.path, status: result.reason.status,
                    event: result.reason.event, attempts: result.reason.attempts,
                } : undefined,
            }));
            const partialFailure = results.some(result => result.status !== "fulfilled") || groupDiscoveryReports.some(report => report.status !== "complete");
            bots = {
                Success: successfulSource || whitelist.length > 0,
                profileLink: myProfileLink,
                cacheTime: Date.now(),
                partialFailure: partialFailure,
                sourceReports,
                groupReports: deepClone(groupDiscoveryReports),
                sourceState: {...enabledSources, whitelist: whitelist.join(",")},
                Result: mergeTargets(successfulResults.concat([whitelist.map(normalizeWhitelistSteamID)])),
            };
            bots.Result.forEach(target => {
                const suppliedUrl = globalSettings.tradeUrls.find(value => parseTradeUrl(value).partner === target.TradePartner);
                if (suppliedUrl) {
                    target.TradeToken = parseTradeUrl(suppliedUrl, target.TradePartner).token;
                    target.TradeAccess = "token supplied (not verified)";
                } else if (target.SourceTypes.includes("friends")) {
                    target.TradeAccess = "friend (Steam checks eligibility)";
                } else if (target.SourceTypes.includes("asf") && target.TradeToken) {
                    target.TradeAccess = "ASF token (Steam checks eligibility)";
                } else {
                    target.TradeAccess = "unknown";
                }
            });
            try {
                localStorage.setItem(`${STORAGE_PREFIX}.BotCache`, JSON.stringify(bots));
            } catch (error) {
                console.warn("Failed to cache unified scan targets", error);
            }
            scanStatus.warning = sourceWarning(bots);
            renderScanStatus();
            if (!bots.Success) {
                stopEventCleanup("Failed to fetch enabled sources; no targets scanned");
                return;
            }
            buttonPressedEvent(true);
        });
    }
    //Main
    LoadConfig();
    if (document.getElementsByClassName("badge_details_set_favorite").length !== 0) {
        let profileRegex = /http[s]?:\/\/steamcommunity.com\/(.*)\/badges.*/g;
        let result = profileRegex.exec(document.location);
        if (result) {
            myProfileLink = result[1];
        } else {
            //should never happen, but whatever.
            myProfileLink = "my";
        }


        let botCache = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}.BotCache`));
        const enabledSources = getEnabledSources();
        if (!isCacheValid(botCache, enabledSources)) {
            botCache = null;
        } else {
            bots = botCache;
        }
        // Scan
        let buttonDiv = document.createElement("div");
        buttonDiv.setAttribute("class", "profile_small_header_additional");
        buttonDiv.setAttribute("style", "margin-top: 40px; right: 110px");
        buttonDiv.setAttribute("id", "asf_stm_button_div");
        buttonDiv.setAttribute("title", "Scan ASF STM");
        let button = document.createElement("a");
        button.setAttribute("class", "btnv6_blue_hoverfade btn_medium");
        button.setAttribute("id", "asf_stm_button");
        button.appendChild(document.createElement("span"));
        button.firstChild.appendChild(document.createTextNode("Scan ASF STM"));
        buttonDiv.appendChild(button);
        let anchor = document.getElementsByClassName("profile_small_header_texture")[0];
        anchor.appendChild(buttonDiv);
        // Config
        let confButtonDiv = document.createElement("div");
        confButtonDiv.setAttribute("class", "profile_small_header_additional");
        confButtonDiv.setAttribute("style", "margin-top: 40px; right: 70px");
        confButtonDiv.setAttribute("id", "asf_stm_config_div");
        confButtonDiv.setAttribute("title", "Configuration");
        let confButton = document.createElement("a");
        confButton.setAttribute("class", "btnv6_blue_hoverfade btn_medium_thin");
        confButton.setAttribute("id", "asf_stm_config");
        confButton.appendChild(document.createElement("span"));
        confButton.firstChild.appendChild(document.createTextNode("⚙️"));
        confButtonDiv.appendChild(confButton);
        anchor.appendChild(confButtonDiv);
        confButton.addEventListener("click", ShowConfigDialog, false);
        // Stop
        let stopButtonDiv = document.createElement("div");
        stopButtonDiv.setAttribute("class", "profile_small_header_additional");
        stopButtonDiv.setAttribute("style", "margin-top: 40px;");
        stopButtonDiv.setAttribute("id", "asf_stm_stop_div");
        stopButtonDiv.setAttribute("title", "Stop");
        stopButtonDiv.hidden = true;
        let stopButton = document.createElement("a");
        stopButton.setAttribute("class", "btn_darkred_white_innerfade btn_medium_thin");
        stopButton.appendChild(document.createElement("span"));
        stopButton.firstChild.appendChild(document.createTextNode("🛑"));
        stopButtonDiv.appendChild(stopButton);
        anchor.appendChild(stopButtonDiv);
        stopButton.addEventListener("click", stopButtonEvent, false);
        let cacheStatus = document.createElement("div");
        cacheStatus.setAttribute("data-asf-stm-cache-status", "true");
        cacheStatus.setAttribute("style", "margin-top: 76px; color: #8F98A0; font-size: 12px; text-align: right;");
        anchor.appendChild(cacheStatus);

        enableButton();
        updateCacheStatus();

        // add our styles to the document's style sheet
        if (typeof GM_addStyle !== "undefined") {
            GM_addStyle(css + configCss);
        } else {
            const node = document.createElement("style");
            node.appendChild(document.createTextNode(css + configCss));
            const heads = document.getElementsByTagName("head");
            if (heads.length > 0) {
                heads[0].appendChild(node);
            } else {
                // no head yet, stick it wherever
                document.documentElement.appendChild(node);
            }
        }
    } else {
        //Code below is a heavily modified version of SteamTrade Matcher Userscript by Tithen-Firion
        //Original can be found on https://github.com/Tithen-Firion/STM-UserScript

        // MIT License
        // Copyright (c) 2017 Tithen-Firion
        // Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
        // The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
        // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

        function getRandomInt(min, max) {
            "use strict";
            return Math.floor(Math.random() * (max - min)) + min;
        }

        function mySort(a, b) {
            "use strict";
            return parseInt(b.id) - parseInt(a.id);
        }

        ///// Steam functions /////

        function restoreCookie(oldCookie) {
            "use strict";
            if (oldCookie) {
                let now = new Date();
                let time = now.getTime();
                time += 15 * 24 * 60 * 60 * 1000;
                now.setTime(time);
                document.cookie = "strTradeLastInventoryContext=" + oldCookie + "; expires=" + now.toUTCString() + "; path=/tradeoffer/";
            }
        }

        function addCards(g_s, g_v) {
            "use strict";
            let tmpCards, inv, index, currentCards;
            let failLater = false;
            let cardTypes = [[], []];
            let trackedAssetIds = [[], []];
            if (document.querySelectorAll("#your_slots .has_item, #their_slots .has_item").length > 0) {
                unsafeWindow.ShowAlertDialog("Offer already contains items", "Start with an empty offer before preparing this match. Nothing was added.");
                throw new Error("Offer not empty");
            }
            if (!isUserSteamID64(g_v.Users[1]?.strSteamId) || getPartner(g_v.Users[1].strSteamId) !== g_v.tradeTrackingContext.partner) {
                unsafeWindow.ShowAlertDialog("Partner mismatch", "The loaded inventory owner does not match the requested Steam partner. Nothing was added.");
                throw new Error("Loaded partner mismatch");
            }
            const selections = g_v.Cards.map((requestedCards, i) => {
                const inventory = g_v.Users[i].rgContexts[753][6].inventory;
                inventory.BuildInventoryDisplayElements();
                const available = new Map();
                const seenIds = new Set();
                Object.values(inventory.rgInventory || {}).forEach(item => {
                    if (!isTradableItem(item) || !isNormalCard(item) || (item.amount !== undefined && Number(item.amount) !== 1) ||
                        !/^\d+$/.test(String(item.id)) || seenIds.has(String(item.id)) || !item.element) {
                        return;
                    }
                    seenIds.add(String(item.id));
                    if (!available.has(item.market_hash_name)) {
                        available.set(item.market_hash_name, []);
                    }
                    available.get(item.market_hash_name).push(item);
                });
                const needed = new Map();
                requestedCards.forEach(hash => needed.set(hash, (needed.get(hash) || 0) + 1));
                if (Array.from(needed).some(([hash, count]) => (available.get(hash)?.length || 0) < count)) {
                    unsafeWindow.ShowAlertDialog("Tradable cards missing", "Live inventories do not contain enough tradable normal cards. Refresh your scan. Nothing was added.");
                    throw new Error("Insufficient live tradable cards");
                }
                return available;
            });
            g_v.Cards.forEach(function (requestedCards, i) {
                tmpCards = {};
                inv = Array.from(selections[i].values()).flat();
                inv.forEach(function (item) {
                    // add all matching cards to temporary dict
                    index = requestedCards.findIndex((elem) => elem === item.market_hash_name);
                    if (index > -1) {
                        if (tmpCards[requestedCards[index]] === undefined) {
                            tmpCards[requestedCards[index]] = [];
                        }
                        tmpCards[requestedCards[index]].push({ type: item.type, element: item.element, id: item.id });
                    }
                });
                if (g_s.order === "SORT") {
                    // sort cards descending by card id for each type
                    Object.keys(tmpCards).forEach(function (id) {
                        tmpCards[id].sort(mySort);
                    });
                }
                // add cards to trade in order given by STM
                requestedCards.forEach(function (elem) {
                    currentCards = tmpCards[elem] || []; // all cards from inventory with requested signature
                    if (currentCards.length === 0) {
                        failLater = true;
                    } else {
                        index = 0;
                        if (g_s.order === "RANDOM") {
                            // randomize index
                            index = getRandomInt(0, currentCards.length);
                        }
                        unsafeWindow.MoveItemToTrade(currentCards[index].element);
                        cardTypes[i].push(currentCards[index].type);
                        trackedAssetIds[i].push(String(currentCards[index].id));
                        currentCards.splice(index, 1);
                    }
                });
            });

            if (failLater || document.querySelectorAll("#your_slots .has_item").length !== document.querySelectorAll("#their_slots .has_item").length ||
                document.querySelectorAll("#your_slots .has_item").length !== g_v.Cards[0].length ||
                document.querySelectorAll("#their_slots .has_item").length !== g_v.Cards[1].length) {
                unsafeWindow.ShowAlertDialog("Items missing", "Some items are missing and were not added to trade offer. Script aborting.");
                throw "Cards missing";
            }

            // check if item types match
            cardTypes[1].forEach(function (type) {
                index = cardTypes[0].indexOf(type);
                if (index > -1) {
                    cardTypes[0].splice(index, 1);
                } else {
                    unsafeWindow.ShowAlertDialog("Not 1:1 trade", "This is not a valid 1:1 trade. Script aborting.");
                    throw "Not 1:1 trade";
                }
            });
            g_v.tradeTrackingContext.sendAssetIds = trackedAssetIds[0];
            g_v.tradeTrackingContext.receiveAssetIds = trackedAssetIds[1];
            restoreCookie(g_v.oldCookie);
            let functionToInject = '(function () {';
            functionToInject += 'window.__asfStmTradeSendContext = {';
            functionToInject += 'doAfterTrade: ' + JSON.stringify(g_s.doAfterTrade) + ',';
            functionToInject += 'storageKey: ' + JSON.stringify(PENDING_TRADE_KEY) + ',';
            functionToInject += 'storageVersion: ' + JSON.stringify(PENDING_TRADE_STORE_VERSION) + ',';
            functionToInject += 'trackingContext: ' + JSON.stringify(g_v.tradeTrackingContext);
            functionToInject += '};';
            functionToInject += 'if (!window.__asfStmTradeSendHookInstalled) {';
            functionToInject += 'window.__asfStmTradeSendHookInstalled = true;';
            functionToInject += 'function parseTradeOfferPayload(settings) {';
            functionToInject += 'let payload = null;';
            functionToInject += 'if (typeof settings.data === "string") {';
            functionToInject += 'try { payload = new URLSearchParams(settings.data).get("json_tradeoffer"); } catch (error) {}';
            functionToInject += '} else if (settings.data && typeof settings.data.get === "function") {';
            functionToInject += 'try { payload = settings.data.get("json_tradeoffer"); } catch (error) {}';
            functionToInject += '} else if (settings.data && typeof settings.data === "object" && typeof settings.data.json_tradeoffer === "string") {';
            functionToInject += 'payload = settings.data.json_tradeoffer;';
            functionToInject += '}';
            functionToInject += 'if (!payload) { return null; }';
            functionToInject += 'try { return JSON.parse(payload); } catch (error) { return null; }';
            functionToInject += '}';
            functionToInject += 'function normalizeAssetIds(assets) {';
            functionToInject += 'return (Array.isArray(assets) ? assets : []).map(function (asset) {';
            functionToInject += 'return String(asset && (asset.assetid || asset.id || ""));';
            functionToInject += '}).filter(function (assetId) { return assetId.length > 0; }).sort();';
            functionToInject += '}';
            functionToInject += 'function sentOfferMatchesTrackingContext(settings, currentContext) {';
            functionToInject += 'let tradeOffer = parseTradeOfferPayload(settings);';
            functionToInject += 'let trackingContext = currentContext && currentContext.trackingContext;';
            functionToInject += 'if (!tradeOffer || !trackingContext) { return false; }';
            functionToInject += 'let expectedSend = normalizeAssetIds(trackingContext.sendAssetIds);';
            functionToInject += 'let expectedReceive = normalizeAssetIds(trackingContext.receiveAssetIds);';
            functionToInject += 'let actualSend = normalizeAssetIds(tradeOffer.me && tradeOffer.me.assets);';
            functionToInject += 'let actualReceive = normalizeAssetIds(tradeOffer.them && tradeOffer.them.assets);';
            functionToInject += 'if (expectedSend.length === 0 || expectedReceive.length === 0) { return false; }';
            functionToInject += 'if (actualSend.length !== expectedSend.length || actualReceive.length !== expectedReceive.length) { return false; }';
            functionToInject += 'return actualSend.every(function (assetId, index) { return assetId === expectedSend[index]; }) && actualReceive.every(function (assetId, index) { return assetId === expectedReceive[index]; });';
            functionToInject += '}';
            functionToInject += '$J(document).ajaxSuccess(function (event, xhr, settings) {';
            functionToInject += 'if (settings.url === "https://steamcommunity.com/tradeoffer/new/send") {';
            functionToInject += 'try {';
            functionToInject += 'let currentContext = window.__asfStmTradeSendContext || {};';
            functionToInject += 'let payload = JSON.parse(xhr.responseText || "{}");';
            functionToInject += 'let offerId = String(payload.tradeofferid || payload.tradeofferid_new || "");';
            functionToInject += 'let matchesTrackingContext = sentOfferMatchesTrackingContext(settings, currentContext);';
            functionToInject += 'let sendSucceeded = Boolean(offerId) && !(typeof payload.strError === "string" && payload.strError.trim().length > 0);';
            functionToInject += 'if (sendSucceeded && matchesTrackingContext) {';
            functionToInject += 'let store = { version: currentContext.storageVersion, updatedAt: 0, trades: {} };';
            functionToInject += 'try { let saved = JSON.parse(localStorage.getItem(currentContext.storageKey)); if (saved && saved.version === currentContext.storageVersion && saved.trades) { store = saved; } } catch (error) {}';
            functionToInject += 'store.trades[offerId] = Object.assign({}, currentContext.trackingContext, { offerId: offerId, state: "sent", updatedAt: Date.now() });';
            functionToInject += 'store.updatedAt = Date.now();';
            functionToInject += 'localStorage.setItem(currentContext.storageKey, JSON.stringify(store));';
            functionToInject += '} else if (!matchesTrackingContext) { return; }';
            functionToInject += 'if (currentContext.doAfterTrade === "CLOSE_WINDOW") { window.close();';
            functionToInject += '} else if (currentContext.doAfterTrade === "CLICK_OK") {';
            functionToInject += 'document.querySelector("div.newmodal_buttons > div").click(); }';
            functionToInject += '} catch (error) {}';
            functionToInject += '} });';
            functionToInject += '}';
            functionToInject += '})();';
            let script = document.createElement("script");
            script.appendChild(document.createTextNode(functionToInject));
            document.body.appendChild(script);
            // send trade offer
            if (g_s.autoSend && !g_v.manualReview) {
                unsafeWindow.ToggleReady(true);
                unsafeWindow.CTradeOfferStateManager.ConfirmTradeOffer();
            }

            let notif = document.createElement("span");
            notif.setAttribute("style", "color:#00FF00; opacity:0; transition: opacity 3s;");
            notif.appendChild(document.createTextNode("(All cards added successfully)"));
            let anchor = document.getElementsByClassName("trade_partner_headline")[0];
            anchor.appendChild(notif);
            window.getComputedStyle(notif).opacity;
            notif.style.opacity = 1;
        }

        function checkContexts(g_s, g_v) {
            "use strict";
            if (Date.now() - g_v.inventoryLoadStartedAt > 60000) {
                restoreCookie(g_v.oldCookie);
                unsafeWindow.ShowAlertDialog("Inventory unavailable", "Steam inventories did not finish loading within 60 seconds. No offer was sent.");
                return;
            }
            let ready = 0;
            // check if Steam loaded everything needed
            g_v.Users.forEach(function (user) {
                if (user.rgContexts && user.rgContexts[753] && user.rgContexts[753][6]) {
                    if (user.cLoadsInFlight === 0) {
                        if (user.rgContexts[753][6].inventory) {
                            ready += 1;
                        } else {
                            unsafeWindow.document.getElementById("trade_inventory_unavailable").show();
                            unsafeWindow.document.getElementById("trade_inventory_pending").show();
                            user.loadInventory(753, 6);
                        }
                    }
                }
            });

            if (ready === 2) {
                // select your inventory
                unsafeWindow.TradePageSelectInventory(g_v.Users[0], 753, "6");
                // set trade offer message
                document.getElementById("trade_offer_note").value = g_v.tradeOfferMessage;
                try {
                    addCards(g_s, g_v);
                } catch (e) {
                    // no matter what happens, restore old cookie
                    restoreCookie(g_v.oldCookie);
                }
            } else {
                window.setTimeout(checkContexts, 500, g_s, g_v);
            }
        }

        function getUrlVars() {
            "use strict";
            let vars = {};
            let hashes = window.location.href.slice(window.location.href.indexOf("?") + 1).split("&");
            hashes.forEach(function (hash) {
                hash = hash.split("=");
                vars[hash[0]] = hash[1];
            });
            return vars;
        }

        ///// STM functions /////

        try {
            if (window.location.href.includes("source=asfstm")) {
                LoadConfig();
                let params = LoadParams();

                let vars = getUrlVars();
                if (!/^[1-9]\d{0,9}$/.test(vars.partner || "") || Number(vars.partner) > 4294967295 ||
                    (vars.token !== undefined && !/^[A-Za-z0-9_-]{8}$/.test(vars.token))) {
                    throw new Error("Invalid trade partner/token");
                }

                if (vars.match === undefined) {
                    throw new Error("missing url parameter");
                }
                let filter = [];
                if (vars.match === "all") {
                    filter = params.filter;
                } else {
                    if (isNaN(Number(vars.match))) {
                        throw new Error("invalid url parameter");
                    }
                    filter.push(Number(vars.match));
                }

                let Cards = [[], []];
                let matches = params.matches[vars.partner];
                if (matches === undefined) {
                    throw new Error("no matches with this partner");
                }
                for (let i = 0; i < filter.length; i++) {
                    let appid = filter[i];

                    if (matches[appid] === undefined) {
                        //can happen, filter is just allowed appids, not necessarily available on this bot.
                    } else {
                        Cards[0] = Cards[0].concat(matches[appid].send.map((card) => decodeURIComponent(params.cardNames[card])));
                        Cards[1] = Cards[1].concat(matches[appid].receive.map((card) => decodeURIComponent(params.cardNames[card])));
                    }
                }

                if (Cards[0].length !== Cards[1].length) {
                    unsafeWindow.ShowAlertDialog("Different items amount", "You've requested " + (Cards[0].length > Cards[1].length ? "less" : "more") + " items than you give. Script aborting.");
                    throw new Error("Different items amount on both sides");
                }

                if (Cards[0].length === 0) {
                    throw new Error("nothing to add, exiting");
                }
                const tradeMarker = createTradeMarker();
                const tradeOfferMessage = buildTrackedTradeMessage(globalSettings.tradeMessage, tradeMarker);
                const tradeTrackingContext = {
                    marker: tradeMarker,
                    createdAt: Date.now(),
                    partner: vars.partner,
                    match: vars.match,
                    filter: filter,
                    sendCardNames: Cards[0],
                    receiveCardNames: Cards[1],
                };
                // clear cookie containing last opened inventory tab - prevents unwanted inventory loading (it will be restored later)
                let oldCookie = document.cookie.split("strTradeLastInventoryContext=")[1];
                if (oldCookie) {
                    oldCookie = oldCookie.split(";")[0];
                }
                document.cookie = "strTradeLastInventoryContext=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/tradeoffer/";

                let Users = [unsafeWindow.UserYou, unsafeWindow.UserThem];
                let global_vars = {
                    Users: Users, oldCookie: oldCookie, Cards: Cards, tradeTrackingContext: tradeTrackingContext, tradeOfferMessage: tradeOfferMessage,
                    inventoryLoadStartedAt: Date.now(),
                    manualReview: vars.groupmatch === "1" || params.targetSafety?.[vars.partner]?.manualReview === true,
                };

                window.setTimeout(checkContexts, 500, globalSettings, global_vars);
            }
        } catch (e) {
        }
    }
})();
