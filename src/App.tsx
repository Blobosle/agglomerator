import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_COMMAND_LABELS,
  KEYBINDING_COMMANDS,
  MAX_KEYBINDINGS_PER_COMMAND,
  formatKeybindingLabel,
  getKeybindingFromEvent,
  normalizeKeybindings,
  useWebsiteKeybindNavigation,
  type KeybindingMap,
  type KeyboardNavigationCommand,
} from "./websiteKeybinds";

type WebsiteRecord = {
  name: string;
  url: string;
  addedAt: number;
  fallbackPreviewDataUrl?: string | null;
  preferFallbackPreview?: boolean;
};

const PREVIEW_CACHE_DB_NAME = "agglomerator-preview-cache";
const PREVIEW_CACHE_STORE_NAME = "previews";
const PREVIEW_CACHE_VERSION = 1;
const KEYBINDING_STORAGE_KEY = "agglomerator-keybindings";
const KEYBINDING_SYNC_CHANNEL = "agglomerator-keybindings-sync";

function loadStoredKeybindings() {
  try {
    const storedKeybindings = window.localStorage.getItem(KEYBINDING_STORAGE_KEY);

    if (!storedKeybindings) {
      return normalizeKeybindings(DEFAULT_KEYBINDINGS);
    }

    return normalizeKeybindings(JSON.parse(storedKeybindings));
  } catch {
    return normalizeKeybindings(DEFAULT_KEYBINDINGS);
  }
}

function sortWebsitesByRecency(websites: WebsiteRecord[]) {
  return [...websites].sort(
    (firstWebsite, secondWebsite) =>
      secondWebsite.addedAt - firstWebsite.addedAt,
  );
}

function getOpenableUrl(url: string) {
  const trimmedUrl = url.trim();

  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmedUrl)) {
    return trimmedUrl;
  }

  return `https://${trimmedUrl}`;
}

function getPreviewUrl(url: string) {
  return `https://image.thum.io/get/width/640/crop/360/noanimate/${encodeURI(getOpenableUrl(url))}`;
}

function getPreviewAttemptUrl(url: string, attempt: number) {
  return `${getPreviewUrl(url)}?refresh=${attempt}`;
}

