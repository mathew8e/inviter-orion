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
    string: "Pozvat, Invite",
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
                el("string").value || "Pozvat, Invite",
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

async function init() {
    await loadSettings();
    await reconcileStaleRun();
    refresh();
}

// The script tag sits at the end of <body>, so DOMContentLoaded may already
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
    const send = (msg) => {
        try {
            chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
        } catch (e) {
            console.warn("inviter: message failed", e);
        }
    };

    // NOTES.md #2: the list is virtualised, so a quick "nothing new" check
    // lies. Scroll fast, but once it looks finished, confirm slowly.
    const SETTLE_WAIT_MS = 2000;
    const SETTLE_CHECKS = 2;
    const KEYWORDS = ["invite", "pozvat", "sledovat", "follow"];

    // --- Diagnostics ----------------------------------------------------
    // Everything here prints with an [INVITER] prefix so it can be copied
    // straight out of the DevTools console (or out of test/run.js, which
    // forwards page console to the terminal).
    const dbgLines = [];
    let dbgPanelEl = null;
    const renderDbgPanel = () => {
        if (!dbgPanelEl) return;
        dbgPanelEl.textContent = dbgLines.slice(-24).join("\n");
        dbgPanelEl.scrollTop = dbgPanelEl.scrollHeight;
    };
    const dbg = (...args) => {
        const line = args
            .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
            .join(" ");
        console.log("[INVITER]", ...args);
        line.split("\n").forEach((l) => dbgLines.push(l));
        renderDbgPanel();
    };

    // On-screen panel: iPad/Orion has no accessible console, so this is the
    // only way to see [INVITER] output on-device. Tap the "DBG" tab to
    // expand; content is plain text so it's screenshot- and copy-friendly.
    const buildDebugPanel = () => {
        if (document.getElementById("__inviter_dbg")) return;
        const wrap = document.createElement("div");
        wrap.id = "__inviter_dbg";
        wrap.style.cssText =
            "position:fixed;left:6px;bottom:6px;z-index:2147483647;font:11px/1.4 ui-monospace,monospace;" +
            "max-width:92vw;box-shadow:0 2px 10px rgba(0,0,0,.4);";

        const tab = document.createElement("button");
        tab.textContent = "DBG";
        tab.style.cssText =
            "display:block;padding:6px 10px;background:#DC5314;color:#fff;border:none;border-radius:6px;" +
            "font:700 11px ui-monospace,monospace;letter-spacing:.05em;";

        const pre = document.createElement("pre");
        pre.style.cssText =
            "display:none;margin:6px 0 0;padding:8px;max-height:40vh;width:90vw;max-width:640px;" +
            "overflow:auto;white-space:pre-wrap;word-break:break-word;background:rgba(19,21,19,.96);" +
            "color:#DCE7D8;border-radius:8px;";

        tab.addEventListener("click", () => {
            pre.style.display = pre.style.display === "none" ? "block" : "none";
        });

        wrap.appendChild(tab);
        wrap.appendChild(pre);
        document.body.appendChild(wrap);
        dbgPanelEl = pre;
        renderDbgPanel();
    };
    buildDebugPanel();

    const describe = (node) => {
        if (!node) return "null";
        if (node === document) return "document";
        const cls = (node.className || "").toString().slice(0, 40);
        return `<${node.tagName.toLowerCase()}${node.getAttribute?.("role") ? ` role=${node.getAttribute("role")}` : ""}${cls ? ` class="${cls}…"` : ""}> ${node.clientWidth}x${node.clientHeight} scrollH=${node.scrollHeight}`;
    };

    // Groups every clickable in `root` by its shape so the real markup is
    // visible at a glance without scrolling through hundreds of nodes.
    const dumpInventory = (root, label) => {
        const nodes = Array.from(root.querySelectorAll('[role="button"], button, a[role="button"]'));
        const shapes = {};
        nodes.forEach((n) => {
            const key = JSON.stringify({
                tag: n.tagName.toLowerCase(),
                role: n.getAttribute("role"),
                aria: (n.getAttribute("aria-label") || "").slice(0, 45) || null,
                text: (n.textContent || "").trim().slice(0, 45) || null,
            });
            shapes[key] = (shapes[key] || 0) + 1;
        });
        const summary = Object.entries(shapes)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([shape, n]) => `  ${n}x ${shape}`)
            .join("\n");
        dbg(`=== INVENTORY (${label}): ${nodes.length} clickable, ${Object.keys(shapes).length} distinct ===\n${summary}`);
    };

    // --- Visual markers -------------------------------------------------
    // Facebook restyles and re-renders its own buttons, and an invite button
    // often vanishes once clicked — so the marker goes on the person's row,
    // which survives, and uses !important to beat FB's inline styles.
    const STYLE_ID = "__inviter_styles";
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            .__inviter-row { position: relative !important; border-radius: 8px !important; }
            .__inviter-ok {
                background: rgba(63,122,74,0.16) !important;
                box-shadow: inset 0 0 0 2px #3F7A4A !important;
            }
            .__inviter-fail {
                background: rgba(163,47,40,0.16) !important;
                box-shadow: inset 0 0 0 2px #A32F28 !important;
            }
            .__inviter-ok::after, .__inviter-fail::after {
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
            .__inviter-ok::after { content: "✓ POZVÁN" !important; background: #3F7A4A !important; }
            .__inviter-fail::after { content: "× CHYBA" !important; background: #A32F28 !important; }
            .__inviter-scroll { box-shadow: inset 0 0 0 3px #DC5314 !important; }
        `;
        document.documentElement.appendChild(style);
    }

    // --- Keep the screen awake ------------------------------------------
    // Requested here, not in the popup: the popup closes as soon as you tap
    // away, and a wake lock dies with the document that holds it. This page
    // stays open for the whole run.
    let wakeLock = null;
    let awakeVideo = null;

    // Facebook sends Permissions-Policy: screen-wake-lock=(), so the Wake
    // Lock API is unavailable on this page no matter what we do. The
    // fallback is the long-standing trick of looping a tiny silent video —
    // media playback keeps the screen alive on iOS and isn't gated by that
    // policy. Inlined as a data URI so it needs no web_accessible_resources.
    const AWAKE_MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMrbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlZ0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHObWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAATlzdGJsAAAAuXN0c2QAAAAAAAAAAQAAAKlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAe/+EAF2dCwB7ZBCbARAAAAwAEAAADAAg8WLkgAQAFaMuDyyAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAKcAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAgAAQAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAApIAAAAKAAAAFHN0Y28AAAAAAAAAAQAAA1sAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAwAAAACGZyZWUAAAKkbWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjMgMDQ4MGNiMCAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAaZYiEBb///w9FAAFPfycnJ1111111111114AAAAAGQZo4CvhG";

    const startAwakeVideo = () => {
        if (awakeVideo) return;
        awakeVideo = document.createElement("video");
        awakeVideo.setAttribute("playsinline", "");
        awakeVideo.muted = true;
        awakeVideo.loop = true;
        awakeVideo.src = AWAKE_MP4;
        // Must stay in the layout tree to count as playing, so park it
        // off-screen at 1px rather than using display:none.
        awakeVideo.style.cssText =
            "position:fixed;width:1px;height:1px;opacity:0.01;bottom:0;right:0;pointer-events:none;z-index:-1";
        document.body.appendChild(awakeVideo);
        awakeVideo
            .play()
            .then(() => dbg("keep-awake: looping video started"))
            .catch((e) => {
                dbg("keep-awake: video fallback failed:", e.message);
                send({ type: "LOG", message: "Displej nejde udrzet vzhuru." });
            });
    };

    const stopAwake = async () => {
        document.removeEventListener("visibilitychange", onVisibility);
        if (awakeVideo) {
            awakeVideo.pause();
            awakeVideo.remove();
            awakeVideo = null;
        }
        if (wakeLock) {
            try {
                await wakeLock.release();
            } catch {
                /* already gone */
            }
            wakeLock = null;
        }
    };

    const requestWakeLock = async () => {
        if (!keepAwake) return;
        // Try the real API first; fall back to the video if it is blocked.
        if ("wakeLock" in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request("screen");
                dbg("keep-awake: Wake Lock API acquired");
                return;
            } catch (e) {
                dbg("keep-awake: Wake Lock unavailable (" + e.name + "), using video");
            }
        }
        startAwakeVideo();
    };

    // iOS drops both the lock and playback when backgrounded; take them back.
    const onVisibility = () => {
        if (document.visibilityState === "visible" && window.__inviter_running) {
            if (awakeVideo) awakeVideo.play().catch(() => {});
            else requestWakeLock();
        }
    };

    if (keepAwake) {
        await requestWakeLock();
        document.addEventListener("visibilitychange", onVisibility);
    }

    // --- Click simulation -------------------------------------------------
    // element.click() only fires a synthetic "click" event. Touch-optimised
    // web apps (which is what mobile Facebook is) commonly bind to
    // pointerdown/touchstart/touchend instead, or ignore untrusted clicks
    // entirely — so .click() can silently no-op on iOS while working fine
    // on desktop Chrome. This fires the full gesture sequence a real tap
    // produces, at the element's actual on-screen centre.
    const simulateTap = (target) => {
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };

        const fire = (Ctor, type, extra) => {
            try {
                target.dispatchEvent(new Ctor(type, { ...common, ...extra }));
            } catch (e) {
                dbg(`simulateTap: ${type} dispatch failed: ${e.message}`);
            }
        };

        fire(PointerEvent, "pointerover", { pointerType: "touch" });
        fire(PointerEvent, "pointerenter", { pointerType: "touch" });
        fire(PointerEvent, "pointerdown", { pointerType: "touch", isPrimary: true, button: 0 });
        fire(MouseEvent, "mousedown", { button: 0 });

        if (typeof Touch === "function" && typeof TouchEvent === "function") {
            try {
                const touch = new Touch({ identifier: Date.now(), target, clientX: x, clientY: y });
                fire(TouchEvent, "touchstart", { touches: [touch], targetTouches: [touch], changedTouches: [touch] });
            } catch (e) {
                dbg(`simulateTap: touchstart failed: ${e.message}`);
            }
        }

        fire(PointerEvent, "pointerup", { pointerType: "touch", isPrimary: true, button: 0 });
        fire(MouseEvent, "mouseup", { button: 0 });

        if (typeof Touch === "function" && typeof TouchEvent === "function") {
            try {
                const touch = new Touch({ identifier: Date.now(), target, clientX: x, clientY: y });
                fire(TouchEvent, "touchend", { touches: [], targetTouches: [], changedTouches: [touch] });
            } catch (e) {
                dbg(`simulateTap: touchend failed: ${e.message}`);
            }
        }

        fire(MouseEvent, "click", { button: 0 });
        // Belt and braces: the plain DOM API too, in case a listener is
        // bound via onclick= rather than addEventListener.
        try {
            target.click();
        } catch (e) {
            dbg(`simulateTap: element.click() failed: ${e.message}`);
        }
    };

    // A click "succeeding" is not proof Facebook did anything — .click() can
    // silently no-op. Real proof is the button's own state changing to a
    // done-state (Invited/Following/etc) shortly after. This is what tells
    // us, on-device, whether the tap actually registered.
    const verifyInvited = async (btn, label, text) => {
        for (let i = 0; i < 6; i++) {
            await sleep(150);
            if (!document.body.contains(btn)) return { ok: true, reason: "removed from DOM" };
            const newLabel = labelOf(btn);
            const newText = textOf(btn);
            if (newLabel !== label || newText !== text) {
                if (isDoneState(newLabel, newText)) return { ok: true, reason: `state -> "${newLabel || newText}"` };
                return { ok: false, reason: `state changed to unexpected "${newLabel || newText}"` };
            }
        }
        return { ok: false, reason: "no state change after tap" };
    };

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

    dbg(`dialogs visible: ${visibleDialogs.length}; using:`, describe(dialog));

    let scrollableElement = dialog ? findScrollable(dialog) : null;
    dbg("scroll container picked:", describe(scrollableElement));

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
    // Search from the dialog, NOT the inner scroll container: the container
    // picked for scrolling is often a wrapper that doesn't actually contain
    // the row buttons, which silently yields zero matches.
    const searchRoot = dialog || document;
    const BTN_SELECTOR = 'div[role="button"], button, a[role="button"]';
    const searchText = inputString.trim().toLowerCase();

    dbg("search root:", describe(searchRoot), "| searching for:", JSON.stringify(inputString));

    const labelOf = (btn) => (btn.getAttribute("aria-label") || "").trim().toLowerCase();
    const textOf = (btn) => (btn.textContent || "").trim().toLowerCase();

    // Already-actioned states must NEVER be clicked: on Facebook, clicking
    // "Invited" opens the cancel-invite menu. This matters because "invite"
    // is a prefix of "invited", so the looser tiers below would otherwise
    // match every already-invited person in the list.
    const DONE_STATES = [
        "invited", "pozváno", "pozvano", "pozvaný", "pozvany",
        "following", "sledujete", "sleduji", "sledování",
        "requested", "request sent", "sent", "odesláno", "odeslano",
    ];
    const isDoneState = (l, t) => DONE_STATES.some((d) => l === d || t === d);

    // Accepts a comma-separated list so one setting covers both UI languages.
    const searchTerms = inputString
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

    const anyTerm = (fn) => searchTerms.some(fn);

    // Tiered so precision is preferred, but a per-person label
    // ("Invite Jan Novák") still gets found.
    const TIERS = [
        { name: "exact", test: (l, t) => anyTerm((s) => l === s || t === s) },
        { name: "starts-with", test: (l, t) => anyTerm((s) => l.startsWith(s) || t.startsWith(s)) },
        { name: "contains", test: (l, t) => anyTerm((s) => l.includes(s) || t.includes(s)) },
    ];

    let matchTier = null;
    let skippedDone = 0;

    const findInviteButtons = () => {
        skippedDone = 0;
        const all = Array.from(searchRoot.querySelectorAll(BTN_SELECTOR)).filter((btn) => {
            if (btn.dataset.invited === "true") return false;
            if (btn.getAttribute("role") === "tab") return false;
            if (isDoneState(labelOf(btn), textOf(btn))) {
                skippedDone++;
                return false;
            }
            return true;
        });

        // Lock onto the first tier that finds anything and keep using it, so
        // one loose match can't widen the net for the rest of the run.
        for (const tier of TIERS) {
            if (matchTier && tier.name !== matchTier) continue;
            const hits = all.filter((btn) => tier.test(labelOf(btn), textOf(btn)));
            if (hits.length) {
                if (!matchTier) {
                    matchTier = tier.name;
                    dbg(`matching on tier "${tier.name}" — ${hits.length} hit(s)`);
                }
                return hits;
            }
            if (matchTier) return [];
        }
        return [];
    };

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
    let unverifiedTaps = 0;

    while (!window.__inviter_stop && count < limit) {
        const buttons = findInviteButtons();

        if (buttons.length === 0) {
            idleScrolls++;
            send({
                type: "LOG",
                message: `Scrolluji… (${idleScrolls}) ${skippedDone} už pozváno`,
            });

            // First empty pass is the diagnostic moment: dump what is
            // actually in the DOM, since that is what the matcher rejected.
            if (idleScrolls === 1) {
                dbg(`NO MATCH for ${JSON.stringify(searchTerms)}; skipped ${skippedDone} already-done. Present:`);
                dumpInventory(searchRoot, "dialog/search root");
                if (searchRoot !== document) dumpInventory(document, "whole document");
                dbg(
                    "keyword scan:",
                    KEYWORDS.map((k) => {
                        const n = Array.from(document.querySelectorAll(BTN_SELECTOR)).filter((b) =>
                            ((b.getAttribute("aria-label") || "") + " " + (b.textContent || ""))
                                .toLowerCase()
                                .includes(k),
                        ).length;
                        return `${k}=${n}`;
                    }).join(" "),
                );
            }
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

            const preLabel = labelOf(btn);
            const preText = textOf(btn);

            try {
                simulateTap(btn);
                const result = await verifyInvited(btn, preLabel, preText);

                if (result.ok) {
                    row.classList.add("__inviter-ok");
                    count++;
                    send({ type: "UPDATE_COUNT", count });
                } else {
                    row.classList.add("__inviter-fail");
                    unverifiedTaps++;
                    dbg(`TAP NOT CONFIRMED: "${preLabel || preText}" — ${result.reason}`);
                }
            } catch (e) {
                row.classList.add("__inviter-fail");
                dbg(`tap threw: ${e.message}`);
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
            // Looks done. Recheck slowly before accepting it.
            let grew = false;
            for (let i = 0; i < SETTLE_CHECKS; i++) {
                send({ type: "LOG", message: `Ověřuji konec seznamu (${i + 1}/${SETTLE_CHECKS})…` });
                await sleep(SETTLE_WAIT_MS);
                scrollableElement.scrollTop = scrollableElement.scrollHeight;
                if (scrollableElement.scrollHeight !== heightBefore) {
                    grew = true;
                    break;
                }
            }
            if (!grew) {
                send({ type: "LOG", message: "Konec seznamu." });
                break;
            }
        }
    }

    scrollableElement.classList.remove("__inviter-scroll");
    await stopAwake();

    dbg(`run finished: invited ${count}, unverified ${unverifiedTaps}, stopped=${Boolean(window.__inviter_stop)}`);
    window.__inviter_running = false;
    send({
        type: "FINISHED",
        count,
        stopped: window.__inviter_stop,
        unverifiedTaps,
    });
}
