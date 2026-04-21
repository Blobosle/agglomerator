import { useCallback, useEffect, useState } from "react";

export type KeyboardNavigationCommand =
  | "next"
  | "previous"
  | "rowEnd"
  | "rowStart"
  | "rowUp"
  | "rowDown"
  | "open"
  | "enterDeleteMode"
  | "cancelDeleteMode";

type WebsiteMovementCommand = Exclude<
  KeyboardNavigationCommand,
  "open" | "enterDeleteMode" | "cancelDeleteMode"
>;

export type KeybindingMap = Record<KeyboardNavigationCommand, string[]>;

type UseWebsiteKeybindNavigationOptions = {
  itemCount: number;
  columnCount: number;
  isEnabled: boolean;
  isDeleteMode: boolean;
  keybindings: KeybindingMap;
  onCancelDeleteMode: () => void;
  onEnterDeleteMode: () => void;
  onMoveAboveFirstRow: () => void;
  onOpen: (index: number) => void;
};

export const MAX_KEYBINDINGS_PER_COMMAND = 3;

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  next: ["w", "ArrowRight"],
  previous: ["b", "ArrowLeft"],
  rowEnd: ["W"],
  rowStart: ["B"],
  rowUp: ["ArrowUp"],
  rowDown: ["ArrowDown"],
  open: ["Enter"],
  enterDeleteMode: ["d"],
  cancelDeleteMode: ["Escape"],
};

export const KEYBINDING_COMMAND_LABELS: Record<KeyboardNavigationCommand, string> = {
  next: "Next entry",
  previous: "Previous entry",
  rowEnd: "End of row",
  rowStart: "Beginning of row",
  rowUp: "Row up",
  rowDown: "Row down",
  open: "Open entry",
  enterDeleteMode: "Enter delete mode",
  cancelDeleteMode: "Cancel delete mode",
};

export const KEYBINDING_COMMANDS = Object.keys(
  DEFAULT_KEYBINDINGS,
) as KeyboardNavigationCommand[];

export function getKeybindingFromEvent(event: Pick<KeyboardEvent, "key">) {
  return event.key;
}

export function formatKeybindingLabel(keybinding: string) {
  if (keybinding === " ") {
    return "Space";
  }

  if (keybinding.startsWith("Arrow")) {
    return keybinding.replace("Arrow", "");
  }

  return keybinding;
}

export function normalizeKeybindings(keybindings: Partial<KeybindingMap>) {
  return KEYBINDING_COMMANDS.reduce<KeybindingMap>((currentKeybindings, command) => {
    const uniqueBindings = Array.from(
      new Set(
        (keybindings[command] ?? DEFAULT_KEYBINDINGS[command]).filter(Boolean),
      ),
    );

    currentKeybindings[command] = uniqueBindings.slice(
      0,
      MAX_KEYBINDINGS_PER_COMMAND,
    );

    return currentKeybindings;
  }, {} as KeybindingMap);
}

function getKeyboardNavigationCommand(
  event: KeyboardEvent,
  keybindings: KeybindingMap,
): KeyboardNavigationCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }

  const key = getKeybindingFromEvent(event);
  const normalizedKeybindings = normalizeKeybindings(keybindings);
  const matchingCommand = KEYBINDING_COMMANDS.find((command) =>
    normalizedKeybindings[command].includes(key),
  );

  return matchingCommand ?? null;
}

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest("input, textarea, select, [contenteditable]"),
  );
}

function getNextWebsiteIndex({
  currentIndex,
  command,
  columnCount,
  itemCount,
}: {
  currentIndex: number | null;
  command: WebsiteMovementCommand;
  columnCount: number;
  itemCount: number;
}) {
  if (itemCount === 0) {
    return null;
  }

  const normalizedColumnCount = Math.max(1, columnCount);

  if (currentIndex === null || currentIndex < 0 || currentIndex >= itemCount) {
    if (command === "previous") {
      return itemCount - 1;
    }

    if (command === "rowEnd") {
      return Math.min(normalizedColumnCount - 1, itemCount - 1);
    }

    return 0;
  }

  if (command === "next") {
    return Math.min(currentIndex + 1, itemCount - 1);
  }

  if (command === "previous") {
    return Math.max(currentIndex - 1, 0);
  }

  if (command === "rowUp") {
    return Math.max(currentIndex - normalizedColumnCount, 0);
  }

  if (command === "rowDown") {
    return Math.min(currentIndex + normalizedColumnCount, itemCount - 1);
  }

  const rowStartIndex =
    Math.floor(currentIndex / normalizedColumnCount) * normalizedColumnCount;

  if (command === "rowEnd") {
    return Math.min(rowStartIndex + normalizedColumnCount - 1, itemCount - 1);
  }

  return rowStartIndex;
}

export function useWebsiteKeybindNavigation({
  itemCount,
  columnCount,
  isEnabled,
  isDeleteMode,
  keybindings,
  onCancelDeleteMode,
  onEnterDeleteMode,
  onMoveAboveFirstRow,
  onOpen,
}: UseWebsiteKeybindNavigationOptions) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isKeyboardMode, setIsKeyboardMode] = useState(false);

  useEffect(() => {
    setActiveIndex((currentIndex) => {
      if (currentIndex === null || currentIndex < itemCount) {
        return currentIndex;
      }

      return itemCount === 0 ? null : itemCount - 1;
    });
  }, [itemCount]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isEnabled) {
        return;
      }

      const command = getKeyboardNavigationCommand(event, keybindings);

      if (!command) {
        return;
      }

      if (command === "cancelDeleteMode") {
        if (isDeleteMode) {
          event.preventDefault();
          setIsKeyboardMode(false);
          onCancelDeleteMode();
        }

        return;
      }

      if (isTextEditingTarget(event.target)) {
        return;
      }

      if (command === "enterDeleteMode") {
        event.preventDefault();
        setIsKeyboardMode(false);
        onEnterDeleteMode();
        return;
      }

      if (isDeleteMode) {
        return;
      }

      const normalizedColumnCount = Math.max(1, columnCount);

      if (command === "open") {
        if (isKeyboardMode && activeIndex !== null) {
          event.preventDefault();
          onOpen(activeIndex);
        }

        return;
      }

      event.preventDefault();

      if (
        command === "rowUp" &&
        activeIndex !== null &&
        activeIndex < normalizedColumnCount
      ) {
        setIsKeyboardMode(false);
        onMoveAboveFirstRow();
        return;
      }

      setActiveIndex((currentIndex) =>
        getNextWebsiteIndex({
          currentIndex,
          command,
          columnCount,
          itemCount,
        }),
      );
      setIsKeyboardMode(true);
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeIndex,
    columnCount,
    isDeleteMode,
    isEnabled,
    isKeyboardMode,
    itemCount,
    keybindings,
    onCancelDeleteMode,
    onEnterDeleteMode,
    onMoveAboveFirstRow,
    onOpen,
  ]);

  const stopKeyboardMode = useCallback(() => {
    setIsKeyboardMode(false);
  }, []);

  const rememberHoveredIndex = useCallback((index: number) => {
    setActiveIndex(index);
  }, []);

  const startKeyboardModeAtIndex = useCallback(
    (index: number) => {
      if (itemCount === 0) {
        return;
      }

      setActiveIndex(Math.min(Math.max(index, 0), itemCount - 1));
      setIsKeyboardMode(true);
    },
    [itemCount],
  );

  return {
    activeIndex,
    isKeyboardMode,
    rememberHoveredIndex,
    startKeyboardModeAtIndex,
    stopKeyboardMode,
  };
}
