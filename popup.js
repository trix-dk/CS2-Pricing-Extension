// popup.js

// --- Constants and Global Variables ---
const CS2_MARKETPLACE_IDS_URL = 'https://raw.githubusercontent.com/ModestSerhat/cs2-marketplace-ids/refs/heads/main/cs2_marketplaceids.json';
const EXCHANGE_RATE_API_URL = 'https://api.frankfurter.app/latest?from=CNY&to=USD';

const BUFF_GAME = 'csgo';
const BUFF_PAGE_NUM = 1;
const BUFF_SELL_ORDER_API_BASE = 'https://buff.163.com/api/market/goods/sell_order';

let items = [];
let savedItems = [];
let itemList = []; // Stores items from batch input
let currentIndex = 0; // Current index for processing itemList
let fuseInstance;

let cnyToUsdRate = null;
let buffSessionCookie = null;
let buffDeviceId = null;

const ONE_DAY_IN_SECONDS = 24 * 60 * 60;
let priceFetchQueue = {};

// --- UI Helper Functions ---
function showCookieWarning(message) {
  const warningDiv = document.getElementById('cookieWarning');
  if (!warningDiv) {
    console.error("POPUP_CRITICAL: cookieWarning div not found!");
    return;
  }
  warningDiv.innerHTML = message;
  warningDiv.style.display = 'block';

  // Defer finding and attaching listener to the button
  setTimeout(() => {
    const retryButton = document.getElementById('retryCookieButton');
    if (retryButton) {
      const newRetryButton = retryButton.cloneNode(true); // Clone to remove old listeners
      if (retryButton.parentNode) {
            retryButton.parentNode.replaceChild(newRetryButton, retryButton);
      } else {
            console.warn("POPUP_DEBUG: retryButton found but parentNode is null.");
            warningDiv.appendChild(newRetryButton);
      }
      newRetryButton.addEventListener('click', () => {
        warningDiv.innerHTML = "Attempting to get latest cookies from Buff (ensure a Buff tab is open/active)...";
        chrome.runtime.sendMessage({ action: "forceRefreshCookiesFromBrowser" }, (response) => {
          if (chrome.runtime.lastError) {
            console.error("POPUP: Error during 'forceRefreshCookiesFromBrowser' call (runtime.lastError):", chrome.runtime.lastError.message);
            showCookieWarning(`Error refreshing. Ensure Buff tab is open and you're logged in. <button id="retryCookieButton" style="margin-left:5px;padding:2px 5px;background-color:#555;color:white;border:1px solid #777;border-radius:3px;cursor:pointer;">Retry</button>`);
          } else if (response && response.success && response.buffSessionCookie) {
            buffSessionCookie = response.buffSessionCookie;
            buffDeviceId = response.buffDeviceId;
            hideCookieWarning();
            savedItems.forEach(item => {
              if (item.goods_id && (item.isLoadingPrice || item.priceError)) {
                  const queueKey = `${item.goods_id}_${item.tag_id || 'base'}`;
                  if (!priceFetchQueue[queueKey]) queuePriceFetchForCartItem(item, queueKey);
              }
            });
          } else {
            showCookieWarning(`Still no session cookie. <a href="https://buff.163.com" target="_blank" rel="noopener noreferrer" style="color:#fbbf24;">Visit Buff.163.com</a>, log in, then <button id="retryCookieButton" style="margin-left:5px;padding:2px 5px;background-color:#555;color:white;border:1px solid #777;border-radius:3px;cursor:pointer;">Retry</button>`);
          }
        });
      });
    }
  }, 0);
}
function hideCookieWarning() {
    const warningDiv = document.getElementById('cookieWarning');
    if (warningDiv) warningDiv.style.display = 'none';
}

