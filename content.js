console.log("[GetBnBInvoice] Extension is running on this page.");

function scrapeReservations() {
  const rows = document.querySelectorAll('tr[data-testid="host-reservations-table-row"]');
  const reservations = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (cells.length < 2) return;

    // Find the confirmation code — matches HM followed by alphanumeric chars
    let code = null;
    let guest = null;
    let amount = null;
    let checkin = null;

    for (const cell of cells) {
      const text = cell.textContent.trim();
      if (/^HM[A-Z0-9]{6,}$/.test(text)) {
        code = text;
      } else if (text.startsWith("€")) {
        amount = text;
      } else if (cell.querySelector("a") && !guest) {
        // Guest name is typically a link
        const link = cell.querySelector("a");
        if (link && !link.href.includes("airbnb")) {
          guest = link.textContent.trim();
        }
      }
    }

    // Check-in date is in the 4th cell (index 3)
    if (cells.length > 3) {
      checkin = cells[3].textContent.trim();
    }

    // Fallback: try to find guest name from first link in row
    if (!guest) {
      const firstLink = row.querySelector("a");
      if (firstLink) {
        guest = firstLink.textContent.trim();
      }
    }

    if (code) {
      reservations.push({ code, guest, amount, checkin });
    }
  });

  console.log(`[GetBnBInvoice] Found ${reservations.length} reservations.`, reservations);
  return reservations;
}

// Scrape on load
const reservations = scrapeReservations();

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getReservations") {
    const results = scrapeReservations();
    sendResponse({ reservations: results });
  }
  return true;
});
