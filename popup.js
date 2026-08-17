// The popup only renders state and sends intents. background.js owns the
// truth, so a run that ends while the popup is closed is still recorded.

const el = (id) => document.getElementById(id);

// Callback form is supported everywhere; promise-returning chrome.storage is
// not guaranteed on Orion, which is the browser this actually ships to.
const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
const statusEl = el("status");
const bandTextEl = el("bandText");
const countEl = el("count");
const startBtn = el("startBtn");
const stopBtn = el("stopBtn");
const historyBody = el("historyBody");

const BAND_TEXT = {
    idle: "Připraveno",
    running: "Běží",
    stopping: "Zastavuji",
    done: "Hotovo",
    stopped: "Zastaveno",
    error: "Přerušeno",
};

const TAG_TEXT = { done: "Hotovo", stopped: "Stop", interrupted: "Chyba" };

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

const delaySlider = el("delay");
delaySlider.addEventListener("input", (e) => {
    el("delayValue").textContent = `${String(e.target.value).replace(".", ",")} s`;
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
                num("noButton", 5),
                num("scrollDelay", 500),
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
    await reconcileStaleRun();
    refresh();
});

// --- Injected into the Facebook page -----------------------------------

async function autoInviteAction(inputString, delay, limit, pauseAfter, consecutiveNoNewButtonsMax, scrollDelay) {
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
    // lies. Scroll fast, but once it looks finished, confirm slowly before
    // believing it.
    const SETTLE_WAIT_MS = 2000;
    const SETTLE_CHECKS = 2;

    send({ type: "LOG", message: "Spouštím…" });

    const selectors = [
        'div[aria-label="Pozvat"][role="button"]',
        'div[aria-label^="Pozvat"][role="button"]',
        'div[aria-label="Sledovat"][role="button"]',
        'div[aria-label="Follow"][role="button"]',
        'div[role="button"]', // fallback
    ];

    send({ type: "LOG", message: "Klikni na tlačítko Pozvat, ať vím, kde je seznam." });

    const anchorButton = await new Promise((resolve) => {
        const clickListener = (event) => {
            const targetElement = event.target.closest('div[role="button"], button');
            if (!targetElement) return;

            const label = targetElement.getAttribute("aria-label") || targetElement.textContent || "";
            const keywords = ["invite", "pozvat", "sledovat", "follow"];

            if (keywords.some((k) => label.toLowerCase().includes(k))) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                document.removeEventListener("click", clickListener, true);
                resolve(targetElement);
            }
        };
        document.addEventListener("click", clickListener, true);
    });

    send({ type: "LOG", message: "Mám seznam. Hledám scrollovatelnou oblast…" });

    let scrollableElement = null;
    let originalBorderStyle = "";

    const dialog = anchorButton.closest('div[role="dialog"]');
    if (dialog) {
        let parent = anchorButton.parentElement;
        while (parent && parent !== dialog) {
            const style = window.getComputedStyle(parent);
            if (style.overflowY === "scroll" || style.overflowY === "auto") {
                scrollableElement = parent;
                break;
            }
            parent = parent.parentElement;
        }
        if (!scrollableElement) scrollableElement = dialog;
    } else {
        scrollableElement = document.body;
    }

    originalBorderStyle = scrollableElement.style.border;
    scrollableElement.style.border = "3px solid #DC5314";

    if (typeof window.__inviter_stop === "undefined") window.__inviter_stop = false;
    window.__inviter_running = true;

    let count = 0;
    const maxInvites = limit;
    const pauseAfterInvites = pauseAfter;
    const delaySeconds = delay;
    const scrollWaitMs = scrollDelay;
    let consecutiveNoNewButtons = 0;

    while (!window.__inviter_stop && count < maxInvites) {
        let currentVisibleButtons = [];
        const searchText = inputString.trim().toLowerCase();

        for (const selector of selectors) {
            const found = Array.from(
                document.querySelectorAll(`${selector}:not([data-invited="true"])`),
            ).filter((btn) => (btn.textContent || "").trim().toLowerCase() === searchText);

            if (found.length > 0) {
                currentVisibleButtons = found;
                send({ type: "LOG", message: `Nalezeno ${found.length} tlačítek.` });
                break;
            }
        }

        if (currentVisibleButtons.length === 0) {
            consecutiveNoNewButtons++;
            send({ type: "LOG", message: "Nic nového, scrolluji…" });
        } else {
            consecutiveNoNewButtons = 0;
        }

        for (const btn of currentVisibleButtons) {
            if (window.__inviter_stop || count >= maxInvites) break;

            btn.dataset.invited = "true";

            // Invite pacing stays conservative — this is the rate-limit
            // surface (NOTES.md #3), not the scrolling.
            await sleep(Math.random() * delaySeconds * 1000 + 500);

            btn.scrollIntoView({ block: "center" });
            await sleep(80);

            if (!document.body.contains(btn)) continue;

            try {
                btn.click();
                btn.style.backgroundColor = "#3F7A4A";
                count++;
                send({ type: "UPDATE_COUNT", count });
            } catch {
                btn.style.backgroundColor = "#A32F28";
            }

            if (count > 0 && count % pauseAfterInvites === 0) {
                send({ type: "LOG", message: `Pauza 30 s po ${count} pozvánkách.` });
                await sleep(30000);
            }
        }

        const heightBefore = scrollableElement.scrollHeight;
        scrollableElement.scrollTop = scrollableElement.scrollHeight;
        await sleep(scrollWaitMs);

        if (
            scrollableElement.scrollHeight === heightBefore &&
            consecutiveNoNewButtons > consecutiveNoNewButtonsMax
        ) {
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

    scrollableElement.style.border = originalBorderStyle;
    window.__inviter_running = false;
    send({ type: "FINISHED", count, stopped: window.__inviter_stop });
}