// --- Buff & Currency API Functions ---
async function fetchExchangeRate() {
  if (cnyToUsdRate !== null) return;
  try {
    const response = await fetch(EXCHANGE_RATE_API_URL);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    if (data?.rates?.USD) cnyToUsdRate = data.rates.USD;
    else { console.error('POPUP: Could not fetch valid exchange rate data.', data); cnyToUsdRate = null; }
  } catch (error) { console.error('POPUP: Error fetching exchange rate:', error.message); cnyToUsdRate = null; }
}
function convertCnyToUsd(cnyAmount) {
  if (cnyToUsdRate === null || typeof cnyAmount !== 'number') return null;
  return parseFloat((cnyAmount * cnyToUsdRate).toFixed(2));
}

async function fetchLiveBuffPrice(item) {
  const itemName = item.originalName; const goods_id = item.goods_id; const tag_id = item.tag_id;
  const returnError = (errorMessage) => ({ name: itemName, goods_id: goods_id, tag_id: tag_id, price: null, error: errorMessage });

  if (!goods_id) return returnError('Missing goods_id.');
  if (!buffSessionCookie) {
    showCookieWarning(`Buff session cookie not found. Please <a href="https://buff.163.com" target="_blank" rel="noopener noreferrer" style="color: #fbbf24;">visit Buff.163.com</a>, log in, then click <button id="retryCookieButton" style="margin-left:5px;padding:2px 5px;background-color:#555;color:white;border:1px solid #777;border-radius:3px;cursor:pointer;">Retry</button> to refresh cookies.`);
    return returnError('Session cookie missing.');
  }
  if (cnyToUsdRate === null) { await fetchExchangeRate(); if (cnyToUsdRate === null) return returnError('Exchange rate unavailable.'); }

  let requestUrl = `${BUFF_SELL_ORDER_API_BASE}?game=${BUFF_GAME}&goods_id=${goods_id}&page_num=${BUFF_PAGE_NUM}&sort_by=price.asc&allow_tradable_cooldown=1`;
  if (tag_id && !isNaN(parseInt(tag_id))) requestUrl += `&tag_ids=${tag_id}`;
  requestUrl += `&_=${Date.now()}`;

  const COOKIE_STRING = `session=${buffSessionCookie};${buffDeviceId ? ` Device-Id=${buffDeviceId};` : ''}Locale-Supported=en; game=csgo;`;
  const BUFF_HEADERS = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': `https://buff.163.com/goods/${goods_id}?game=${BUFF_GAME}${tag_id ? `&tag_ids=${tag_id}` : ''}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest', 'Cookie': COOKIE_STRING
  };

  try {
    const responseData = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "fetchFromBackground", url: requestUrl, options: { headers: BUFF_HEADERS } },
        (response) => {
          if (chrome.runtime.lastError) return reject(new Error(`Runtime Error: ${chrome.runtime.lastError.message}`));
          
          if (response && response.success && response.data) {
            if (response.data.code && response.data.code !== "OK" && response.data.code !== "SUCCESS") {
              let apiErrorMsg = `Buff API: ${response.data.error || response.data.code}`;
              console.warn(`POPUP: Buff API returned error for ${itemName}: Code: ${response.data.code}, Msg: ${response.data.error}`);
              
              if (response.data.code === "Invalid Argument" && response.data.error === "Not a valid choice") {
                 apiErrorMsg = `Buff API: ${response.data.error}`; // More specific for this case
              } else if (response.data.error && (response.data.error.toLowerCase().includes("login") || response.data.error.toLowerCase().includes("session"))) {
                showCookieWarning(`Buff API session error: "${response.data.error}". Please <a href="https://buff.163.com" target="_blank" rel="noopener noreferrer" style="color: #fbbf24;">check Buff.163.com</a>, then click <button id="retryCookieButton" style="margin-left:5px;padding:2px 5px;background-color:#555;color:white;border:1px solid #777;border-radius:3px;cursor:pointer;">Retry</button>.`);
              }
              return reject(new Error(apiErrorMsg));
            }
            resolve(response.data);
          } else if (response && !response.success) {
            let errMsg = (response && response.error) || "Unknown error from background fetch";
            if (typeof errMsg !== 'string' && errMsg.message) errMsg = errMsg.message;
            else if (typeof errMsg !== 'string') errMsg = JSON.stringify(errMsg);
            const err = new Error(errMsg);
            if(response && response.isNetworkError) err.isNetworkError = true;
            return reject(err);
          } else {
            return reject(new Error("Unexpected response from background script."));
          }
        }
      );
    });

    const buffSellOrders = responseData.data?.items;
    
    if (buffSellOrders && buffSellOrders.length > 0) {
      const sellMinPriceCNY = parseFloat(buffSellOrders[0].price);
      if (isNaN(sellMinPriceCNY)) return { name: itemName, goods_id: goods_id, tag_id: tag_id, price: null, error: 'Buff price N/A (NaN)' };
      const sellMinPriceUSD = convertCnyToUsd(sellMinPriceCNY);
      return { name: itemName, goods_id: goods_id, tag_id: tag_id, price: sellMinPriceUSD ?? null, cnyPrice: sellMinPriceCNY, error: sellMinPriceUSD === null ? 'USD conversion failed' : null };
    }
    
    let noOrdersMsg = `No sell orders on Buff`;
    const totalCount = responseData.data?.total_count;
    if (totalCount !== undefined) noOrdersMsg += ` (Count: ${totalCount})`;
    if (responseData.code && responseData.code !== "OK" && responseData.code !== "SUCCESS") {
        // This was handled by the reject(new Error(apiErrorMsg)) above, but as a fallback:
        noOrdersMsg = `Buff API: ${responseData.error || responseData.code}`;
    } else if (!responseData.data && !responseData.items && (!responseData.code || (responseData.code === "OK" || responseData.code === "SUCCESS"))) {
      noOrdersMsg += ` (Empty data structure)`;
    }
    
    return returnError(noOrdersMsg);

  } catch (error) {
    console.error(`POPUP: Error in fetchLiveBuffPrice for ${itemName} (${goods_id || 'N/A'}):`, error.message);
    
    if (error.message && (error.message.includes('Login Required') || error.message.includes('Anti-crawler') || error.message.includes('Buff API session error'))) {
        // Cookie warning likely already shown
    } else if (error.message && error.message.includes('Network response was not ok')) {
         showCookieWarning(`Buff API network error: "${error.message}". Please <a href="https://buff.163.com" target="_blank" rel="noopener noreferrer" style="color: #fbbf24;">check Buff.163.com</a>, then click <button id="retryCookieButton" style="margin-left:5px;padding:2px 5px;background-color:#555;color:white;border:1px solid #777;border-radius:3px;cursor:pointer;">Retry</button>.`);
    }
    // For other errors, including "Buff API: Invalid Argument", "Buff API: Not a valid choice"
    return returnError(error.message);
  }
}

