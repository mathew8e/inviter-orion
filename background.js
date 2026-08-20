// Single source of truth for run state.
//
// This lives in the service worker on purpose: the popup is closed for most
// of a run on a phone, so if it owned the state, a run that finished while
// the popup was shut would never be recorded — leaving isRunning stuck true
// and the history entry lost. Everything that must survive a closed popup
// is handled here.

const IDLE_STATE = {
    isRunning: false,
    count: 0,
    statusText: "Připraveno",
    statusKind: "idle", // idle | running | stopping | done | stopped | error
    runTabId: null,
};

const HISTORY_LIMIT = 20;

// How long to wait for the page to confirm a stop before settling anyway.
const STOP_TIMEOUT_MS = 8000;
let stopWatchdog = null;

function setState(patch) {
    return chrome.storage.local.set(patch);
}

// Callback form is supported everywhere; promise-returning chrome.storage is
// not guaranteed on Orion, which is the browser this actually ships to.
function appendHistory(count, reason) {
    chrome.storage.local.get("invitationHistory", (data) => {
        const history = data.invitationHistory || [];
        history.push({ date: new Date().toISOString(), count, reason });
        chrome.storage.local.set({
            invitationHistory: history.slice(-HISTORY_LIMIT),
        });
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
        case "START":
            setState({
                isRunning: true,
                count: 0,
                statusText: "Spouštím…",
                statusKind: "running",
                runTabId: request.tabId ?? null,
            });
            break;

        case "STOP_REQUEST": {
            // The injected script decides when it actually stops; it reports
            // back with FINISHED. Until then this is only "stopping".
            setState({ statusText: "Zastavuji…", statusKind: "stopping" });

            // ...but never wait forever. If the page can't report back (its
            // messages may not reach us at all on some builds), settle the
            // state anyway so the panel can't sit on "Zastavuji…" until the
            // whole browser is force-quit.
            clearTimeout(stopWatchdog);
            stopWatchdog = setTimeout(() => {
                chrome.storage.local.get(["statusKind", "count"], (data) => {
                    if (data.statusKind !== "stopping") return;
                    setState({
                        isRunning: false,
                        statusText: `Zastaveno. Pozváno ${data.count || 0}.`,
                        statusKind: "stopped",
                        runTabId: null,
                    });
                    appendHistory(data.count || 0, "stopped");
                });
            }, STOP_TIMEOUT_MS);
            break;
        }

        case "UPDATE_COUNT":
            setState({ count: request.count });
            break;

        case "LOG":
            setState({ statusText: request.message });
            break;

        case "FINISHED":
            clearTimeout(stopWatchdog);
            // Idempotent: the popup's poll can report the same finish more
            // than once, and each one must not add its own history row.
            chrome.storage.local.get("isRunning", (data) => {
                if (!data.isRunning) return;
                setState({
                    isRunning: false,
                    count: request.count,
                    statusText: request.stopped
                        ? `Zastaveno. Pozváno ${request.count}.`
                        : `Hotovo. Pozváno ${request.count}.`,
                    statusKind: request.stopped ? "stopped" : "done",
                    runTabId: null,
                });
                appendHistory(request.count, request.stopped ? "stopped" : "done");
            });
            break;

        // The popup found a run marked active whose page is no longer
        // running the script (tab closed, reloaded, or navigated away).
        case "RECONCILE_DEAD_RUN":
            setState({
                isRunning: false,
                statusText: "Běh přerušen. Stránka se znovu načetla?",
                statusKind: "error",
                runTabId: null,
            });
            if (request.count > 0) appendHistory(request.count, "interrupted");
            break;

        case "RESET":
            setState(IDLE_STATE);
            break;

        case "CLEAR_HISTORY":
            chrome.storage.local.set({ invitationHistory: [] });
            break;

        case "GET_STATE":
            chrome.storage.local.get(Object.keys(IDLE_STATE), (data) => sendResponse(data));
            return true; // response is async
    }
});

// A fresh service worker start means no run can still be in flight.
chrome.runtime.onStartup.addListener(() => setState(IDLE_STATE));
chrome.runtime.onInstalled.addListener(() => setState(IDLE_STATE));
