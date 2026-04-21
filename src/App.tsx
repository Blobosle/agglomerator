import { useEffect, useMemo, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

type WebsiteRecord = {
  name: string;
  url: string;
  addedAt: number;
};

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
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(getOpenableUrl(url))}?w=640`;
}

function getDisplayUrl(url: string) {
  return url.replace(/^https?:\/\//, "");
}

function getHostName(url: string) {
  try {
    return new URL(getOpenableUrl(url)).hostname.replace(/^www\./, "");
  } catch {
    return getDisplayUrl(url);
  }
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

function WebsitePreview({ website }: { website: WebsiteRecord }) {
  const [hasPreviewError, setHasPreviewError] = useState(false);

  if (hasPreviewError) {
    return (
      <span className="flex h-full w-full items-center justify-center bg-slate-100 px-4 text-center text-sm text-slate-500 [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace]">
        {getHostName(website.url)}
      </span>
    );
  }

  return (
    <img
      className="h-full w-full object-cover"
      src={getPreviewUrl(website.url)}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setHasPreviewError(true)}
    />
  );
}

function App() {
  const [websites, setWebsites] = useState<WebsiteRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSelectingForDelete, setIsSelectingForDelete] = useState(false);
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
    setIsSelectingForDelete(false);
  }

  return (
    <main className="min-h-screen bg-white text-slate-950">
      <div
        className="h-9 select-none bg-white"
        data-tauri-drag-region
        onPointerDown={startWindowDrag}
      />
      <div className="flex items-center gap-4 px-5 py-3">
        <input
          className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-slate-950 outline-none [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] placeholder:text-slate-400"
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
      <ul className="grid w-full grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]">
        {filteredWebsites.map((website) => (
          <li
            className="grid grid-cols-[minmax(0,2fr)_minmax(4.5rem,1fr)] items-center gap-x-4 gap-y-3 border-r border-slate-200 px-5 py-4"
            key={website.url}
          >
            <button
              className={`min-w-0 truncate border-0 bg-transparent p-0 text-left font-medium text-slate-900 [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] focus-visible:outline-2 focus-visible:outline-offset-4 ${
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
              {website.name}
            </button>
            <button
              className={`min-w-0 truncate border-0 bg-transparent p-0 text-right [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 ${
                isSelectingForDelete
                  ? "cursor-pointer bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-900 focus-visible:outline-red-300"
                  : "text-blue-700 focus-visible:outline-blue-300"
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
              {getDisplayUrl(website.url)}
            </button>
            <button
              className="col-span-2 block aspect-video w-full overflow-hidden border-0 bg-slate-100 p-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300"
              type="button"
              onClick={(event) => {
                if (isSelectingForDelete) {
                  event.preventDefault();
                  return;
                }

                openWebsite(website.url);
              }}
              aria-label={`Open ${website.name}`}
            >
              <WebsitePreview website={website} />
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default App;
