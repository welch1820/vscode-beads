/**
 * ContextMenu
 *
 * A cursor-positioned popup menu rendered into document.body via a portal.
 * Clamps itself inside the viewport and dismisses on outside-click, a second
 * right-click, Escape, scroll, or resize. Items are plain entries or a
 * "separator" string.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export type ContextMenuEntry = ContextMenuItem | "separator";

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp inside the viewport once the menu has a measured size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const pad = 4;
    let nx = x;
    let ny = y;
    if (nx + rect.width > window.innerWidth - pad) {
      nx = window.innerWidth - rect.width - pad;
    }
    if (ny + rect.height > window.innerHeight - pad) {
      ny = window.innerHeight - rect.height - pad;
    }
    setPos({ x: Math.max(pad, nx), y: Math.max(pad, ny) });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("contextmenu", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("contextmenu", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  if (items.length === 0) {
    return null;
  }

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{ top: pos.y, left: pos.x }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item === "separator") {
          return <div key={`sep-${i}`} className="context-menu-separator" />;
        }
        return (
          <button
            key={item.label}
            className={`context-menu-item${item.danger ? " context-menu-item--danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body
  );
}
