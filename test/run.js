// Opens Chrome, sized like an iPhone 15, with the extension loaded. Manual testing from here.
// Usage: node run.js [url]

const path = require("path");
const puppeteer = require("puppeteer");

const REPO_ROOT = path.resolve(__dirname, "..");
const VIEWPORT = { width: 393, height: 852, deviceScaleFactor: 3 };

(async () => {
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: path.join(__dirname, "chrome-profile"),
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
            `--disable-extensions-except=${REPO_ROOT}`,
            `--load-extension=${REPO_ROOT}`,
            `--window-size=${VIEWPORT.width},${VIEWPORT.height + 90}`,
        ],
    });

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on("console", (msg) => console.log(`[console.${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
    await page.goto(process.argv[2] || "https://www.facebook.com/", { waitUntil: "domcontentloaded" });
})();
