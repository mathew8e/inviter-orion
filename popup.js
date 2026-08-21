// The popup only renders state and sends intents. background.js owns the
// truth, so a run that ends while the popup is closed is still recorded.

const el = (id) => document.getElementById(id);
const statusEl = el("status");
const bandTextEl = el("bandText");
const countEl = el("count");
const startBtn = el("startBtn");
const stopBtn = el("stopBtn");
const historyBody = el("historyBody");

// Callback form is supported everywhere; promise-returning chrome.storage is
// not guaranteed on Orion, which is the browser this actually ships to.
const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));

const BAND_TEXT = {
    idle: "Připraveno",
    running: "Běží",
    stopping: "Zastavuji",
    done: "Hotovo",
    stopped: "Zastaveno",
    error: "Přerušeno",
};

const TAG_TEXT = { done: "Hotovo", stopped: "Stop", interrupted: "Chyba" };

// Settings persist so the panel comes back the way it was left.
const SETTINGS = {
    string: "Pozvat",
    delay: "0.5",
    limit: "1000",
    pauseAfter: "200",
    scrollDelay: "500",
    noButton: "15",
    keepAwake: true,
};

// --- Rendering ---------------------------------------------------------

function renderCount(count) {
    const n = Number(count) || 0;
    const padded = String(n).padStart(4, "0");
    const lead = padded.length - String(n).length;
    countEl.innerHTML = lead
        ? `<span class="lead">${padded.slice(0, lead)}</span>${padded.slice(lead)}`
        : padded;
}

function renderState(state) {
    const kind = state.statusKind || "idle";
    const active = kind === "running" || kind === "stopping";

    document.body.dataset.state = kind;
    bandTextEl.textContent = BAND_TEXT[kind] || BAND_TEXT.idle;
    statusEl.textContent = state.statusText || "Otevři seznam reakcí a spusť.";
    renderCount(state.count);

    startBtn.disabled = active;
    stopBtn.disabled = !active;
}

function renderHistory(history) {
    historyBody.innerHTML = "";

    if (!history || !history.length) {
        const row = historyBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 3;
        cell.className = "empty";
        cell.textContent = "Zatím žádné běhy.";
        return;
    }

    [...history].reverse().forEach((item) => {
        const date = new Date(item.date);
        const row = historyBody.insertRow();

        const when = row.insertCell();
        when.innerHTML =
            `<span class="date">${date.toLocaleDateString("cs-CZ", { day: "numeric", month: "short" })}</span> ` +
            `<span class="time">${date.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}</span>`;

        const count = row.insertCell();
        count.className = "num";
        count.textContent = item.count;

        const reason = item.reason || "done";
        const end = row.insertCell();
        end.className = "end";
        end.innerHTML = `<span class="tag ${reason}">${TAG_TEXT[reason] || reason}</span>`;
    });
}

async function refresh() {
    const data = await storageGet([
        "isRunning",
        "count",
        "statusText",
        "statusKind",
        "invitationHistory",
    ]);
    renderState(data);
    renderHistory(data.invitationHistory);
}

// --- Settings ----------------------------------------------------------

async function loadSettings() {
    const saved = await storageGet("settings");
    const s = { ...SETTINGS, ...(saved.settings || {}) };

    Object.keys(SETTINGS).forEach((key) => {
        const input = el(key);
        if (!input) return;
        if (input.type === "checkbox") input.checked = Boolean(s[key]);
        else input.value = s[key];
    });

    el("delayValue").textContent = `${String(s.delay).replace(".", ",")} s`;
}

function saveSettings() {
    const settings = {};
    Object.keys(SETTINGS).forEach((key) => {
        const input = el(key);
        if (!input) return;
        settings[key] = input.type === "checkbox" ? input.checked : input.value;
    });
    chrome.storage.local.set({ settings });
}

// --- Reading the run's state straight from the page --------------------

// Read the state the injected script mirrors into the page's DOM. This is
// the only channel that works on builds where the script's own
// chrome.runtime.sendMessage never reaches the extension (iOS Orion).
async function readPageState(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const r = document.documentElement;
                const s = {
                    count: parseInt(r.getAttribute("data-inviter-count"), 10) || 0,
                    status: r.getAttribute("data-inviter-status"),
                    done: r.getAttribute("data-inviter-done") === "1",
                    stopped: r.getAttribute("data-inviter-stopped") === "1",
                    alive: window.__inviter_running === true,
                };
                // Consume the finished flag so a finish is reported once and
                // repeated polls can't add a history row each time.
                if (s.done) r.setAttribute("data-inviter-done", "0");
                return s;
            },
        });
        return result || null;
    } catch {
        return null; // tab is gone or not scriptable
    }
}

