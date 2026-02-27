console.log("[GetBnBInvoice] Background service worker started.");

const MAX_BATCH_SIZE = 25;
const DELAY_BETWEEN_RESERVATIONS = 2000;
const PAGE_LOAD_TIMEOUT = 15000;
const MAX_RETRIES = 1;
let abortRequested = false;

// Credit system — update URLs after deploying
const API_URLS = {
  useCredit: "https://europe-west1-getbnbinvoice.cloudfunctions.net/useCredit",
};

async function useCredit(reservationCode) {
  const { licenseKey } = await chrome.storage.local.get("licenseKey");
  if (!licenseKey) throw new Error("no_license");
  const res = await fetch(API_URLS.useCredit, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: licenseKey, reservation_code: reservationCode }),
  });
  if (!res.ok && res.status >= 500) throw new Error("server_error");
  const data = await res.json();
  if (data.error === "no_credits") throw new Error("no_credits");
  if (data.error === "invalid_key") throw new Error("invalid_key");
  if (data.error) throw new Error(data.error);
  return data.remaining;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "printToPDF") {
    handlePrintToPDF(message.code, message.domain)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "batchDownload") {
    abortRequested = false;
    handleBatchDownload(message.codes, message.domain)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "abortBatch") {
    abortRequested = true;
    sendResponse({ success: true });
    return true;
  }
});

// --- Batch download ---

async function handleBatchDownload(codes, domain) {
  if (codes.length > MAX_BATCH_SIZE) {
    codes = codes.slice(0, MAX_BATCH_SIZE);
  }

  const total = codes.length;
  const results = [];

  for (let i = 0; i < total; i++) {
    const code = codes[i];

    // Notify popup of progress
    notifyPopup({
      action: "progress",
      current: i + 1,
      total,
      code,
      status: "downloading",
    });

    if (abortRequested) {
      console.log(`[GetBnBInvoice] Batch aborted at reservation ${i + 1} of ${total}`);
      notifyPopup({ action: "progress", current: i, total, code, status: "cancelled" });
      break;
    }

    // Try with retry
    let result;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await handlePrintToPDF(code, domain);
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          console.log(`[GetBnBInvoice] Retry ${attempt + 1} for ${code}: ${err.message}`);
          await sleep(1000);
        } else {
          result = { success: false, error: err.message };
        }
      }
    }

    // Deduct credit only after successful download
    if (result.success) {
      try {
        const remaining = await useCredit(code);
        notifyPopup({ action: "creditUpdate", remaining });
      } catch (creditErr) {
        if (creditErr.message === "no_credits") {
          // Download succeeded but can't deduct — still count it (user got a freebie)
          results.push({ code, ...result });
          const succeeded = results.filter((r) => r.success).length;
          notifyPopup({
            action: "batchComplete",
            total,
            succeeded,
            failed: 0,
            errors: [],
            error: `Out of credits after ${i + 1} of ${total} reservations`,
          });
          return { success: true, total: i + 1, succeeded, failed: 0, results };
        }
        // Other credit errors — download succeeded, log warning but count as success
        console.warn(`[GetBnBInvoice] Credit deduction failed for ${code}: ${creditErr.message}`);
      }
    }
    results.push({ code, ...result });

    // Delay between reservations (except after the last one)
    if (i < total - 1) {
      await sleep(DELAY_BETWEEN_RESERVATIONS);
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  notifyPopup({
    action: "batchComplete",
    total: results.length,
    succeeded,
    failed,
    errors: results.filter(r => !r.success).map(r => `${r.code}: ${r.error}`),
  });

  return { success: true, total: results.length, succeeded, failed, results };
}

// --- Single reservation download ---

async function handlePrintToPDF(code, domain) {
  const url = `https://${domain}/hosting/reservations/details/${code}`;
  console.log(`[GetBnBInvoice] Opening reservation: ${url}`);

  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await waitForTabLoad(tab.id);
    await sleep(3000);

    // 1. Print reservation receipt
    const receiptPdf = await capturePageAsPDF(tab.id);
    const receiptFilename = `Reservation_${code}.pdf`;
    await downloadPDF(receiptPdf, receiptFilename);
    console.log(`[GetBnBInvoice] Downloaded: ${receiptFilename}`);

    // 2. Find VAT invoice link(s) on the detail page
    const invoiceLinks = await findInvoiceLinks(tab.id);
    const invoiceFilenames = [];

    if (invoiceLinks.length === 0) {
      console.log(`[GetBnBInvoice] No VAT invoices found for ${code}`);
    }

    for (let i = 0; i < invoiceLinks.length; i++) {
      const invoiceUrl = invoiceLinks[i];
      console.log(`[GetBnBInvoice] Opening invoice: ${invoiceUrl}`);

      await chrome.tabs.update(tab.id, { url: invoiceUrl });
      await waitForTabLoad(tab.id);
      await sleep(2000);

      const invoicePdf = await capturePageAsPDF(tab.id);
      const suffix = invoiceLinks.length > 1 ? `_${i + 1}` : "";
      const invoiceFilename = `VAT_Invoice_${code}${suffix}.pdf`;
      await downloadPDF(invoicePdf, invoiceFilename);
      invoiceFilenames.push(invoiceFilename);
      console.log(`[GetBnBInvoice] Downloaded: ${invoiceFilename}`);
    }

    await chrome.tabs.remove(tab.id);

    const allFiles = [receiptFilename, ...invoiceFilenames];
    return { success: true, files: allFiles, invoiceCount: invoiceLinks.length };
  } catch (err) {
    console.error(`[GetBnBInvoice] Error processing ${code}:`, err);
    // Clean up
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch (_) {}
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    throw err;
  }
}

// --- Helpers ---

async function capturePageAsPDF(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3");
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Page.printToPDF",
    {
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
    }
  );
  await chrome.debugger.detach({ tabId });
  return result.data;
}

async function downloadPDF(base64Data, filename) {
  const dataUrl = `data:application/pdf;base64,${base64Data}`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

async function findInvoiceLinks(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = document.querySelectorAll('a[href*="/invoice/"]');
      return Array.from(links).map(a => a.href);
    },
  });
  return results[0]?.result || [];
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Page load timeout after ${PAGE_LOAD_TIMEOUT}ms`));
    }, PAGE_LOAD_TIMEOUT);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