// --- Item Data and Search Initialization ---
const normalizeName = (name) => name.replace(/★/g, '').replace(/StatTrak™/g, 'ST').replace(/\|/g, '').replace(/\(([^)]+)\)/g, ' $1').replace(/\s+/g, ' ').trim().toLowerCase();

const processMarketplaceIdsJson = (jsonData) => {
    const processedItems = []; const seenCompositeKeys = new Set();
    const itemsToProcess = jsonData.items;
    if (!itemsToProcess || typeof itemsToProcess !== 'object') {
        console.error("POPUP_CRITICAL: jsonData.items is not an object or is missing. Type:", typeof itemsToProcess); items = []; return;
    }
    if (Object.keys(itemsToProcess).length === 0) { items = []; return; }

    for (const marketHashName in itemsToProcess) {
        const itemData = itemsToProcess[marketHashName];
        if (!itemData || !itemData.buff163_goods_id) continue;
        const baseGoodsId = parseInt(itemData.buff163_goods_id, 10);
        if (isNaN(baseGoodsId)) continue;

        const originalItemNameFromKey = marketHashName;
        const wearMatch = originalItemNameFromKey.match(/\(([^)]+)\)$/);
        const wearStr = wearMatch ? ` (${wearMatch[1]})` : '';
        const nameNoWear = wearMatch ? originalItemNameFromKey.substring(0, wearMatch.index).trim() : originalItemNameFromKey;
        let variantsProcessedFlag = false;

        if (itemData.buff163_phase_ids) {
            for (const phaseKey in itemData.buff163_phase_ids) {
                const phaseTagId = parseInt(itemData.buff163_phase_ids[phaseKey], 10);
                if (isNaN(phaseTagId) || phaseTagId === null) continue;
                let phaseDisplayName = nameNoWear;
                if (nameNoWear.includes("Doppler") && !nameNoWear.includes(phaseKey)) phaseDisplayName = nameNoWear.replace("Doppler", `Doppler (${phaseKey})`);
                else if (nameNoWear.includes("Gamma Doppler") && !nameNoWear.includes(phaseKey)) phaseDisplayName = nameNoWear.replace("Gamma Doppler", `Gamma Doppler (${phaseKey})`);
                else if (!nameNoWear.toLowerCase().includes(phaseKey.toLowerCase())) phaseDisplayName = `${nameNoWear} (${phaseKey})`;
                phaseDisplayName += wearStr;
                const compositeKey = `${baseGoodsId}_${phaseTagId}`;
                if (!seenCompositeKeys.has(compositeKey)) {
                    processedItems.push({ market_hash_name: phaseDisplayName, goods_id: baseGoodsId, tag_id: phaseTagId, originalName: phaseDisplayName, searchName: normalizeName(phaseDisplayName) });
                    seenCompositeKeys.add(compositeKey);
                }
            } variantsProcessedFlag = true;
        }
        if (itemData.buff163_paintseed_group_ids && itemData.buff163_paintseed_group_ids["Blue Gem"]) {
            const blueGemTagId = parseInt(itemData.buff163_paintseed_group_ids["Blue Gem"], 10);
            if (!isNaN(blueGemTagId) && blueGemTagId !== null) {
                let blueGemDisplayName = nameNoWear;
                if (nameNoWear.includes("Case Hardened") && !nameNoWear.includes("Blue Gem")) blueGemDisplayName = nameNoWear.replace("Case Hardened", "Case Hardened (Blue Gem)");
                else if (!nameNoWear.toLowerCase().includes("blue gem")) blueGemDisplayName = `${nameNoWear} (Blue Gem)`;
                blueGemDisplayName += wearStr;
                const compositeKey = `${baseGoodsId}_${blueGemTagId}`;
                if (!seenCompositeKeys.has(compositeKey)) {
                    processedItems.push({ market_hash_name: blueGemDisplayName, goods_id: baseGoodsId, tag_id: blueGemTagId, originalName: blueGemDisplayName, searchName: normalizeName(blueGemDisplayName) });
                    seenCompositeKeys.add(compositeKey);
                }
            } variantsProcessedFlag = true;
        }
        if (!variantsProcessedFlag) {
            const compositeKey = `${baseGoodsId}_base`;
            if (!seenCompositeKeys.has(compositeKey)) {
                processedItems.push({ market_hash_name: originalItemNameFromKey, goods_id: baseGoodsId, tag_id: null, originalName: originalItemNameFromKey, searchName: normalizeName(originalItemNameFromKey) });
                seenCompositeKeys.add(compositeKey);
            }
        }
    }
    items = processedItems;
    if (items.length === 0 && Object.keys(itemsToProcess).length > 0) console.error("POPUP_CRITICAL: processMarketplaceIdsJson resulted in zero items, but jsonData.items was not empty.");
};

