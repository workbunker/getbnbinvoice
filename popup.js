const MAX_BATCH_SIZE = 25;

async function init() {
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

    // Render reservation list
    reservations.forEach(r => {
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

    // Select all / Deselect all
    document.getElementById("select-all-btn").addEventListener("click", () => {
      list.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
      updateDownloadButton();
    });
    document.getElementById("deselect-all-btn").addEventListener("click", () => {
      list.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
      updateDownloadButton();
    });

    // Update button text on checkbox change
    list.addEventListener("change", updateDownloadButton);

    // Download button
    const downloadBtn = document.getElementById("download-btn");
    const progressArea = document.getElementById("progress-area");
    const progressBar = document.getElementById("progress-bar");
    const progress = document.getElementById("progress");

    function updateDownloadButton() {
      const count = list.querySelectorAll('input[type="checkbox"]:checked').length;
      if (count === 0) {
        downloadBtn.textContent = "Download selected";
        downloadBtn.disabled = true;
      } else if (count > MAX_BATCH_SIZE) {
        downloadBtn.textContent = `Download first ${MAX_BATCH_SIZE} of ${count} selected`;
        downloadBtn.disabled = false;
      } else {
        downloadBtn.textContent = `Download ${count} selected`;
        downloadBtn.disabled = false;
      }
    }
    updateDownloadButton();

    const cancelBtn = document.getElementById("cancel-btn");

    downloadBtn.addEventListener("click", async () => {
      const checked = list.querySelectorAll('input[type="checkbox"]:checked');
      if (checked.length === 0) return;

      const codes = Array.from(checked).map(cb => cb.value).slice(0, MAX_BATCH_SIZE);
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const domain = new URL(activeTab.url).hostname;

      downloadBtn.style.display = "none";
      cancelBtn.style.display = "block";
      progressArea.style.display = "block";
      progress.textContent = `Starting... (0 of ${codes.length})`;
      progressBar.style.width = "0%";

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
        if (message.action === "batchComplete") {
          progressBar.style.width = "100%";
          if (message.failed > 0) {
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
    });

    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling...";
      await chrome.runtime.sendMessage({ action: "abortBatch" });
    });

    function resetButtons() {
      cancelBtn.style.display = "none";
      cancelBtn.disabled = false;
      cancelBtn.textContent = "Cancel";
      downloadBtn.style.display = "block";
      updateDownloadButton();
    }
  } catch (err) {
    loading.style.display = "none";
    notOnAirbnb.style.display = "block";
    console.error("[GetBnBInvoice]", err);
  }
}

init();
