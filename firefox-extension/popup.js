const BRIDGE_URL = "http://127.0.0.1:39287/websites";

const form = document.querySelector("#add-form");
const nameInput = document.querySelector("#name-input");
const button = document.querySelector("button");
const statusText = document.querySelector("#status");

let currentTabUrl = "";

function getOpenableUrl(url) {
  const trimmedUrl = url.trim();

  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmedUrl)) {
    return trimmedUrl;
  }

  return `https://${trimmedUrl}`;
}

async function getCurrentTab() {
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tabs[0];
}

function setStatus(message) {
  statusText.textContent = message;
}

async function initializePopup() {
  const tab = await getCurrentTab();

  if (!tab?.url) {
    setStatus("No URL");
    button.disabled = true;
    return;
  }

  currentTabUrl = getOpenableUrl(tab.url);
  nameInput.value = tab.title || "";
  nameInput.focus();
  nameInput.setSelectionRange(0, 0);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();

  if (!name || !currentTabUrl) {
    setStatus("Name?");
    return;
  }

  button.disabled = true;
  setStatus("...");

  try {
    const response = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        url: currentTabUrl,
        addedAt: Date.now(),
      }),
    });

    if (!response.ok) {
      throw new Error("Agglomerator rejected the website.");
    }

    setStatus("Added");
  } catch {
    setStatus("Closed");
  } finally {
    button.disabled = false;
  }
});

void initializePopup().catch(() => {
  setStatus("No tab");
  button.disabled = true;
});