// --- Polling the page directly -----------------------------------------

// Runs on open and then on a timer. Also recovers a run that finished
// while the panel was closed, which on a phone is most of the time — the
// DOM attributes survive on the page, so the real count is still there to
// be read and written into the history.
async function syncFromPage() {
    const { isRunning, runTabId, count } = await storageGet(["isRunning", "runTabId", "count"]);
    if (!isRunning) return;

    const snap = runTabId == null ? null : await readPageState(runTabId);

    // Tab is gone entirely, so there is nothing left to recover from.
    if (!snap) {
        chrome.runtime.sendMessage({ type: "RECONCILE_DEAD_RUN", count: count || 0 });
        return;
    }

    if (snap.status) chrome.runtime.sendMessage({ type: "LOG", message: snap.status });
    chrome.runtime.sendMessage({ type: "UPDATE_COUNT", count: snap.count });

    // Either it reported finishing, or the script is no longer alive and
    // never got to report it. Settle with the count the page actually
    // reached, not the (likely zero) one in storage.
    if (snap.done || !snap.alive) {
        chrome.runtime.sendMessage({
            type: "FINISHED",
            count: snap.count,
            stopped: snap.stopped || !snap.alive,
        });
    }
}

// --- Events ------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "local") return;
    if (changes.invitationHistory) renderHistory(changes.invitationHistory.newValue);
    if (changes.statusKind || changes.statusText || changes.count) refresh();
});

el("delay").addEventListener("input", (e) => {
    el("delayValue").textContent = `${String(e.target.value).replace(".", ",")} s`;
});

Object.keys(SETTINGS).forEach((key) => {
    const input = el(key);
    if (input) input.addEventListener("change", saveSettings);
});

el("clearHistoryBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
});

startBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
        statusEl.textContent = "Není aktivní karta, na které by šlo spustit.";
        return;
    }

    saveSettings();
    chrome.runtime.sendMessage({ type: "START", tabId: tab.id });

    const num = (id, fallback) => {
        const v = parseFloat(el(id).value);
        return Number.isFinite(v) ? v : fallback;
    };

    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.__inviter_stop = false;
                window.__inviter_running = true;
                const r = document.documentElement;
                r.setAttribute("data-inviter-stop", "0");
                r.setAttribute("data-inviter-done", "0");
                r.setAttribute("data-inviter-running", "1");
                r.setAttribute("data-inviter-count", "0");
                r.setAttribute("data-inviter-status", "Spouštím…");
            },
        });

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: autoInviteAction,
            args: [
                el("string").value || "Pozvat",
                num("delay", 0.5),
                num("limit", 1000),
                num("pauseAfter", 200),
                num("noButton", 15),
                num("scrollDelay", 500),
                el("keepAwake").checked,
            ],
        });
    } catch (err) {
        chrome.runtime.sendMessage({ type: "FINISHED", count: 0, stopped: true });
        statusEl.textContent = `Nepodařilo se spustit: ${err?.message || "neznámá chyba"}`;
    }
});

stopBtn.addEventListener("click", async () => {
    chrome.runtime.sendMessage({ type: "STOP_REQUEST" });

    const { runTabId } = await storageGet("runTabId");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = runTabId ?? tab?.id;
    if (tabId == null) return;

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                window.__inviter_stop = true;
                // The attribute is the one that reliably crosses contexts.
                document.documentElement.setAttribute("data-inviter-stop", "1");
            },
        });
    } catch {
        // Page is gone — the liveness check will settle the state.
        chrome.runtime.sendMessage({ type: "RECONCILE_DEAD_RUN", count: 0 });
    }
});

async function init() {
    await loadSettings();
    await syncFromPage();
    refresh();
    // Keep reading straight from the page while the panel is open, so the
    // count and the finish still land even if messaging is dead.
    setInterval(syncFromPage, 1000);
}

// The script tag is at the end of <body>, so DOMContentLoaded may already
// have fired by the time this runs — in which case the listener never would.
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

// --- Injected into the Facebook page -----------------------------------