const fetchItemDataFromNewSource = () => {
  const resultsDiv = document.getElementById('results');
  if (resultsDiv) resultsDiv.innerHTML = '<div style="color: #fbbf24; padding: 10px;">Loading item list...</div>';
  fetch(CS2_MARKETPLACE_IDS_URL)
    .then(response => {
      if (!response.ok) {
        const errorMsg = `HTTP error fetching item list! Status: ${response.status}`;
        return response.text().then(text => { throw new Error(errorMsg + (text ? ` - Body: ${text.substring(0,100)}...` : '')); });
      } return response.json();
    })
    .then(jsonData => {
      if (typeof jsonData !== 'object' || jsonData === null || Object.keys(jsonData).length === 0 || !jsonData.items) {
        console.error("POPUP: Fetched JSON data is invalid or empty at root or 'items' key missing."); items = [];
      } else { processMarketplaceIdsJson(jsonData); }
      if (items.length > 0) {
        chrome.storage.local.set({ processedMarketItemsCache: items, marketItemsLastFetch: Math.floor(Date.now() / 1000) });
        if (resultsDiv) resultsDiv.innerHTML = '';
      } else {
        console.error("POPUP: Item list is empty after processing. Search will not work.");
        if (resultsDiv) resultsDiv.innerHTML = '<div style="color: #f87171; padding: 10px;">Failed to load item list. List is empty.</div>';
      }
      fuseInstance = initializeSearch(); updateListDisplay(); updateSavedList();
    })
    .catch(err => {
      console.error('POPUP: Catch block - Error during fetch/JSON parsing of CS2 IDs list:', err.message);
      showCookieWarning(`Error fetching item data: ${err.message}. Check console.`);
      if (resultsDiv) resultsDiv.innerHTML = `<div style="color: #f87171; padding: 10px;">Error fetching items: ${err.message}. Trying cache...</div>`;
      chrome.storage.local.get(['processedMarketItemsCache'], (res) => {
        if (chrome.runtime.lastError || !res.processedMarketItemsCache?.length) {
          items = []; console.warn("POPUP: Fetch error & no valid cache. Item list is empty.");
          if (resultsDiv) resultsDiv.innerHTML = `<div style="color: #f87171; padding: 10px;">Error fetching & no cache. List empty.</div>`;
        } else {
          items = res.processedMarketItemsCache; console.warn(`POPUP: Using cached item data. Cache length: ${items.length}`);
          showCookieWarning("Failed to update item data. Using cache (might be outdated).");
          if (resultsDiv) resultsDiv.innerHTML = '';
        }
        fuseInstance = initializeSearch(); updateListDisplay(); updateSavedList();
      });
    });
};

