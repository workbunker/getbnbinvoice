const MAX_BATCH_SIZE = 25;

// Cloud Functions URLs — update after deploying
const API_URLS = {
  register: "https://europe-west1-getbnbinvoice.cloudfunctions.net/register",
  checkCredit: "https://europe-west1-getbnbinvoice.cloudfunctions.net/checkCredit",
};

async function apiCall(endpoint, body) {
  const url = API_URLS[endpoint];
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status >= 500) throw new Error("server_error");
  return res.json();
}

// --- License & Credits ---

async function init() {
  const { licenseKey } = await chrome.storage.local.get("licenseKey");

  if (!licenseKey) {
    document.getElementById("loading").style.display = "none";
    document.getElementById("activation").style.display = "block";
    setupActivation();
    return;
  }

  // Check credits
  try {
    const result = await apiCall("checkCredit", { key: licenseKey });
    if (result.error === "invalid_key") {
      await chrome.storage.local.remove("licenseKey");
      document.getElementById("loading").style.display = "none";
      document.getElementById("activation").style.display = "block";
      setupActivation();
      return;
    }
    updateCreditBadge(result.remaining);
    if (result.remaining <= 0) {
      document.getElementById("loading").style.display = "none";
      document.getElementById("no-credits").style.display = "block";
      return;
    }
  } catch (e) {
    // API error — continue, credits checked at download time
    console.error("[GetBnBInvoice] Credit check failed:", e);
  }

  checkPageAndRender();
}

function updateCreditBadge(count) {
  const badge = document.getElementById("credit-badge");
  document.getElementById("credit-count").textContent = count;
  badge.style.display = "flex";
}

function setupActivation() {
  document.getElementById("register-btn").addEventListener("click", handleRegister);
  document.getElementById("activate-btn").addEventListener("click", handleActivateKey);
  document.getElementById("show-key-input").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("register-view").style.display = "none";
    document.getElementById("key-view").style.display = "block";
  });
  document.getElementById("show-register").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("key-view").style.display = "none";
    document.getElementById("register-view").style.display = "block";
  });
}

async function handleRegister() {
  const btn = document.getElementById("register-btn");
  const errorEl = document.getElementById("register-error");
  const email = document.getElementById("email-input").value.trim();

  if (!email || !email.includes("@")) {
    errorEl.textContent = "Please enter a valid email.";
    errorEl.style.display = "block";
    return;
  }

  btn.disabled = true;
  const btnOriginal = btn.innerHTML;
  btn.textContent = "Registering...";
  errorEl.style.display = "none";

  try {
    const result = await apiCall("register", { email });
    if (result.error === "too_many_registrations") {
      errorEl.textContent = "Too many registrations. Please try again later.";
      errorEl.style.display = "block";
    } else if (result.error === "already_registered") {
      if (result.key) {
        await chrome.storage.local.set({ licenseKey: result.key });
        location.reload();
      } else {
        errorEl.textContent = "This email is already registered. Check your email for the key.";
        errorEl.style.display = "block";
      }
    } else if (result.success) {
      await chrome.storage.local.set({ licenseKey: result.key });
      location.reload();
    } else {
      errorEl.textContent = result.error || "Registration failed.";
      errorEl.style.display = "block";
    }
  } catch (e) {
    errorEl.textContent = "Network error. Please try again.";
    errorEl.style.display = "block";
  }

  btn.disabled = false;
  btn.innerHTML = btnOriginal;
}

async function handleActivateKey() {
  const btn = document.getElementById("activate-btn");
  const errorEl = document.getElementById("key-error");
  const key = document.getElementById("key-input").value.trim().toUpperCase();

  if (!key || !key.startsWith("GBNB-")) {
    errorEl.textContent = "Invalid key format (GBNB-XXXX-XXXX-XXXX).";
    errorEl.style.display = "block";
    return;
  }

  btn.disabled = true;
  const btnOriginal = btn.innerHTML;
  btn.textContent = "Validating...";
  errorEl.style.display = "none";

  try {
    const result = await apiCall("checkCredit", { key });
    if (result.error === "invalid_key") {
      errorEl.textContent = "Invalid license key.";
      errorEl.style.display = "block";
    } else {
      await chrome.storage.local.set({ licenseKey: key });
      location.reload();
    }
  } catch (e) {
    errorEl.textContent = "Network error. Please try again.";
    errorEl.style.display = "block";
  }

  btn.disabled = false;
  btn.innerHTML = btnOriginal;
}

// --- Reservations ---