async function autoInviteAction(
    inputString,
    delay,
    limit,
    pauseAfter,
    maxIdleScrolls,
    scrollDelay,
    keepAwake,
) {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // Messaging must never take the run down with it: the popup may be
    // closed and the service worker asleep.
    const root = document.documentElement;

    // Mirror every status update into the DOM as well as messaging it.
    // On some builds (seen on iOS Orion) chrome.runtime.sendMessage from an
    // injected script never reaches the extension at all — which froze the
    // panel on its last popup-set status, left the counter on zero, and
    // made Stop hang forever waiting for a FINISHED that could not arrive.
    // The DOM is shared across JS contexts and readable via
    // chrome.scripting.executeScript (which demonstrably does work, since
    // the script runs at all), so the popup can poll this instead.
    const publish = (patch) => {
        try {
            Object.keys(patch).forEach((k) => root.setAttribute(`data-inviter-${k}`, String(patch[k])));
        } catch (e) {
            console.warn("inviter: publish failed", e);
        }
    };

    const send = (msg) => {
        if (msg.type === "LOG") publish({ status: msg.message });
        if (msg.type === "UPDATE_COUNT") publish({ count: msg.count });
        if (msg.type === "FINISHED") {
            publish({ count: msg.count, running: 0, done: 1, stopped: msg.stopped ? 1 : 0 });
        }
        try {
            chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
        } catch (e) {
            console.warn("inviter: message failed", e);
        }
    };

    // Stop may be set from a *separate* executeScript call, which is not
    // guaranteed to share `window` with this one. The DOM attribute always
    // crosses that boundary; the window flag is kept for compatibility.
    const isStopped = () => root.getAttribute("data-inviter-stop") === "1" || window.__inviter_stop === true;

    // Declared here, not inside run(), so a crash before the loop even
    // starts can still report an accurate (zero) count.
    let count = 0;

    // Anything in run() can throw — a permissions-policy quirk, a WebKit
    // API difference, anything engine-specific we haven't seen on this
    // exact build of Orion. Without this wrapper, a throw before the first
    // send() left the panel frozen on "Spouštím…" forever with no error
    // anywhere, because chrome.scripting.executeScript's own promise still
    // resolves normally even when the injected function throws internally.
    try {
        await run();
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        console.error("inviter: run() failed:", e);
        send({ type: "LOG", message: `Chyba: ${message}` });
        send({ type: "FINISHED", count, stopped: true });
        window.__inviter_running = false;
    }
    return;

    async function run() {
    // NOTES.md #2: the list is virtualised, so a quick "nothing new" check
    // lies. Scroll fast, but once it looks finished, confirm slowly — with
    // growing waits, since on a slow connection the next batch of people
    // can take a bit longer than a couple of seconds to arrive over the
    // network. Cumulative: 5+10+15 = 30s before giving up for good.
    const SETTLE_WAITS_MS = [5000, 10000, 15000];
    const KEYWORDS = ["invite", "pozvat", "sledovat", "follow"];

    // --- Visual markers -------------------------------------------------
    // Facebook restyles and re-renders its own buttons, and an invite button
    // often vanishes once clicked — so the marker goes on the person's row,
    // which survives, and uses !important to beat FB's inline styles.
    const STYLE_ID = "__inviter_styles";
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            .__inviter-row {
                position: relative !important;
                border-radius: 8px !important;
                transition: background 0.25s ease, box-shadow 0.25s ease !important;
            }
            .__inviter-target {
                background: rgba(220,83,20,0.14) !important;
                box-shadow: inset 0 0 0 2px #DC5314 !important;
                animation: __inviter-pulse 0.55s ease-in-out infinite !important;
            }
            .__inviter-ok {
                background: rgba(63,122,74,0.16) !important;
                box-shadow: inset 0 0 0 2px #3F7A4A !important;
                animation: __inviter-pop 0.3s ease-out !important;
            }
            .__inviter-fail {
                background: rgba(163,47,40,0.16) !important;
                box-shadow: inset 0 0 0 2px #A32F28 !important;
                animation: __inviter-pop 0.3s ease-out !important;
            }
            .__inviter-target::after, .__inviter-ok::after, .__inviter-fail::after {
                position: absolute !important;
                top: 4px !important;
                right: 6px !important;
                z-index: 9999 !important;
                padding: 1px 6px !important;
                border-radius: 4px !important;
                font: 700 10px/1.6 -apple-system, system-ui, sans-serif !important;
                letter-spacing: .06em !important;
                color: #fff !important;
                pointer-events: none !important;
            }
            .__inviter-target::after { content: "→ ZVU…" !important; background: #DC5314 !important; }
            .__inviter-ok::after { content: "✓ POZVÁN" !important; background: #3F7A4A !important; }
            .__inviter-fail::after { content: "× CHYBA" !important; background: #A32F28 !important; }
            .__inviter-scroll { box-shadow: inset 0 0 0 3px #DC5314 !important; }
            @keyframes __inviter-pulse {
                0%, 100% { box-shadow: inset 0 0 0 2px #DC5314 !important; }
                50% { box-shadow: inset 0 0 0 4px #ff8347 !important; }
            }
            @keyframes __inviter-pop {
                0% { transform: scale(0.97); }
                55% { transform: scale(1.015); }
                100% { transform: scale(1); }
            }
            @media (prefers-reduced-motion: reduce) {
                .__inviter-target { animation: none !important; }
                .__inviter-ok, .__inviter-fail { animation: none !important; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    // --- Keep the screen awake ------------------------------------------
    // Requested here, not in the popup: the popup closes as soon as you tap
    // away, and a wake lock dies with the document that holds it. This page
    // stays open for the whole run.
    let wakeLock = null;
    const requestWakeLock = async () => {
        if (!keepAwake || !("wakeLock" in navigator)) return;
        try {
            wakeLock = await navigator.wakeLock.request("screen");
        } catch (e) {
            send({ type: "LOG", message: `Displej nejde udržet vzhůru: ${e.message}` });
        }
    };
    // iOS drops the lock whenever the page is backgrounded; take it back.
    const onVisibility = () => {
        if (document.visibilityState === "visible" && window.__inviter_running) requestWakeLock();
    };
    if (keepAwake) {
        if (!("wakeLock" in navigator)) {
            send({ type: "LOG", message: "Tento prohlížeč neumí držet displej vzhůru." });
        } else {
            await requestWakeLock();
            document.addEventListener("visibilitychange", onVisibility);
        }
    }

    // --- Find the list, without needing a click -------------------------
    const visibleDialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(
        (d) => d.getClientRects().length > 0,
    );
    // The topmost dialog is the one just opened.
    const dialog = visibleDialogs[visibleDialogs.length - 1] || null;

    const findScrollable = (root) => {
        const candidates = Array.from(root.querySelectorAll("*")).filter((node) => {
            const style = window.getComputedStyle(node);
            const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
            return scrolls && node.scrollHeight > node.clientHeight + 10;
        });
        // The reactor list is the tallest scrolling box in the dialog.
        return candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
    };

    let scrollableElement = dialog ? findScrollable(dialog) : null;

    if (!scrollableElement && dialog) {
        scrollableElement = dialog;
        send({ type: "LOG", message: "Seznam nemá vlastní scroll, používám celé okno." });
    }

    // Fall back to the old behaviour only if no dialog is open at all.
    if (!scrollableElement) {
        send({ type: "LOG", message: "Okno s reakcemi není otevřené. Klikni na tlačítko Pozvat." });

        const anchorButton = await new Promise((resolve) => {
            const cleanup = () => {
                document.removeEventListener("click", clickListener, true);
                clearInterval(stopGuard);
            };
            const clickListener = (event) => {
                const target = event.target.closest('div[role="button"], button');
                if (!target) return;
                const label = target.getAttribute("aria-label") || target.textContent || "";
                if (KEYWORDS.some((k) => label.toLowerCase().includes(k))) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    cleanup();
                    resolve(target);
                }
            };
            // Without this the script parks here forever waiting for a click
            // that may never come, never reaching the loop that checks the
            // stop flag — so Stop did nothing and the only way out was
            // force-quitting the whole browser.
            const stopGuard = setInterval(() => {
                if (isStopped()) {
                    cleanup();
                    resolve(null);
                }
            }, 400);
            document.addEventListener("click", clickListener, true);
        });

        if (!anchorButton) {
            send({ type: "FINISHED", count, stopped: true });
            window.__inviter_running = false;
            return;
        }

        const anchorDialog = anchorButton.closest('div[role="dialog"]');
        scrollableElement =
            (anchorDialog && findScrollable(anchorDialog)) || anchorDialog || document.scrollingElement;
    }

    scrollableElement.classList.add("__inviter-scroll");
    send({ type: "LOG", message: "Mám seznam. Scrolluji a zvu…" });

    // --- On-page status HUD -----------------------------------------------
    // Lives in the Facebook page itself, not the popup — so it keeps
    // showing progress and stays stoppable even after the popup is closed,
    // which on a phone is most of the run. A fixed pill under the dialog
    // rather than anchored to the dialog's own box, since the dialog can
    // resize/reflow mid-run and a fixed position survives that.
    const HUD_ID = "__inviter_hud";
    document.getElementById(HUD_ID)?.remove();

    const hud = document.createElement("div");
    hud.id = HUD_ID;
    hud.style.cssText = `
        position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
        z-index: 2147483647; display: flex; align-items: center; gap: 10px;
        padding: 9px 10px 9px 16px; border-radius: 999px;
        background: #1E211F; color: #DCE7D8;
        font: 600 13px/1 ui-monospace, "SF Mono", Menlo, monospace;
        box-shadow: 0 6px 20px rgba(0,0,0,.45); user-select: none;
        transition: background 0.2s ease; white-space: nowrap; max-width: calc(100vw - 24px);
    `;
    hud.innerHTML = `
        <span id="__inviter_hud_time">00:00</span>
        <span style="opacity:.35">•</span>
        <span id="__inviter_hud_count">0 pozváno</span>
        <button id="__inviter_hud_action" style="
            margin-left: 4px; padding: 6px 14px; border: none; border-radius: 999px;
            background: #A32F28; color: #fff; font: 700 11px ui-monospace, monospace;
            letter-spacing: .05em; text-transform: uppercase; cursor: pointer;
        ">Stop</button>
    `;
    document.body.appendChild(hud);

    const hudTimeEl = hud.querySelector("#__inviter_hud_time");
    const hudCountEl = hud.querySelector("#__inviter_hud_count");
    const hudActionBtn = hud.querySelector("#__inviter_hud_action");

    const hudStart = Date.now();
    const hudTick = () => {
        const s = Math.floor((Date.now() - hudStart) / 1000);
        hudTimeEl.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };
    hudTick();
    const hudInterval = setInterval(hudTick, 1000);

    hudActionBtn.addEventListener("click", () => {
        if (hudActionBtn.dataset.mode === "dismiss") {
            hud.remove();
            return;
        }
        window.__inviter_stop = true;
        publish({ stop: 1 });
        hudActionBtn.textContent = "…";
        hudActionBtn.disabled = true;
        // Keep the popup's own state in sync in case it's open, or gets
        // opened before the run actually finishes.
        send({ type: "STOP_REQUEST" });
    });

    const hudUpdateCount = (n) => {
        hudCountEl.textContent = `${n} pozváno`;
    };

    const hudFinish = (finalCount, stopped) => {
        clearInterval(hudInterval);
        hud.style.background = stopped ? "#A32F28" : "#3F7A4A";
        hudCountEl.textContent = `${finalCount} pozváno`;
        hudActionBtn.textContent = "OK";
        hudActionBtn.disabled = false;
        hudActionBtn.dataset.mode = "dismiss";
        hudActionBtn.style.background = "rgba(255,255,255,.18)";

        // Flash a few times so it's noticeable even if you're not looking
        // right at it when the run ends.
        let flashes = 0;
        const baseColor = hud.style.background;
        const flashInterval = setInterval(() => {
            hud.style.background = flashes % 2 === 0 ? "#DCE7D8" : baseColor;
            hud.style.color = flashes % 2 === 0 ? "#1E211F" : "#DCE7D8";
            flashes++;
            if (flashes >= 6) {
                clearInterval(flashInterval);
                hud.style.background = baseColor;
                hud.style.color = "#DCE7D8";
            }
        }, 220);
    };

    // --- Button matching ------------------------------------------------
    // Match on aria-label OR visible text. Facebook frequently puts the word
    // only in aria-label and leaves textContent empty or padded by nested
    // spans, so an exact textContent match finds nothing at all.
    const searchText = inputString.trim().toLowerCase();
    const findInviteButtons = () =>
        Array.from(scrollableElement.querySelectorAll('div[role="button"], button, a[role="button"]')).filter(
            (btn) => {
                if (btn.dataset.invited === "true") return false;
                const label = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
                const text = (btn.textContent || "").trim().toLowerCase();
                return label === searchText || text === searchText;
            },
        );

    // Mark the button itself, not a guessed ancestor "row" — climbing the
    // tree to find a container that survives the click turned out to reach
    // much too far up on some DOM shapes (as far as the whole dialog). Only
    // fall back one level if the button itself has no visible box (a pure
    // event-delegation wrapper with zero size, so nothing would be visible
    // to mark).
    const markTarget = (btn) => {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return btn;
        return btn.parentElement || btn;
    };

    if (typeof window.__inviter_stop === "undefined") window.__inviter_stop = false;
    window.__inviter_running = true;

    // count is declared in the outer scope, not here, so a failure in
    // run() before this point can still report an accurate count.
    let idleScrolls = 0;

    while (!isStopped() && count < limit) {
        const buttons = findInviteButtons();

        if (buttons.length === 0) {
            idleScrolls++;
            send({ type: "LOG", message: `Nic nového, scrolluji… (${idleScrolls})` });
        } else {
            idleScrolls = 0;
            send({ type: "LOG", message: `Nalezeno ${buttons.length} tlačítek.` });
        }

        for (const btn of buttons) {
            if (isStopped() || count >= limit) break;

            btn.dataset.invited = "true";

            // Invite pacing stays conservative — this is the rate-limit
            // surface (NOTES.md #3), not the scrolling.
            await sleep(Math.random() * delay * 1000 + 500);

            btn.scrollIntoView({ block: "center" });
            await sleep(80);

            if (!document.body.contains(btn)) continue;

            // Computed after scrolling, so the box we measure reflects
            // where the button actually ended up.
            const target = markTarget(btn);
            target.classList.add("__inviter-row");

            // Belt and braces: set the colour directly on the button too,
            // the same way the very first version of this script did
            // (btn.style.backgroundColor, no !important, no stylesheet).
            // That was crude but always visible. The classList/::after
            // badge above is the nicer version; this is the fallback that
            // cannot fail to apply just because an injected <style> tag
            // didn't take effect for some engine-specific reason.
            const paint = (color) => btn.style.setProperty("background-color", color, "important");

            // Visible "about to click" beat before the tap actually lands,
            // so someone watching the screen can see it deliberately
            // targeting each person rather than skipping silently.
            target.classList.add("__inviter-target");
            paint("#DC5314");
            await sleep(450);

            try {
                btn.click();
                target.classList.remove("__inviter-target");
                target.classList.add("__inviter-ok");
                paint("#3F7A4A");
                count++;
                send({ type: "UPDATE_COUNT", count });
                hudUpdateCount(count);
            } catch {
                target.classList.remove("__inviter-target");
                target.classList.add("__inviter-fail");
                paint("#A32F28");
            }

            if (count > 0 && count % pauseAfter === 0) {
                send({ type: "LOG", message: `Pauza 30 s po ${count} pozvánkách.` });
                await sleep(30000);
            }
        }

        const heightBefore = scrollableElement.scrollHeight;
        scrollableElement.scrollTop = scrollableElement.scrollHeight;
        await sleep(scrollDelay);

        if (scrollableElement.scrollHeight === heightBefore && idleScrolls > maxIdleScrolls) {
            // Looks done. Recheck with growing waits before accepting it —
            // a fast connection confirms in a few seconds, a slow one gets
            // up to 90s total before the list is declared finished.
            let grew = false;
            for (let i = 0; i < SETTLE_WAITS_MS.length; i++) {
                if (isStopped()) break;
                const waitMs = SETTLE_WAITS_MS[i];
                send({
                    type: "LOG",
                    message: `Ověřuji konec seznamu (${i + 1}/${SETTLE_WAITS_MS.length}, čekám ${waitMs / 1000}s)…`,
                });
                await sleep(waitMs);
                scrollableElement.scrollTop = scrollableElement.scrollHeight;
                await sleep(300); // give a slow load a moment to paint before measuring
                if (scrollableElement.scrollHeight !== heightBefore) {
                    grew = true;
                    idleScrolls = 0;
                    break;
                }
            }
            if (!grew && !isStopped()) {
                send({ type: "LOG", message: "Konec seznamu." });
                break;
            }
        }
    }

    scrollableElement.classList.remove("__inviter-scroll");
    document.removeEventListener("visibilitychange", onVisibility);
    if (wakeLock) {
        try {
            await wakeLock.release();
        } catch {
            /* already gone */
        }
    }

    window.__inviter_running = false;
    hudFinish(count, isStopped());
    send({ type: "FINISHED", count, stopped: isStopped() });
    } // end run()
}