const initializeSearch = () => {
  if (!items || items.length === 0) return null;
  fuseInstance = new Fuse(items, { keys: ['searchName', 'originalName'], threshold: 0.2, distance: 100, includeScore: true, ignoreLocation: true, minMatchCharLength: 2 });
  const searchInput = document.getElementById('searchInput');
  const debouncedSearch = debounce((value) => {
    if (!fuseInstance) return;
    displayResults(fuseInstance.search(value).slice(0, 10));
  }, 50);
  searchInput.addEventListener('input', (e) => {
    if (e.target.value.length > 1) {
        debouncedSearch(e.target.value);
    } else {
        const resultsDiv = document.getElementById('results');
        if (resultsDiv) resultsDiv.innerHTML = '';
    }
  });
  return fuseInstance;
};

const displayResults = (fuseResults) => {
  const container = document.getElementById('results');
  if (!container) return;
  if (!fuseResults || fuseResults.length === 0) {
    container.innerHTML = '<div style="color: #9ca3af; padding: 10px;">No matching skins found.</div>';
    return;
  }
  container.innerHTML = fuseResults.map(result => `
      <div class="result-item" data-item='${JSON.stringify(result.item)}' title="Click to add: ${result.item.originalName}">
        <span class="result-item-name">${result.item.originalName}</span><span class="result-item-status"></span>
      </div>`).join('');

  document.querySelectorAll('.result-item').forEach(itemElement => {
    itemElement.addEventListener('click', (e) => {
      const currentItemEl = e.currentTarget;
      if (!currentItemEl) return;
      const itemDataString = currentItemEl.dataset.item;
      if (!itemDataString) return;
      const itemObject = JSON.parse(itemDataString);
      const statusSpan = currentItemEl.querySelector('.result-item-status');

      if (currentItemEl.classList.contains('processing-click')) return;
      currentItemEl.classList.add('processing-click');

      addToSavedItems({ ...itemObject, price: null, isLoadingPrice: true, quantity: 1 });
      if (statusSpan) {
        statusSpan.textContent = 'Added (loading price)...';
        statusSpan.style.color = '#fbbf24';
      }
      
      const commonTimeoutLogic = () => {
          if (statusSpan) statusSpan.textContent = '';
          if (currentItemEl) currentItemEl.classList.remove('processing-click');
      };

      if (itemList.length > 0) {
        setTimeout(() => {
          commonTimeoutLogic();
          nextItem();
        }, 50);
      } else {
        setTimeout(commonTimeoutLogic, 1500);
      }
    });
  });
};

