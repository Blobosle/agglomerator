const BRIDGE_BASE_URL = "http://127.0.0.1:39287";
const BRIDGE_TOKEN_URL = `${BRIDGE_BASE_URL}/bridge-token`;
const BRIDGE_WEBSITES_URL = `${BRIDGE_BASE_URL}/websites`;

const form = document.querySelector("#add-form");
const nameInput = document.querySelector("#name-input");
const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
const actionsRow = document.querySelector("#actions-row");
const statusText = document.querySelector("#status");

let currentTabUrl = "";
let bridgeToken = "";

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

async function captureFallbackPreview(tab) {
  if (typeof tab?.windowId !== "number") {
    return null;
  }

  try {
    const screenshotDataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 35,
    });

    return await downscaleScreenshot(screenshotDataUrl);
  } catch {
    return null;
  }
}

async function downscaleScreenshot(screenshotDataUrl) {
  const screenshotImage = await loadImage(screenshotDataUrl);
  const maxWidth = 640;
  const scale = Math.min(1, maxWidth / screenshotImage.naturalWidth);
  const targetWidth = Math.max(1, Math.round(screenshotImage.naturalWidth * scale));
  const targetHeight = Math.max(1, Math.round(screenshotImage.naturalHeight * scale));
  const canvas = document.createElement("canvas");

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");

  if (!context) {
    return screenshotDataUrl;
  }

  context.drawImage(screenshotImage, 0, 0, targetWidth, targetHeight);

  return canvas.toDataURL("image/jpeg", 0.45);
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load screenshot"));
    image.src = source;
  });
}

function setStatus(message) {
  statusText.textContent = message;
  actionsRow.classList.toggle("has-status", message.trim().length > 0);
}

async function initializePopup() {
  const tab = await getCurrentTab();

  if (!tab?.url) {
    setStatus("No URL");
    for (const button of buttons) {
      button.disabled = true;
    }
    return;
  }

  currentTabUrl = getOpenableUrl(tab.url);
  nameInput.value = tab.title || "";
  nameInput.focus();
  nameInput.setSelectionRange(0, 0);

  const tokenResponse = await fetch(BRIDGE_TOKEN_URL);

  if (!tokenResponse.ok) {
    throw new Error("Missing bridge token");
  }

  const tokenPayload = await tokenResponse.json();

  if (typeof tokenPayload?.token !== "string" || tokenPayload.token.length === 0) {
    throw new Error("Invalid bridge token");
  }

  bridgeToken = tokenPayload.token;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = event.submitter;
  const shouldPreferScreenshot = submitButton?.value === "preview";

  const name = nameInput.value.trim();

  if (!name || !currentTabUrl) {
    setStatus("Name?");
    return;
  }
  if (!bridgeToken) {
    setStatus("Closed");
    return;
  }

  for (const button of buttons) {
    button.disabled = true;
  }
  setStatus("...");

  try {
    const tab = await getCurrentTab();
    const fallbackPreviewDataUrl = await captureFallbackPreview(tab);
    const response = await fetch(BRIDGE_WEBSITES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agglomerator-Token": bridgeToken,
      },
      body: JSON.stringify({
        name,
        url: currentTabUrl,
        addedAt: Date.now(),
        fallbackPreviewDataUrl,
        preferFallbackPreview: shouldPreferScreenshot,
      }),
    });

    if (!response.ok) {
      throw new Error("Agglomerator rejected the website.");
    }

    setStatus("Added");
    window.close();
  } catch {
    setStatus("Closed");
  } finally {
    for (const button of buttons) {
      button.disabled = false;
    }
  }
});

void initializePopup().catch(() => {
  if (!currentTabUrl) {
    setStatus("No tab");
  } else {
    setStatus("Closed");
  }

  for (const button of buttons) {
    button.disabled = true;
  }
});
