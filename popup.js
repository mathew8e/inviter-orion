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

// --- Liveness check ----------------------------------------------------

// A run marked active whose page no longer has the script alive (tab closed,
// reloaded, or navigated away) never gets to send FINISHED. Catch that on
// open so the panel can't sit on a stale "running".
async function reconcileStaleRun() {
    const { isRunning, runTabId, count } = await storageGet(["isRunning", "runTabId", "count"]);
    if (!isRunning) return;

    let alive = false;
    if (runTabId != null) {
        try {
            const [{ result }] = await chrome.scripting.executeScript({
                target: { tabId: runTabId },
                func: () => window.__inviter_running === true,
            });
            alive = result === true;
        } catch {
            alive = false; // tab is gone or not scriptable
        }
    }

    if (!alive) {
        chrome.runtime.sendMessage({ type: "RECONCILE_DEAD_RUN", count: count || 0 });
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
            },
        });
    } catch {
        // Page is gone — the liveness check will settle the state.
        chrome.runtime.sendMessage({ type: "RECONCILE_DEAD_RUN", count: 0 });
    }
});

document.addEventListener("DOMContentLoaded", async () => {
    await loadSettings();
    await reconcileStaleRun();
    refresh();
});

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
    const send = (msg) => {
        try {
            chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
        } catch (e) {
            console.warn("inviter: message failed", e);
        }
    };

    // NOTES.md #2: the list is virtualised, so a quick "nothing new" check
    // lies. Scroll fast, but once it looks finished, confirm slowly — with
    // growing waits, since on a slow connection the next batch of people
    // can take much longer than a couple of seconds to arrive over the
    // network. Cumulative: 3+6+12+24+45 = 90s before giving up for good.
    const SETTLE_WAITS_MS = [3000, 6000, 12000, 24000, 45000];
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
            const clickListener = (event) => {
                const target = event.target.closest('div[role="button"], button');
                if (!target) return;
                const label = target.getAttribute("aria-label") || target.textContent || "";
                if (KEYWORDS.some((k) => label.toLowerCase().includes(k))) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    document.removeEventListener("click", clickListener, true);
                    resolve(target);
                }
            };
            document.addEventListener("click", clickListener, true);
        });

        const anchorDialog = anchorButton.closest('div[role="dialog"]');
        scrollableElement =
            (anchorDialog && findScrollable(anchorDialog)) || anchorDialog || document.scrollingElement;
    }

    scrollableElement.classList.add("__inviter-scroll");
    send({ type: "LOG", message: "Mám seznam. Scrolluji a zvu…" });

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

    // Climb to the row: the direct child of the scroll container. That
    // element survives the button being removed after a successful invite.
    const rowOf = (btn) => {
        let node = btn;
        for (let i = 0; i < 10; i++) {
            if (node.getAttribute("role") === "listitem") return node;
            if (!node.parentElement || node.parentElement === scrollableElement) return node;
            node = node.parentElement;
        }
        return node;
    };

    if (typeof window.__inviter_stop === "undefined") window.__inviter_stop = false;
    window.__inviter_running = true;

    let count = 0;
    let idleScrolls = 0;

    while (!window.__inviter_stop && count < limit) {
        const buttons = findInviteButtons();

        if (buttons.length === 0) {
            idleScrolls++;
            send({ type: "LOG", message: `Nic nového, scrolluji… (${idleScrolls})` });
        } else {
            idleScrolls = 0;
            send({ type: "LOG", message: `Nalezeno ${buttons.length} tlačítek.` });
        }

        for (const btn of buttons) {
            if (window.__inviter_stop || count >= limit) break;

            btn.dataset.invited = "true";
            const row = rowOf(btn);
            row.classList.add("__inviter-row");

            // Invite pacing stays conservative — this is the rate-limit
            // surface (NOTES.md #3), not the scrolling.
            await sleep(Math.random() * delay * 1000 + 500);

            btn.scrollIntoView({ block: "center" });
            await sleep(80);

            if (!document.body.contains(btn)) continue;

            // Visible "about to click" beat before the tap actually lands,
            // so someone watching the screen can see it deliberately
            // targeting each person rather than skipping silently.
            row.classList.add("__inviter-target");
            await sleep(450);

            try {
                btn.click();
                row.classList.remove("__inviter-target");
                row.classList.add("__inviter-ok");
                count++;
                send({ type: "UPDATE_COUNT", count });
            } catch {
                row.classList.remove("__inviter-target");
                row.classList.add("__inviter-fail");
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
                if (window.__inviter_stop) break;
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
            if (!grew && !window.__inviter_stop) {
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
    send({ type: "FINISHED", count, stopped: window.__inviter_stop });
}