const addToSavedItems = (itemToAdd) => {
  const existingIdx = savedItems.findIndex(i => i.goods_id === itemToAdd.goods_id && (i.tag_id || null) === (itemToAdd.tag_id || null));
  if (existingIdx !== -1) {
    savedItems[existingIdx].quantity = (savedItems[existingIdx].quantity || 1) + 1;
  } else {
    savedItems.push(itemToAdd);
  }
  const queueKey = `${itemToAdd.goods_id}_${itemToAdd.tag_id || 'base'}`;
  if (itemToAdd.isLoadingPrice && !priceFetchQueue[queueKey]) {
    queuePriceFetchForCartItem(itemToAdd, queueKey);
  }
  chrome.storage.local.set({ savedItems });
  updateSavedList();
};

async function queuePriceFetchForCartItem(cartItem, queueKey) {
  if (priceFetchQueue[queueKey]) return;
  priceFetchQueue[queueKey] = true;
  const priceData = await fetchLiveBuffPrice(cartItem);
  const itemInCart = savedItems.find(i => i.goods_id === cartItem.goods_id && (i.tag_id || null) === (cartItem.tag_id || null));
  if (itemInCart) {
    if (priceData && !priceData.error && typeof priceData.price === 'number') {
      itemInCart.price = priceData.price;
      itemInCart.name = priceData.name || cartItem.originalName;
      itemInCart.isLoadingPrice = false;
      itemInCart.priceError = null;
    } else {
      itemInCart.price = null; // Keep null for errors or non-numeric prices
      itemInCart.isLoadingPrice = false;
      itemInCart.priceError = priceData.error || 'Fetch failed';
      console.error(`POPUP: Failed to update price for cart item: ${itemInCart.originalName} (key ${queueKey}) - Error: ${itemInCart.priceError}`);
    }
    chrome.storage.local.set({ savedItems });
    updateSavedList();
  }
  delete priceFetchQueue[queueKey];
}

