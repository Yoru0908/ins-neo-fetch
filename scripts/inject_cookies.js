#!/usr/bin/env node
/**
 * 将Private API获取的cookies注入到CDP Chrome中
 * 用法: node inject_cookies.js [cookies_json_file]
 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const CDP_URL = "http://localhost:9222";
const COOKIES_FILE = process.argv[2] || "/vol1/ins-neo-fetcher/web_cookies.json";

async function injectCookies() {
    console.log("[" + new Date().toISOString() + "] Starting cookie injection...");

    // 1. 读取cookies
    let cookiesData;
    try {
        const raw = fs.readFileSync(COOKIES_FILE, "utf-8");
        cookiesData = JSON.parse(raw);
    } catch (e) {
        console.error("[ERROR] Cannot read cookies file:", e.message);
        process.exit(1);
    }

    const cookies = cookiesData.cookies || cookiesData;
    if (!cookies.sessionid) {
        console.error("[ERROR] No sessionid in cookies file");
        process.exit(1);
    }

    console.log("[INFO] Cookies loaded:");
    console.log("  sessionid:", cookies.sessionid.substring(0, 20) + "...");
    console.log("  csrftoken:", (cookies.csrftoken || "N/A").substring(0, 20) + "...");
    console.log("  ds_user_id:", cookies.ds_user_id || "N/A");

    // 2. 连接Chrome CDP
    let browser;
    try {
        browser = await puppeteer.connect({ browserURL: CDP_URL });
    } catch (e) {
        console.error("[ERROR] Cannot connect to Chrome CDP:", e.message);
        process.exit(1);
    }

    try {
        const pages = await browser.pages();
        let page = pages.find(p => p.url().includes("instagram.com")) || pages[0];

        // 3. 先清除旧的Instagram cookies
        const client = await page.createCDPSession();
        await client.send("Network.clearBrowserCookies");
        console.log("[INFO] Old cookies cleared");

        // 4. 注入新cookies
        const cookieEntries = [];
        const domain = ".instagram.com";
        const now = Math.floor(Date.now() / 1000);
        const expiry = now + 90 * 24 * 3600; // 90天

        for (const [name, value] of Object.entries(cookies)) {
            if (value && typeof value === "string" && value.length > 0) {
                cookieEntries.push({
                    name,
                    value: decodeURIComponent(value),
                    domain,
                    path: "/",
                    expires: expiry,
                    httpOnly: name === "sessionid",
                    secure: true,
                    sameSite: "None"
                });
            }
        }

        for (const cookie of cookieEntries) {
            await client.send("Network.setCookie", cookie);
        }
        console.log(`[INFO] Injected ${cookieEntries.length} cookies`);

        // 5. 刷新页面使cookies生效
        await page.goto("https://www.instagram.com/", { waitUntil: "networkidle2", timeout: 30000 });

        // 6. 等待并验证
        await new Promise(r => setTimeout(r, 5000));

        const newCookies = await page.cookies("https://www.instagram.com");
        const hasSession = newCookies.some(c => c.name === "sessionid" && c.value.length > 0);

        if (hasSession) {
            console.log("[OK] Cookies injected and verified!");

            // 7. 测试API
            const testResult = await page.evaluate(async () => {
                try {
                    const res = await fetch(
                        "https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram",
                        {
                            method: "GET",
                            headers: {
                                "accept": "*/*",
                                "x-ig-app-id": "936619743392459",
                                "x-asbd-id": "198387",
                                "x-csrftoken": (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || ""
                            }
                        }
                    );
                    return { status: res.status, ok: res.ok };
                } catch (e) {
                    return { error: e.message };
                }
            });

            console.log("[INFO] API test:", JSON.stringify(testResult));

            if (testResult.ok) {
                console.log("[OK] Instagram API working!");
                browser.disconnect();
                return true;
            } else {
                console.log("[WARN] API returned:", testResult.status);
            }
        } else {
            console.log("[FAIL] sessionid not found after injection");
        }

        browser.disconnect();
        return false;

    } catch (error) {
        console.error("[ERROR]", error.message);
        if (browser) browser.disconnect();
        return false;
    }
}

injectCookies().then(ok => process.exit(ok ? 0 : 1));