function getYouTubeVideoId(url: string) {
  try {
    const parsedUrl = new URL(getOpenableUrl(url));
    const hostName = parsedUrl.hostname.replace(/^www\./, "");

    if (hostName === "youtu.be") {
      return parsedUrl.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    if (hostName === "youtube.com" || hostName === "m.youtube.com") {
      const watchId = parsedUrl.searchParams.get("v");

      if (watchId) {
        return watchId;
      }

      const [route, videoId] = parsedUrl.pathname.split("/").filter(Boolean);

      if (["embed", "shorts", "live"].includes(route) && videoId) {
        return videoId;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getYouTubeThumbnailUrl(url: string) {
  const videoId = getYouTubeVideoId(url);

  if (!videoId) {
    return null;
  }

  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

function getAmazonProductAsin(url: string) {
  try {
    const parsedUrl = new URL(getOpenableUrl(url));
    const asinMatch = parsedUrl.pathname.match(
      /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i,
    );

    return asinMatch?.[1]?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

function getAmazonProductImageUrl(url: string) {
  const asin = getAmazonProductAsin(url);

  if (!asin) {
    return null;
  }

  return `https://m.media-amazon.com/images/P/${asin}.01._SX385_.jpg`;
}

function shouldFitPreviewImage(url: string) {
  return Boolean(getAmazonProductImageUrl(url));
}

function getPreviewContainerClassName(url: string) {
  return shouldFitPreviewImage(url) ? "bg-white/70" : "bg-slate-100";
}

function usesCustomPreview(url: string) {
  return Boolean(getYouTubeThumbnailUrl(url)) || Boolean(getAmazonProductImageUrl(url));
}

function getPreviewCacheStorageKey(url: string) {
  if (usesCustomPreview(url)) {
    return `custom-preview:${url}`;
  }

  return url;
}

function openPreviewCache() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      PREVIEW_CACHE_DB_NAME,
      PREVIEW_CACHE_VERSION,
    );

    request.onupgradeneeded = () => {
      request.result.createObjectStore(PREVIEW_CACHE_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCachedPreview(url: string) {
  const database = await openPreviewCache();

  return new Promise<Blob | null>((resolve, reject) => {
    const transaction = database.transaction(PREVIEW_CACHE_STORE_NAME, "readonly");
    const request = transaction.objectStore(PREVIEW_CACHE_STORE_NAME).get(url);

    request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function writeCachedPreview(url: string, previewBlob: Blob) {
  const database = await openPreviewCache();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PREVIEW_CACHE_STORE_NAME, "readwrite");
    const request = transaction
      .objectStore(PREVIEW_CACHE_STORE_NAME)
      .put(previewBlob, url);

    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

async function deleteCachedPreview(url: string) {
  const database = await openPreviewCache();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PREVIEW_CACHE_STORE_NAME, "readwrite");
    const request = transaction.objectStore(PREVIEW_CACHE_STORE_NAME).delete(url);

    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

function getDisplayUrl(url: string) {
  return url.trim().replace(/^[a-z][a-z\d+\-.]*:\/\//i, "");
}

function startWindowDrag(event: PointerEvent<HTMLDivElement>) {
  if (event.button !== 0) {
    return;
  }

  void getCurrentWindow().startDragging().catch(() => undefined);
}

function openWebsite(url: string) {
  void openUrl(getOpenableUrl(url)).catch(() => undefined);
}

function KeybindingSettings({
  keybindings,
  recordingBinding,
  onCancelRecording,
  onRemoveBinding,
  onResetKeybindings,
  onSetBinding,
  onStartRecording,
}: {
  keybindings: KeybindingMap;
  recordingBinding: { command: KeyboardNavigationCommand; slot: number } | null;
  onCancelRecording: () => void;
  onRemoveBinding: (command: KeyboardNavigationCommand, slot: number) => void;
  onResetKeybindings: () => void;
  onSetBinding: (
    command: KeyboardNavigationCommand,
    slot: number,
    keybinding: string,
  ) => void;
  onStartRecording: (command: KeyboardNavigationCommand, slot: number) => void;
}) {
  useEffect(() => {
    if (!recordingBinding) {
      return;
    }

    const activeRecordingBinding = recordingBinding;

    function handleRecordingKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      const keybinding = getKeybindingFromEvent(event);

      if (event.key === "Escape") {
        onCancelRecording();
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        return;
      }

      if (
        ["Alt", "Control", "Meta", "Shift"].includes(event.key) ||
        keybinding.length === 0
      ) {
        return;
      }

      onSetBinding(
        activeRecordingBinding.command,
        activeRecordingBinding.slot,
        keybinding,
      );
    }

    window.addEventListener("keydown", handleRecordingKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleRecordingKeyDown, true);
    };
  }, [onCancelRecording, onSetBinding, recordingBinding]);

  return (
    <section className="px-5 py-3 text-sm [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace]">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="font-medium text-slate-900">Keybindings</div>
        <button
          className="border-0 bg-transparent p-0 text-red-700 underline hover:bg-red-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-300"
          type="button"
          onClick={onResetKeybindings}
        >
          Reset
        </button>
      </div>
      <div className="grid gap-2">
        {KEYBINDING_COMMANDS.map((command) => (
          <div
            className="grid grid-cols-[minmax(7rem,10rem)_1fr] items-center gap-3"
            key={command}
          >
            <div className="text-slate-700">
              {KEYBINDING_COMMAND_LABELS[command]}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: MAX_KEYBINDINGS_PER_COMMAND }).map(
                (_, slot) => {
                  const keybinding = keybindings[command][slot];
                  const isRecording =
                    recordingBinding?.command === command &&
                    recordingBinding.slot === slot;

                  return (
                    <span className="inline-flex" key={slot}>
                      <button
                        autoFocus={isRecording}
                        className={`min-h-7 min-w-12 border border-slate-300 px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300 ${
                          isRecording
                            ? "bg-sky-700 text-white"
                            : "bg-white text-slate-950 hover:bg-slate-100"
                        }`}
                        type="button"
                        onClick={() => onStartRecording(command, slot)}
                      >
                        {isRecording
                          ? "..."
                          : keybinding
                            ? formatKeybindingLabel(keybinding)
                            : "+"}
                      </button>
                      {keybinding ? (
                        <button
                          className="min-h-7 border-y border-r border-slate-300 bg-white px-1.5 text-slate-500 hover:bg-red-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
                          type="button"
                          onClick={() => onRemoveBinding(command, slot)}
                          aria-label={`Remove ${KEYBINDING_COMMAND_LABELS[command]} binding ${formatKeybindingLabel(keybinding)}`}
                        >
                          x
                        </button>
                      ) : null}
                    </span>
                  );
                },
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function WebsiteHeader({
  website,
  isSelectingForDelete,
  isKeyboardHighlighted,
  onDelete,
}: {
  website: WebsiteRecord;
  isSelectingForDelete: boolean;
  isKeyboardHighlighted: boolean;
  onDelete: () => void;
}) {
  const nameColumnRef = useRef<HTMLDivElement>(null);
  const nameTextRef = useRef<HTMLSpanElement>(null);
  const linkColumnRef = useRef<HTMLButtonElement>(null);
  const linkTextRef = useRef<HTMLSpanElement>(null);
  const displayUrl = getDisplayUrl(website.url);
  const [hoverLayout, setHoverLayout] = useState({
    nameColumnWidth: 0,
    nameOverflows: false,
    linkColumnWidth: 0,
    linkOverflows: false,
  });

  useEffect(() => {
    function measureHoverLayout() {
      const nameColumnWidth = nameColumnRef.current?.clientWidth ?? 0;
      const linkColumnWidth = linkColumnRef.current?.clientWidth ?? 0;
      const nameOverflows =
        (nameTextRef.current?.scrollWidth ?? 0) > nameColumnWidth + 1;
      const linkOverflows =
        (linkTextRef.current?.scrollWidth ?? 0) > linkColumnWidth + 1;

      setHoverLayout((currentLayout) => {
        if (
          currentLayout.nameColumnWidth === nameColumnWidth &&
          currentLayout.nameOverflows === nameOverflows &&
          currentLayout.linkColumnWidth === linkColumnWidth &&
          currentLayout.linkOverflows === linkOverflows
        ) {
          return currentLayout;
        }

        return {
          nameColumnWidth,
          nameOverflows,
          linkColumnWidth,
          linkOverflows,
        };
      });
    }

    const animationFrame = window.requestAnimationFrame(measureHoverLayout);
    window.addEventListener("resize", measureHoverLayout);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measureHoverLayout);

    if (resizeObserver) {
      if (nameColumnRef.current) {
        resizeObserver.observe(nameColumnRef.current);
      }

      if (linkColumnRef.current) {
        resizeObserver.observe(linkColumnRef.current);
      }
    }

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", measureHoverLayout);
      resizeObserver?.disconnect();
    };
  }, [displayUrl, website.name]);

  return (
    <div className="relative grid min-h-5 grid-cols-[minmax(0,2fr)_minmax(4.5rem,1fr)] items-start gap-x-4">
      <div
        ref={nameColumnRef}
        className={`group/name relative min-w-0 select-text border-0 bg-transparent p-0 text-left font-medium text-slate-900 [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] focus-visible:outline-2 focus-visible:outline-offset-4 ${
          isSelectingForDelete
            ? isKeyboardHighlighted
              ? "cursor-pointer bg-red-700 text-white focus-visible:outline-red-300"
              : "cursor-pointer bg-white text-red-700 hover:bg-red-100 hover:text-red-900 focus-visible:outline-red-300"
            : "cursor-text focus-visible:outline-blue-300"
        }`}
        role={isSelectingForDelete ? "button" : undefined}
        tabIndex={isSelectingForDelete ? 0 : undefined}
        onClick={() => {
          if (isSelectingForDelete) {
            onDelete();
          }
        }}
        onKeyDown={(event) => {
          if (!isSelectingForDelete) {
            return;
          }

          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onDelete();
          }
        }}
      >
        <span ref={nameTextRef} className="block truncate">
          {website.name}
        </span>
        <span
          className={`absolute left-0 top-0 z-10 block max-h-0 origin-top scale-y-0 select-text overflow-hidden whitespace-normal break-words text-left transition-[max-height,transform] duration-300 ease-out group-hover/name:max-h-40 group-hover/name:scale-y-100 group-focus-visible/name:max-h-40 group-focus-visible/name:scale-y-100 ${
            isSelectingForDelete
              ? isKeyboardHighlighted
                ? "bg-red-700 text-white"
                : "bg-white text-red-700 group-hover/name:bg-red-100 group-hover/name:text-red-900"
              : "bg-white text-slate-900"
          }`}
          style={{
            width:
              hoverLayout.nameOverflows || hoverLayout.nameColumnWidth === 0
                ? "100%"
                : hoverLayout.nameColumnWidth,
          }}
        >
          {website.name}
        </span>
      </div>
      <button
        ref={linkColumnRef}
        className={`group/link min-w-0 select-text border-0 bg-transparent p-0 text-right [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 ${
          isSelectingForDelete
            ? isKeyboardHighlighted
              ? "cursor-pointer bg-red-700 text-white underline focus-visible:outline-red-300"
              : "cursor-pointer bg-white text-red-700 hover:bg-red-100 hover:text-red-900 focus-visible:outline-red-300"
            : isKeyboardHighlighted
              ? "cursor-pointer bg-sky-700 text-white underline focus-visible:outline-blue-300"
              : "cursor-pointer bg-white text-blue-700 focus-visible:outline-blue-300"
        }`}
        type="button"
        onClick={(event) => {
          if (isSelectingForDelete) {
            event.preventDefault();
            onDelete();
            return;
          }

          openWebsite(website.url);
        }}
        title={website.url}
      >
        <span ref={linkTextRef} className="block truncate">
          {displayUrl}
        </span>
        <span
          className={`pointer-events-none absolute right-0 top-0 z-10 block origin-top overflow-hidden whitespace-normal break-words text-right group-hover/link:max-h-40 group-hover/link:scale-y-100 group-focus-visible/link:max-h-40 group-focus-visible/link:scale-y-100 ${
            isKeyboardHighlighted ? "max-h-40 scale-y-100" : "max-h-0 scale-y-0"
          } ${
            isSelectingForDelete
              ? isKeyboardHighlighted
                ? "bg-red-700 text-white"
                : "bg-white text-red-700 group-hover/link:bg-red-100 group-hover/link:text-red-900"
              : isKeyboardHighlighted
                ? "bg-sky-700 text-white"
                : "bg-white text-blue-700"
          }`}
          style={{
            width:
              hoverLayout.linkOverflows || hoverLayout.linkColumnWidth === 0
                ? "100%"
                : hoverLayout.linkColumnWidth,
          }}
        >
          {displayUrl}
        </span>
      </button>
    </div>
  );
}

function WebsitePreview({
  website,
  refreshKey,
}: {
  website: WebsiteRecord;
  refreshKey: number;
}) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    let retryTimeout: number | undefined;
    let objectUrl: string | undefined;
    let attempt = 0;
    let clearedFallbackPreview = false;
    const previewCacheStorageKey = getPreviewCacheStorageKey(website.url);

    async function setPreviewBlob(previewBlob: Blob) {
      objectUrl = URL.createObjectURL(previewBlob);

      if (isMounted) {
        setPreviewSrc(objectUrl);
      }
    }

    async function clearFallbackPreview() {
      if (clearedFallbackPreview || !website.fallbackPreviewDataUrl) {
        return;
      }

      clearedFallbackPreview = true;

      await invoke<WebsiteRecord[]>("clear_website_fallback_preview", {
        url: website.url,
        addedAt: website.addedAt,
      }).catch(() => undefined);
    }

    async function loadCustomPreview(previewUrl: string) {
      const response = await fetch(previewUrl, {
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });

      if (!response.ok) {
        throw new Error("Custom preview was not available");
      }

      const previewBlob = await response.blob();

      await writeCachedPreview(previewCacheStorageKey, previewBlob).catch(
        () => undefined,
      );
      await clearFallbackPreview();
      await setPreviewBlob(previewBlob);
    }

    async function loadPreview() {
      const candidateSrc = getPreviewAttemptUrl(website.url, attempt);

      try {
        const response = await fetch(candidateSrc, {
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });

        if (!response.ok) {
          throw new Error("Preview was not ready");
        }

        const previewBlob = await response.blob();

        await writeCachedPreview(previewCacheStorageKey, previewBlob).catch(
          () => undefined,
        );
        await clearFallbackPreview();
        await setPreviewBlob(previewBlob);
      } catch {
        const previewImage = new Image();

        previewImage.referrerPolicy = "no-referrer";
        previewImage.onload = () => {
          if (isMounted) {
            setPreviewSrc(candidateSrc);
          }
        };
        previewImage.onerror = () => {
          if (isMounted && website.fallbackPreviewDataUrl) {
            setPreviewSrc(website.fallbackPreviewDataUrl);
          }
          attempt += 1;
          retryTimeout = window.setTimeout(loadPreview, 3000);
        };
        previewImage.src = candidateSrc;
      }
    }

    async function initializePreview() {
      setPreviewSrc(null);

      if (website.preferFallbackPreview && website.fallbackPreviewDataUrl) {
        setPreviewSrc(website.fallbackPreviewDataUrl);
        return;
      }

      const cachedPreview = await readCachedPreview(previewCacheStorageKey).catch(
        () => null,
      );

      if (cachedPreview) {
        await setPreviewBlob(cachedPreview);
        return;
      }

      const youTubeThumbnailUrl = getYouTubeThumbnailUrl(website.url);

      if (youTubeThumbnailUrl) {
        await loadCustomPreview(youTubeThumbnailUrl);
        return;
      }

      const amazonProductImageUrl = getAmazonProductImageUrl(website.url);

      if (amazonProductImageUrl) {
        await loadCustomPreview(amazonProductImageUrl);
        return;
      }

      await loadPreview();
    }

    void initializePreview().catch(() => {
      if (isMounted) {
        if (website.fallbackPreviewDataUrl) {
          setPreviewSrc(website.fallbackPreviewDataUrl);
        }
        retryTimeout = window.setTimeout(loadPreview, 3000);
      }
    });

    return () => {
      isMounted = false;
      window.clearTimeout(retryTimeout);

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [
    website.addedAt,
    website.fallbackPreviewDataUrl,
    website.preferFallbackPreview,
    website.url,
    refreshKey,
  ]);

  return (
    previewSrc && (
      <img
        className={`h-full w-full select-none ${
          shouldFitPreviewImage(website.url) ? "object-contain" : "object-cover"
        }`}
        src={previewSrc}
        alt=""
        draggable={false}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    )
  );
}

function App() {
  const isSettingsWindow = window.location.hash === "#settings";
  const [websites, setWebsites] = useState<WebsiteRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSelectingForDelete, setIsSelectingForDelete] = useState(false);
  const [keybindings, setKeybindings] = useState<KeybindingMap>(
    loadStoredKeybindings,
  );
  const [recordingBinding, setRecordingBinding] = useState<{
    command: KeyboardNavigationCommand;
    slot: number;
  } | null>(null);
  const [previewRefreshKeys, setPreviewRefreshKeys] = useState<
    Record<string, number>
  >({});
  const searchInputRef = useRef<HTMLInputElement>(null);
  const websiteGridRef = useRef<HTMLUListElement>(null);
  const [websiteGridColumnCount, setWebsiteGridColumnCount] = useState(1);
  const previewClickTimeoutRef = useRef<number | undefined>(undefined);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    let isMounted = true;

    async function loadWebsites() {
      const loadedWebsites = await invoke<WebsiteRecord[]>("list_websites");

      if (isMounted) {
        setWebsites(sortWebsitesByRecency(loadedWebsites));
      }
    }

    void loadWebsites().catch(() => undefined);

    const refreshInterval = window.setInterval(() => {
      void loadWebsites().catch(() => undefined);
    }, 2000);

    return () => {
      isMounted = false;
      window.clearInterval(refreshInterval);
    };
  }, [isSettingsWindow]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        KEYBINDING_STORAGE_KEY,
        JSON.stringify(keybindings),
      );
    } catch {
      // Keep the in-memory settings even if persistence is unavailable.
    }

    if (!isSettingsWindow || typeof BroadcastChannel === "undefined") {
      return;
    }

    const channel = new BroadcastChannel(KEYBINDING_SYNC_CHANNEL);
    channel.postMessage(keybindings);
    channel.close();
  }, [keybindings]);

  useEffect(() => {
    function syncStoredKeybindings(event: StorageEvent) {
      if (event.key !== KEYBINDING_STORAGE_KEY || !event.newValue) {
        return;
      }

      try {
        setKeybindings(normalizeKeybindings(JSON.parse(event.newValue)));
      } catch {
        setKeybindings(normalizeKeybindings(DEFAULT_KEYBINDINGS));
      }
    }

    window.addEventListener("storage", syncStoredKeybindings);

    if (typeof BroadcastChannel === "undefined") {
      return () => {
        window.removeEventListener("storage", syncStoredKeybindings);
      };
    }

    const channel = new BroadcastChannel(KEYBINDING_SYNC_CHANNEL);
    channel.onmessage = (event) => {
      setKeybindings(normalizeKeybindings(event.data as Partial<KeybindingMap>));
    };

    return () => {
      window.removeEventListener("storage", syncStoredKeybindings);
      channel.close();
    };
  }, []);

  useEffect(() => {
    function measureGridColumns() {
      const websiteGrid = websiteGridRef.current;

      if (!websiteGrid) {
        return;
      }

      const columnCount = getComputedStyle(websiteGrid)
        .gridTemplateColumns.split(" ")
        .filter(Boolean).length;

      setWebsiteGridColumnCount(Math.max(1, columnCount));
    }

    const animationFrame = window.requestAnimationFrame(measureGridColumns);
    window.addEventListener("resize", measureGridColumns);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measureGridColumns);

    if (resizeObserver && websiteGridRef.current) {
      resizeObserver.observe(websiteGridRef.current);
    }

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", measureGridColumns);
      resizeObserver?.disconnect();
    };
  }, []);

  const filteredWebsites = useMemo(() => {
    if (!normalizedSearchQuery) {
      return websites;
    }

    return websites.filter((website) => {
      const searchableText = `${website.name} ${website.url}`.toLowerCase();

      return searchableText.includes(normalizedSearchQuery);
    });
  }, [normalizedSearchQuery, websites]);

  const openWebsiteAtIndex = useCallback(
    (websiteIndex: number) => {
      const website = filteredWebsites[websiteIndex];

      if (website) {
        openWebsite(website.url);
      }
    },
    [filteredWebsites],
  );

  const deleteWebsiteAtIndex = useCallback(
    (websiteIndex: number) => {
      const website = filteredWebsites[websiteIndex];

      if (website) {
        void deleteWebsite(website).catch(() => undefined);
      }
    },
    [filteredWebsites],
  );

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus();
  }, []);

  const resetKeybindings = useCallback(() => {
    setKeybindings(normalizeKeybindings(DEFAULT_KEYBINDINGS));
    setRecordingBinding(null);
  }, []);

  const removeKeybinding = useCallback(
    (command: KeyboardNavigationCommand, slot: number) => {
      setKeybindings((currentKeybindings) => {
        const nextKeybindings = normalizeKeybindings(currentKeybindings);

        nextKeybindings[command] = nextKeybindings[command].filter(
          (_, bindingIndex) => bindingIndex !== slot,
        );

        return nextKeybindings;
      });
      setRecordingBinding(null);
    },
    [],
  );

  const setKeybinding = useCallback(
    (command: KeyboardNavigationCommand, slot: number, keybinding: string) => {
      setKeybindings((currentKeybindings) => {
        const nextKeybindings = normalizeKeybindings(currentKeybindings);

        KEYBINDING_COMMANDS.forEach((currentCommand) => {
          nextKeybindings[currentCommand] = nextKeybindings[
            currentCommand
          ].filter((currentKeybinding) => currentKeybinding !== keybinding);
        });

        const commandKeybindings = [...nextKeybindings[command]];

        commandKeybindings[slot] = keybinding;
        nextKeybindings[command] = commandKeybindings
          .filter(Boolean)
          .slice(0, MAX_KEYBINDINGS_PER_COMMAND);

        return nextKeybindings;
      });
      setRecordingBinding(null);
    },
    [],
  );

  const {
    activeIndex: keyboardNavigationIndex,
    isKeyboardMode,
    rememberHoveredIndex,
    startKeyboardModeAtIndex,
    stopKeyboardMode,
  } = useWebsiteKeybindNavigation({
    itemCount: filteredWebsites.length,
    columnCount: websiteGridColumnCount,
    isEnabled: !isSettingsWindow,
    isDeleteMode: isSelectingForDelete,
    keybindings,
    onCancelDeleteMode: () => setIsSelectingForDelete(false),
    onDelete: deleteWebsiteAtIndex,
    onEnterDeleteMode: () => setIsSelectingForDelete(true),
    onMoveAboveFirstRow: focusSearchInput,
    onOpen: openWebsiteAtIndex,
  });

  async function deleteWebsite(website: WebsiteRecord) {
    const updatedWebsites = await invoke<WebsiteRecord[]>("delete_website", {
      url: website.url,
      addedAt: website.addedAt,
    });

    setWebsites(sortWebsitesByRecency(updatedWebsites));
  }

  function getPreviewCacheKey(website: WebsiteRecord) {
    return `${website.url}:${website.addedAt}`;
  }

  async function refreshPreview(website: WebsiteRecord) {
    await Promise.all([
      deleteCachedPreview(website.url).catch(() => undefined),
      deleteCachedPreview(getPreviewCacheStorageKey(website.url)).catch(
        () => undefined,
      ),
    ]);
    setPreviewRefreshKeys((currentKeys) => {
      const cacheKey = getPreviewCacheKey(website);

      return {
        ...currentKeys,
        [cacheKey]: (currentKeys[cacheKey] ?? 0) + 1,
      };
    });
  }

  if (isSettingsWindow) {
    return (
      <main className="min-h-screen bg-white text-slate-950">
        <div
          className="h-8 bg-white"
          data-tauri-drag-region
          onPointerDown={startWindowDrag}
        />
        <KeybindingSettings
          keybindings={keybindings}
          recordingBinding={recordingBinding}
          onCancelRecording={() => setRecordingBinding(null)}
          onRemoveBinding={removeKeybinding}
          onResetKeybindings={resetKeybindings}
          onSetBinding={setKeybinding}
          onStartRecording={(command, slot) => {
            setRecordingBinding({ command, slot });
          }}
        />
      </main>
    );
  }

  return (
    <main
      className="min-h-screen select-none bg-white text-slate-950"
      onPointerMove={stopKeyboardMode}
    >
      <div
        className="h-6 select-none bg-white"
        data-tauri-drag-region
        onPointerDown={startWindowDrag}
      />
      <div className="flex items-center gap-4 px-5 py-1.5">
        <input
          ref={searchInputRef}
          className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-slate-950 outline-none [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] placeholder:text-slate-400"
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              !["ArrowDown", "Enter"].includes(event.key) ||
              filteredWebsites.length === 0
            ) {
              return;
            }

            event.preventDefault();
            startKeyboardModeAtIndex(0);
            event.currentTarget.blur();
          }}
          placeholder="Search"
          aria-label="Search websites by name or link"
        />
        <button
          className="select-text border-0 bg-transparent p-0 text-sm text-red-700 underline [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] hover:bg-red-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-300"
          type="button"
          onClick={() => setIsSelectingForDelete((isSelecting) => !isSelecting)}
        >
          {isSelectingForDelete ? "Cancel" : "Delete"}
        </button>
      </div>
      <ul
        ref={websiteGridRef}
        className="grid w-full grid-cols-[repeat(auto-fill,minmax(15rem,22rem))]"
      >
        {filteredWebsites.map((website, websiteIndex) => (
          <li
            className={`grid grid-cols-1 gap-y-3 px-5 py-4 ${
              (websiteIndex + 1) % websiteGridColumnCount === 0
                ? ""
                : "border-r border-slate-200"
            }`}
            key={website.url}
            onPointerEnter={() => rememberHoveredIndex(websiteIndex)}
          >
            <WebsiteHeader
              website={website}
              isSelectingForDelete={isSelectingForDelete}
              isKeyboardHighlighted={
                isKeyboardMode && keyboardNavigationIndex === websiteIndex
              }
              onDelete={() => {
                void deleteWebsite(website).catch(() => undefined);
              }}
            />
            <button
              className={`block aspect-video w-full cursor-pointer overflow-hidden border-0 p-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300 ${getPreviewContainerClassName(website.url)}`}
              type="button"
              onClick={(event) => {
                if (isSelectingForDelete) {
                  event.preventDefault();
                  return;
                }

                window.clearTimeout(previewClickTimeoutRef.current);
                previewClickTimeoutRef.current = window.setTimeout(() => {
                  openWebsite(website.url);
                }, 220);
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                window.clearTimeout(previewClickTimeoutRef.current);
                void refreshPreview(website);
              }}
              aria-label={`Open ${website.name}`}
            >
              <WebsitePreview
                website={website}
                refreshKey={previewRefreshKeys[getPreviewCacheKey(website)] ?? 0}
              />
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default App;