const updateSavedList = () => {
  const container = document.getElementById('savedItems');
  const totalEl = document.getElementById('total');
  const adjTotalEl = document.getElementById('adjustedTotal');
  const percIn = document.getElementById('percentageInput');
  if(!container || !totalEl || !adjTotalEl || !percIn) return;

  container.innerHTML = savedItems.map((item, index) => `
    <div class="saved-item" data-goods-id="${item.goods_id}" data-tag-id="${item.tag_id || ''}">
      <div class="saved-name" title="${item.originalName}">${item.originalName}</div>
      <div class="saved-price">
        <div class="quantity-controls">
          <button class="quantity-btn decrease" data-index="${index}">-</button>
          <span class="quantity">${item.quantity||1}</span>
          <button class="quantity-btn increase" data-index="${index}">+</button>
        </div>
        ${item.isLoadingPrice ? '<span class="loading-price saved-value">Loading...</span>' :
          item.priceError ? `<span class="saved-value" style="color:#ef4444;" title="${item.priceError}">${item.priceError.substring(0,25)}${item.priceError.length > 25 ? '...' : ''}</span>` :
          (item.price === null) ? '<span class="loading-price saved-value">N/A</span>' : // Explicitly N/A if price is null and no error
          `<span class="saved-value">$${(item.price * (item.quantity||1)).toFixed(2)}</span>`}
      </div>
    </div>`).join('');

  const total = savedItems.reduce((s, i) => (i.price !== null && !i.isLoadingPrice && !i.priceError) ? s + (i.price*(i.quantity||1)) : s, 0);
  totalEl.textContent = total.toFixed(2);
  const perc = parseFloat(percIn.value) || 100;
  adjTotalEl.textContent = ((total * perc) / 100).toFixed(2);

  document.querySelectorAll('.quantity-btn').forEach(b => {
    const newB = b.cloneNode(true);
    if(b.parentNode) b.parentNode.replaceChild(newB, b);
    newB.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index);
      if (!savedItems[idx]) return;
      if (e.target.classList.contains('increase')) {
        savedItems[idx].quantity = (savedItems[idx].quantity||1)+1;
      } else if (e.target.classList.contains('decrease')) {
        if (savedItems[idx].quantity > 1) {
          savedItems[idx].quantity--;
        } else {
          savedItems.splice(idx, 1);
        }
      }
      chrome.storage.local.set({savedItems});
      updateSavedList();
    });
  });
};
document.getElementById('clearAll').addEventListener('click', () => {
  savedItems = [];
  priceFetchQueue = {};
  chrome.storage.local.set({savedItems});
  updateSavedList();
});
document.getElementById('percentageInput').addEventListener('input', updateSavedList);

document.getElementById('copyCartBtn').addEventListener('click', () => {
    let cartListText = "";
    let currentOverallTotal = 0;
    savedItems.forEach(item => {
        const itemName = item.originalName;
        const itemIndividualPrice = (item.price !== null && !item.isLoadingPrice && !item.priceError) ? item.price : 0;
        const priceString = item.isLoadingPrice ? 'Loading...' : (item.priceError ? `Error (${item.priceError.substring(0,20)}...)` : (item.price !== null ? `$${itemIndividualPrice.toFixed(2)}` : 'N/A'));
        const quantity = item.quantity || 1;
        for (let i = 0; i < quantity; i++) {
            cartListText += `${itemName} - ${priceString}\n`;
        }
        if (!item.isLoadingPrice && !item.priceError && item.price !== null) {
            currentOverallTotal += itemIndividualPrice * quantity;
        }
    });
    let summaryText = `\n------------------------------------\nSubtotal: $${currentOverallTotal.toFixed(2)}\n`;
    const percentage = parseFloat(document.getElementById('percentageInput').value) || 100;
    summaryText += `Percentage: ${percentage}%\nAdjusted Total: $${((currentOverallTotal * percentage) / 100).toFixed(2)}`;
    const finalCartText = cartListText + summaryText;

    navigator.clipboard.writeText(finalCartText).then(() => {
        const cb = document.getElementById('copyCartBtn');
        const ot = cb.textContent;
        cb.textContent = 'Copied!';
        cb.style.backgroundColor = '#10b981';
        setTimeout(() => {
            cb.textContent = ot;
            cb.style.backgroundColor = '#38bdf8';
        }, 2000);
    }).catch(err => {
        console.error('POPUP: Failed to copy to clipboard:', err);
    });
});

