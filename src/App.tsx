import { useMemo, useState, type PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import websitesData from "./websites.json";

type WebsiteRecord = {
  name: string;
  url: string;
  addedAt: string;
};

const websites = [...(websitesData as WebsiteRecord[])].sort(
  (firstWebsite, secondWebsite) =>
    Date.parse(secondWebsite.addedAt) - Date.parse(firstWebsite.addedAt),
);

function startWindowDrag(event: PointerEvent<HTMLDivElement>) {
  if (event.button !== 0) {
    return;
  }

  void getCurrentWindow().startDragging().catch(() => undefined);
}

function App() {
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredWebsites = useMemo(() => {
    if (!normalizedSearchQuery) {
      return websites;
    }

    return websites.filter((website) => {
      const searchableText = `${website.name} ${website.url}`.toLowerCase();

      return searchableText.includes(normalizedSearchQuery);
    });
  }, [normalizedSearchQuery]);

  return (
    <main className="min-h-screen bg-white text-slate-950">
      <div
        className="h-9 select-none bg-white"
        data-tauri-drag-region
        onPointerDown={startWindowDrag}
      />
      <div className="px-5 py-3">
        <input
          className="h-9 w-full border-0 bg-transparent px-0 text-sm text-slate-950 outline-none [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] placeholder:text-slate-400"
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          placeholder="Search"
          aria-label="Search websites by name or link"
        />
      </div>
      <ul className="grid w-full grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]">
        {filteredWebsites.map((website) => (
          <li
            className="grid min-h-14 grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-center gap-x-6 border-r border-slate-200 px-5 py-4"
            key={website.url}
          >
            <span className="min-w-0 truncate font-medium text-slate-900 [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace]">
              {website.name}
            </span>
            <a
              className="min-w-0 truncate text-right text-blue-700 [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300"
              href={website.url}
              target="_blank"
              rel="noreferrer"
            >
              {website.url.replace("https://", "")}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default App;
