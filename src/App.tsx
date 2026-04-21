import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

type WebsiteRecord = {
  name: string;
  url: string;
  addedAt: number;
};

const PREVIEW_CACHE_DB_NAME = "agglomerator-preview-cache";
const PREVIEW_CACHE_STORE_NAME = "previews";
const PREVIEW_CACHE_VERSION = 1;

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
    const youTubeThumbnailUrl = getYouTubeThumbnailUrl(website.url);

    async function setPreviewBlob(previewBlob: Blob) {
      objectUrl = URL.createObjectURL(previewBlob);

      if (isMounted) {
        setPreviewSrc(objectUrl);
      }
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

        await writeCachedPreview(website.url, previewBlob).catch(() => undefined);
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
          attempt += 1;
          retryTimeout = window.setTimeout(loadPreview, 3000);
        };
        previewImage.src = candidateSrc;
      }
    }

    async function initializePreview() {
      setPreviewSrc(null);

      if (youTubeThumbnailUrl) {
        setPreviewSrc(youTubeThumbnailUrl);
        return;
      }

      const cachedPreview = await readCachedPreview(website.url).catch(() => null);

      if (cachedPreview) {
        await setPreviewBlob(cachedPreview);
        return;
      }

      await loadPreview();
    }

    void initializePreview().catch(() => {
      if (isMounted) {
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
  }, [website.url, refreshKey]);

  return (
    previewSrc && (
      <img
        className="h-full w-full object-cover"
        src={previewSrc}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    )
  );
}

function App() {
  const [websites, setWebsites] = useState<WebsiteRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSelectingForDelete, setIsSelectingForDelete] = useState(false);
  const [previewRefreshKeys, setPreviewRefreshKeys] = useState<
    Record<string, number>
  >({});
  const previewClickTimeoutRef = useRef<number | undefined>(undefined);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  useEffect(() => {
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
    await deleteCachedPreview(website.url).catch(() => undefined);
    setPreviewRefreshKeys((currentKeys) => {
      const cacheKey = getPreviewCacheKey(website);

      return {
        ...currentKeys,
        [cacheKey]: (currentKeys[cacheKey] ?? 0) + 1,
      };
    });
  }

  return (
    <main className="min-h-screen bg-white text-slate-950">
      <div
        className="h-6 select-none bg-white"
        data-tauri-drag-region
        onPointerDown={startWindowDrag}
      />
      <div className="flex items-center gap-4 px-5 py-1.5">
        <input
          className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-slate-950 outline-none [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] placeholder:text-slate-400"
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          placeholder="Search"
          aria-label="Search websites by name or link"
        />
        <button
          className="border-0 bg-transparent p-0 text-sm text-red-700 underline [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] hover:bg-red-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-300"
          type="button"
          onClick={() => setIsSelectingForDelete((isSelecting) => !isSelecting)}
        >
          {isSelectingForDelete ? "Cancel" : "Delete"}
        </button>
      </div>
      <ul className="grid w-full grid-cols-[repeat(auto-fill,minmax(15rem,22rem))]">
        {filteredWebsites.map((website) => (
          <li
            className="grid grid-cols-1 gap-y-3 border-r border-slate-200 px-5 py-4"
            key={website.url}
          >
            <div className="relative grid min-h-5 grid-cols-[minmax(0,2fr)_minmax(4.5rem,1fr)] items-start gap-x-4">
              <button
                className={`group/name min-w-0 border-0 bg-transparent p-0 text-left font-medium text-slate-900 [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] focus-visible:outline-2 focus-visible:outline-offset-4 ${
                  isSelectingForDelete
                    ? "cursor-pointer bg-red-50 hover:bg-red-100 hover:text-red-900 focus-visible:outline-red-300"
                    : "cursor-default focus-visible:outline-blue-300"
                }`}
                type="button"
                onClick={() => {
                  if (isSelectingForDelete) {
                    void deleteWebsite(website).catch(() => undefined);
                  }
                }}
              >
                <span className="block truncate">{website.name}</span>
                <span
                  className={`pointer-events-none absolute left-0 top-0 z-10 block max-h-0 w-full origin-top scale-y-0 overflow-hidden whitespace-normal break-words bg-white text-left transition-[max-height,transform] duration-300 ease-out group-hover/name:max-h-40 group-hover/name:scale-y-100 group-focus-visible/name:max-h-40 group-focus-visible/name:scale-y-100 ${
                    isSelectingForDelete ? "group-hover/name:bg-red-100" : ""
                  }`}
                >
                  {website.name}
                </span>
              </button>
              <button
                className={`group/link min-w-0 border-0 bg-transparent p-0 text-right [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 ${
                  isSelectingForDelete
                    ? "cursor-pointer bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-900 focus-visible:outline-red-300"
                    : "cursor-pointer text-blue-700 focus-visible:outline-blue-300"
                }`}
                type="button"
                onClick={(event) => {
                  if (isSelectingForDelete) {
                    event.preventDefault();
                    void deleteWebsite(website).catch(() => undefined);
                    return;
                  }

                  openWebsite(website.url);
                }}
                title={website.url}
              >
                <span className="block truncate">{getDisplayUrl(website.url)}</span>
                <span
                  className={`pointer-events-none absolute right-0 top-0 z-10 block max-h-0 w-full origin-top scale-y-0 overflow-hidden whitespace-normal break-words bg-white text-right transition-[max-height,transform] duration-300 ease-out group-hover/link:max-h-40 group-hover/link:scale-y-100 group-focus-visible/link:max-h-40 group-focus-visible/link:scale-y-100 ${
                    isSelectingForDelete ? "group-hover/link:bg-red-100" : ""
                  }`}
                >
                  {getDisplayUrl(website.url)}
                </span>
              </button>
            </div>
            <button
              className="block aspect-video w-full cursor-pointer overflow-hidden border-0 bg-slate-100 p-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300"
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