const loadItemList = () => {
  itemList = document.getElementById('batchInput').value.split('\n').map(l => l.trim()).filter(l => l);
  currentIndex = 0;
  updateListDisplay();

  const searchInputEl = document.getElementById('searchInput');
  const resultsDiv = document.getElementById('results');

  if (itemList.length > 0) {
    if (resultsDiv) {
        resultsDiv.innerHTML = '<div style="color: #9ca3af; padding: 10px;">Loading results for ' + itemList[0].substring(0,30) + '...</div>';
    }
    if (searchInputEl) {
        searchInputEl.value = itemList[0];
        searchInputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else {
    if (searchInputEl) searchInputEl.value = '';
    if (resultsDiv) resultsDiv.innerHTML = '';
  }
};

const nextItem = () => {
  currentIndex++;
  updateListDisplay();

  const searchInputEl = document.getElementById('searchInput');
  const resultsDiv = document.getElementById('results');

  if (itemList.length > 0 && currentIndex < itemList.length) {
    if (resultsDiv) {
      resultsDiv.innerHTML = '<div style="color: #9ca3af; padding: 10px;">Loading results for ' + itemList[currentIndex].substring(0,30) + '...</div>';
    }
    if (searchInputEl) {
      searchInputEl.value = itemList[currentIndex];
      searchInputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (itemList.length > 0 && currentIndex >= itemList.length) {
    if (searchInputEl) searchInputEl.value = '';
    if (resultsDiv) resultsDiv.innerHTML = '';
  }
};

const updateListDisplay = () => {
  const p = document.getElementById('listProgress');
  if (!p) return;
  if (itemList.length > 0 && currentIndex < itemList.length) {
    p.textContent = `Item ${currentIndex + 1}/${itemList.length}: ${itemList[currentIndex]}`;
  } else if (itemList.length > 0 && currentIndex >= itemList.length) {
    p.textContent = 'All items processed!';
  } else {
    p.textContent = 'No items in batch list.';
  }
};

document.getElementById('loadList').addEventListener('click', loadItemList);

const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
};

async function initializePopup() {
  const cookieData = await new Promise(resolve =>
    chrome.runtime.sendMessage({action:"getStoredCookies"}, response =>
      resolve(chrome.runtime.lastError || !response ? {error:chrome.runtime.lastError?.message||"No response"} : response)
    )
  );
  buffSessionCookie = cookieData.buffSessionCookie;
  buffDeviceId = cookieData.buffDeviceId;

  const storage = await chrome.storage.local.get(['savedItems', 'processedMarketItemsCache', 'marketItemsLastFetch']);
  savedItems = storage.savedItems || [];
  savedItems.forEach(item => {
    if (item.goods_id && (item.isLoadingPrice || item.priceError)) {
        const queueKey = `${item.goods_id}_${item.tag_id||'base'}`;
        if (!priceFetchQueue[queueKey]) queuePriceFetchForCartItem(item, queueKey);
    }
  });

  if (!buffSessionCookie) {
    showCookieWarning(`Buff session cookie not found. Please <a href="https://buff.163.com" target="_blank" rel="noopener noreferrer" style="color:#fbbf24;">Visit Buff.163.com</a> (log in), then click <button id="retryCookieButton" style="margin-left:5px;padding:2px 5px;background-color:#555;color:white;border:1px solid #777;border-radius:3px;cursor:pointer;">Retry</button> to refresh cookies.`);
  } else {
    hideCookieWarning();
  }

  await fetchExchangeRate();

  const cachedMarketItems = storage.processedMarketItemsCache || [];
  const lastFetchTimestamp = storage.marketItemsLastFetch || 0;

  if (cachedMarketItems.length > 0 && (Math.floor(Date.now()/1000) - lastFetchTimestamp < ONE_DAY_IN_SECONDS)) {
    items = cachedMarketItems;
    fuseInstance = initializeSearch();
    updateListDisplay();
    updateSavedList();
  } else {
    fetchItemDataFromNewSource();
  }
}

document.addEventListener('DOMContentLoaded', initializePopup);
