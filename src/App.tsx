import type { PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type WebsiteRecord = {
  name: string;
  url: string;
};

const websites: WebsiteRecord[] = [
  {
    name: "OpenAI",
    url: "https://openai.com",
  },
  {
    name: "Tauri",
    url: "https://tauri.app",
  },
  {
    name: "React",
    url: "https://react.dev",
  },
  {
    name: "Vite",
    url: "https://vite.dev",
  },
];

function startWindowDrag(event: PointerEvent<HTMLDivElement>) {
  if (event.button !== 0) {
    return;
  }

  void getCurrentWindow().startDragging().catch(() => undefined);
}

function App() {
  return (
    <main className="min-h-screen bg-white text-slate-950">
      <div
        className="h-9 select-none border-b border-slate-200 bg-white"
        data-tauri-drag-region
        onPointerDown={startWindowDrag}
      />
      <ul className="w-full divide-y divide-slate-200">
        {websites.map((website) => (
          <li
            className="flex min-h-14 items-center justify-between gap-6 px-5 py-4"
            key={website.url}
          >
            <span className="min-w-0 font-medium text-slate-900 [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace]">
              {website.name}
            </span>
            <a
              className="min-w-0 break-words text-right text-blue-700 [font-family:SFMonoNerd,ui-monospace,SFMono-Regular,Menlo,monospace] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300"
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
