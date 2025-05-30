// background.js (v6.1 + CORS Fetch Handler v3 - Retry Logic)
const BUFF_URL_EXACT = "https://buff.163.com";
const BUFF_DOMAIN_TARGET = "buff.163.com";
const SESSION_COOKIE_NAME = "session";
const DEVICE_ID_COOKIE_NAME = "Device-Id";

const MAX_FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 2000; // 2 seconds

console.log(`Buff Price Checker Background Script Loaded (v6.1 + CORS Fetch v3 - Retries: ${MAX_FETCH_ATTEMPTS}x${FETCH_RETRY_DELAY_MS}ms).`);

function checkLastError(context) {
    if (chrome.runtime.lastError) {
        console.error(`BACKGROUND: RUNTIME ERROR in ${context}:`, chrome.runtime.lastError.message);
        return true;
    }
    return false;
}

async function getLiveCookieFromBrowser(name) {
    try {
        const cookie = await chrome.cookies.get({ url: BUFF_URL_EXACT, name: name });
        if (checkLastError(`getLiveCookieFromBrowser: ${name}`)) return null;
        return (cookie && cookie.value) ? cookie.value : null;
    } catch (e) { console.error(`BACKGROUND: EXCEPTION getting LIVE '${name}' cookie:`, e); return null; }
}

async function updateStoredCookie(cookieName, value) {
    const storageKey = cookieName === SESSION_COOKIE_NAME ? 'buffSessionCookie' : 'buffDeviceId';
    if (value) await chrome.storage.local.set({ [storageKey]: value });
    else await chrome.storage.local.remove(storageKey);
    checkLastError(`updateStoredCookie: ${value ? 'set' : 'remove'} ${storageKey}`);
}

async function syncCookies(source = "unknown") {
    const liveSessionValue = await getLiveCookieFromBrowser(SESSION_COOKIE_NAME);
    if (liveSessionValue) await updateStoredCookie(SESSION_COOKIE_NAME, liveSessionValue);
    const liveDeviceIdValue = await getLiveCookieFromBrowser(DEVICE_ID_COOKIE_NAME);
    if (liveDeviceIdValue) await updateStoredCookie(DEVICE_ID_COOKIE_NAME, liveDeviceIdValue);
}

async function aggressiveStartupSync() {
    let sessionFound = false; const maxAttempts = 3; const delayBetweenAttempts = 1000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const liveSessionValue = await getLiveCookieFromBrowser(SESSION_COOKIE_NAME);
        if (liveSessionValue) { await updateStoredCookie(SESSION_COOKIE_NAME, liveSessionValue); sessionFound = true; break; }
        if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, delayBetweenAttempts));
    }
    const liveDeviceIdValue = await getLiveCookieFromBrowser(DEVICE_ID_COOKIE_NAME);
    if (liveDeviceIdValue) await updateStoredCookie(DEVICE_ID_COOKIE_NAME, liveDeviceIdValue);
}

chrome.runtime.onInstalled.addListener(async (details) => { console.log(`BACKGROUND: [onInstalled] Reason: ${details.reason}.`); await aggressiveStartupSync(); });
chrome.runtime.onStartup.addListener(async () => { console.log("BACKGROUND: [onStartup] Browser startup."); await aggressiveStartupSync(); });
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0 && details.url && details.url.startsWith(BUFF_URL_EXACT)) setTimeout(() => syncCookies("webNavigation.onCompleted"), 1000);
}, { url: [{ hostEquals: BUFF_DOMAIN_TARGET }] });
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const { cookie, removed } = changeInfo;
  const isBuffDomain = cookie.domain === BUFF_DOMAIN_TARGET || cookie.domain === `.${BUFF_DOMAIN_TARGET}`;
  if (isBuffDomain && (cookie.name === SESSION_COOKIE_NAME || cookie.name === DEVICE_ID_COOKIE_NAME)) {
    if (!removed) await updateStoredCookie(cookie.name, cookie.value);
  }
});

// Helper function for retrying fetch
async function fetchWithRetries(url, options, attempt = 1) {
    console.log(`BACKGROUND: Attempt ${attempt}/${MAX_FETCH_ATTEMPTS} to fetch ${url.substring(0,100)}...`);
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const text = await response.text().catch(() => "Failed to retrieve error body."); // Get text for better error message
            let specificError = `Network response was not ok. Status: ${response.status}.`;
             if (text) {
                console.warn(`BACKGROUND: fetchWithRetries - Error response Body Preview (Status ${response.status}, Attempt ${attempt}):`, text.substring(0, 300));
                if (text.toLowerCase().includes("login") || text.toLowerCase().includes("buff.163.com/account/login")) specificError = "Login Required (detected from HTML response in background).";
                else if (text.toLowerCase().includes("anti-crawler") || text.toLowerCase().includes("captcha")) specificError = "Anti-crawler/CAPTCHA page detected in background.";
            }
            // Don't retry on specific Buff errors like login/captcha immediately, let popup handle cookie refresh
            if (specificError.includes("Login Required") || specificError.includes("Anti-crawler/CAPTCHA")) {
                throw new Error(specificError); 
            }
            // For generic network errors or server errors (5xx), retry.
            throw new Error(specificError + ` (Attempt ${attempt})`); 
        }
        return await response.json(); // This can throw if body is not JSON
    } catch (error) {
        console.warn(`BACKGROUND: Attempt ${attempt} failed for ${url.substring(0,100)}...: ${error.message}`);
        if (error.message.includes("Login Required") || error.message.includes("Anti-crawler/CAPTCHA")) {
             throw error; // Do not retry these specific errors, propagate immediately
        }
        if (attempt < MAX_FETCH_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
            return fetchWithRetries(url, options, attempt + 1); // Recursive call for next attempt
        } else {
            console.error(`BACKGROUND: All ${MAX_FETCH_ATTEMPTS} fetch attempts failed for ${url.substring(0,100)}... Last error: ${error.message}`);
            throw error; // Re-throw the last error after all attempts exhausted
        }
    }
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getStoredCookies") {
    chrome.storage.local.get(['buffSessionCookie', 'buffDeviceId'], (result) => {
      if (checkLastError("onMessage getStoredCookies")) sendResponse({ error: chrome.runtime.lastError.message });
      else sendResponse({ buffSessionCookie: result.buffSessionCookie, buffDeviceId: result.buffDeviceId });
    });
    return true;
  }

  if (request.action === "clearStoredSessionCookie") {
    updateStoredCookie(SESSION_COOKIE_NAME, null)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === "forceRefreshCookiesFromBrowser") {
    syncCookies("popup.forceRefresh").then(() => {
        chrome.storage.local.get(['buffSessionCookie', 'buffDeviceId'], (result) => {
             if (checkLastError("onMessage forceRefreshCookies")) sendResponse({ success: false, error: "Failed to read storage after refresh." });
             else sendResponse({ success: !!result.buffSessionCookie, buffSessionCookie: result.buffSessionCookie, buffDeviceId: result.buffDeviceId });
        });
    }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === "fetchFromBackground") {
    // console.log("BACKGROUND: Received 'fetchFromBackground' for URL:", request.url.substring(0,100) + "...");
    
    fetchWithRetries(request.url, request.options)
      .then(data => {
        sendResponse({ success: true, data: data });
      })
      .catch(error => {
        // console.error("BACKGROUND: Error after fetchWithRetries for URL:", request.url.substring(0,100) + "...", error.name, error.message);
        sendResponse({ success: false, error: error.message || "Unknown fetch error in background after retries", isNetworkError: true });
      });
    return true;
  }
  return false;
});