async function checkPageAndRender() {
  const loading = document.getElementById("loading");
  const notOnAirbnb = document.getElementById("not-on-airbnb");
  const reservationsArea = document.getElementById("reservations-area");
  const status = document.getElementById("status");
  const list = document.getElementById("reservation-list");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || !tab.url.match(/airbnb\.(pt|com)\/hosting\/reservations/)) {
      loading.style.display = "none";
      notOnAirbnb.style.display = "block";
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action: "getReservations" });
    const reservations = response.reservations || [];

    loading.style.display = "none";

    if (reservations.length === 0) {
      notOnAirbnb.style.display = "block";
      notOnAirbnb.querySelector(".hint").textContent = "No reservations found on this page.";
      return;
    }

    reservationsArea.style.display = "block";
    status.textContent = `Found ${reservations.length} reservations`;

    reservations.forEach((r) => {
      const item = document.createElement("div");
      item.className = "reservation-item";
      item.innerHTML = `
        <label>
          <input type="checkbox" checked value="${r.code}">
          <span class="code">${r.code}</span>
          <span class="checkin">${r.checkin || ""}</span>
          <span class="guest">${r.guest || ""}</span>
          <span class="amount">${r.amount || ""}</span>
        </label>
      `;
      list.appendChild(item);
    });

    document.getElementById("select-all-btn").addEventListener("click", () => {
      list.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = true));
      updateDownloadButton();
    });
    document.getElementById("deselect-all-btn").addEventListener("click", () => {
      list.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
      updateDownloadButton();
    });

    const downloadBtn = document.getElementById("download-btn");
    const progressArea = document.getElementById("progress-area");
    const progressBar = document.getElementById("progress-bar");
    const progress = document.getElementById("progress");

    function updateDownloadButton() {
      const count = list.querySelectorAll('input[type="checkbox"]:checked').length;
      const textEl = downloadBtn.querySelector(".btn-text");
      if (count === 0) {
        textEl.textContent = "Download selected";
        downloadBtn.disabled = true;
      } else if (count > MAX_BATCH_SIZE) {
        textEl.textContent = `Download first ${MAX_BATCH_SIZE} of ${count} selected`;
        downloadBtn.disabled = false;
      } else {
        textEl.textContent = `Download ${count} selected`;
        downloadBtn.disabled = false;
      }
    }
    updateDownloadButton();

    const cancelBtn = document.getElementById("cancel-btn");

    downloadBtn.addEventListener("click", async () => {
      const checked = list.querySelectorAll('input[type="checkbox"]:checked');
      if (checked.length === 0) return;

      const codes = Array.from(checked).map((cb) => cb.value).slice(0, MAX_BATCH_SIZE);

      // Check credits before starting
      downloadBtn.disabled = true;
      downloadBtn.querySelector(".btn-text").textContent = "Checking credits...";
      const { licenseKey } = await chrome.storage.local.get("licenseKey");
      if (licenseKey) {
        try {
          const creditResult = await apiCall("checkCredit", { key: licenseKey });
          if (creditResult.remaining <= 0) {
            showCreditWarning(0, codes.length);
            return;
          }
          if (creditResult.remaining < codes.length) {
            showCreditWarning(creditResult.remaining, codes.length);
            return;
          }
        } catch (_) {
          // Credit check failed — proceed anyway, will be caught at download time
        }
      }

      downloadBtn.disabled = false;
      updateDownloadButton();
      startBatchDownload(codes);
    });

    function showCreditWarning(remaining, selected) {
      const warning = document.getElementById("credit-warning");
      const msg = document.getElementById("credit-warning-msg");
      if (remaining <= 0) {
        msg.textContent = "You have no credits left. Please purchase more to continue.";
      } else {
        msg.textContent = `You have ${remaining} credits but selected ${selected} reservations. Please deselect ${selected - remaining} reservations to continue.`;
      }
      warning.style.display = "flex";
      downloadBtn.disabled = false;
      updateDownloadButton();
    }

    function hideCreditWarning() {
      document.getElementById("credit-warning").style.display = "none";
    }

    list.addEventListener("change", () => {
      hideCreditWarning();
      updateDownloadButton();
    });

    async function startBatchDownload(codes) {
      hideCreditWarning();
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const domain = new URL(activeTab.url).hostname;

      downloadBtn.style.display = "none";
      cancelBtn.style.display = "flex";
      progressArea.style.display = "block";
      progress.textContent = `Starting... (0 of ${codes.length})`;
      progressBar.style.width = "0%";
      progressBar.classList.add("animating");
      progressBar.classList.remove("complete");

      const progressListener = (message) => {
        if (message.action === "progress") {
          const pct = Math.round((message.current / message.total) * 100);
          progressBar.style.width = `${pct}%`;
          if (message.status === "cancelled") {
            progress.textContent = `Cancelled after ${message.current} of ${message.total}`;
          } else {
            progress.textContent = `Processing ${message.code} (${message.current} of ${message.total})`;
          }
        }
        if (message.action === "creditUpdate") {
          updateCreditBadge(message.remaining);
        }
        if (message.action === "batchComplete") {
          progressBar.style.width = "100%";
          progressBar.classList.remove("animating");
          progressBar.classList.add("complete");
          if (message.error) {
            progress.innerHTML = `Stopped: ${message.error} (${message.succeeded} of ${message.total} completed)`;
          } else if (message.failed > 0) {
            progress.innerHTML = `Done! ${message.succeeded} succeeded, ${message.failed} failed.<br><span class="error-detail">${message.errors.join("<br>")}</span>`;
          } else {
            progress.textContent = `Done! ${message.succeeded} downloaded.`;
          }
        }
      };
      chrome.runtime.onMessage.addListener(progressListener);

      const result = await chrome.runtime.sendMessage({
        action: "batchDownload",
        codes,
        domain,
      });

      chrome.runtime.onMessage.removeListener(progressListener);

      if (!result.success) {
        progress.textContent = `Error: ${result.error}`;
      }

      resetButtons();
    }

    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      cancelBtn.querySelector(".btn-text").textContent = "Cancelling...";
      await chrome.runtime.sendMessage({ action: "abortBatch" });
    });

    function resetButtons() {
      cancelBtn.style.display = "none";
      cancelBtn.disabled = false;
      cancelBtn.querySelector(".btn-text").textContent = "Cancel";
      downloadBtn.style.display = "flex";
      updateDownloadButton();
    }
  } catch (err) {
    loading.style.display = "none";
    notOnAirbnb.style.display = "block";
    console.error("[GetBnBInvoice]", err);
  }
}

init();
