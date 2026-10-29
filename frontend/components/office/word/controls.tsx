"use client";

import { useEffect, useRef, useState, type ReactNode, type SVGProps } from "react";

/**
 * Ribbon controls. Every button swallows mousedown so clicking it never takes
 * focus (and with it the text selection) away from the document.
 */
export function ToolButton({
  title,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={`tool-btn ${active ? "tool-btn-active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A ribbon button that opens a panel underneath; closes on outside click or Esc. */
export function Dropdown({
  title,
  label,
  disabled = false,
  active = false,
  children,
}: {
  title: string;
  label: ReactNode;
  disabled?: boolean;
  active?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-expanded={open}
        disabled={disabled}
        className={`tool-btn gap-0.5 ${open || active ? "tool-btn-active" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <ChevronDown />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 animate-fade-in rounded border border-chrome-700 bg-chrome-850 p-2 shadow-panel">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Swatch grid with an "automatic"/"none" choice and, optionally, a custom colour. */
export function ColorPanel({
  colors,
  current,
  noneLabel,
  columns = 5,
  custom = false,
  onPick,
}: {
  colors: string[];
  current: string | null;
  noneLabel: string;
  columns?: number;
  custom?: boolean;
  onPick: (color: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // The native "change" event fires once the picker closes; React's onChange
  // fires on every drag step, which would flood the undo history.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onChange = () => onPick(input.value);
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, [onPick]);

  const cur = current?.toLowerCase() ?? null;
  return (
    <div className="flex w-max flex-col gap-2">
      <button
        type="button"
        className="tool-btn h-7 justify-start text-sm"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(null)}
      >
        <span className="h-3.5 w-3.5 rounded-sm border border-chrome-500 bg-transparent" />
        {noneLabel}
      </button>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${columns}, 1.25rem)` }}>
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
            className={`h-5 w-5 rounded-sm border transition-transform hover:scale-110 ${
              cur === c.toLowerCase() ? "border-white ring-1 ring-accent" : "border-chrome-600"
            }`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      {custom && (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-chrome-300">
          <input
            ref={inputRef}
            type="color"
            defaultValue={current && /^#[0-9a-f]{6}$/i.test(current) ? current : "#000000"}
            className="h-6 w-8 cursor-pointer rounded border border-chrome-600 bg-transparent p-0"
          />
          More colours…
        </label>
      )}
    </div>
  );
}

/** URL field for inserting or editing a hyperlink. */
export function LinkPanel({
  current,
  onApply,
  onRemove,
}: {
  current: string | null;
  onApply: (href: string) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(current ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const apply = () => {
    const href = value.trim();
    if (href) onApply(/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") ? href : `https://${href}`);
  };

  return (
    <form
      className="flex w-72 flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <label className="text-2xs font-semibold uppercase tracking-wider text-chrome-400">Address</label>
      <input
        ref={inputRef}
        className="field w-full"
        placeholder="https://example.com"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="flex justify-end gap-1.5">
        {current && (
          <button type="button" className="btn-ghost h-7" onClick={onRemove}>
            Remove link
          </button>
        )}
        <button type="submit" className="btn-primary h-7" disabled={!value.trim()}>
          {current ? "Update" : "Insert"}
        </button>
      </div>
    </form>
  );
}

export function MenuItem({
  onClick,
  disabled = false,
  danger = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex h-7 w-full items-center whitespace-nowrap rounded px-2 text-left text-sm transition-colors hover:bg-chrome-750 disabled:pointer-events-none disabled:opacity-35 ${
        danger ? "text-danger" : "text-chrome-200"
      }`}
    >
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------- //
// Icons the shared set does not have
// --------------------------------------------------------------------------- //

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function ChevronDown() {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden="true" className="opacity-70">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth={1.3} />
    </svg>
  );
}

export const WordIcon = {
  Doc: (p: P) => (
    <Svg {...p}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="m8.5 11 1.2 6 1.6-4.5 1.6 4.5 1.2-6" />
    </Svg>
  ),
  BulletList: (p: P) => (
    <Svg {...p}>
      <circle cx="5" cy="7" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="17" r="1" fill="currentColor" />
      <path d="M9 7h11M9 12h11M9 17h11" />
    </Svg>
  ),
  NumberList: (p: P) => (
    <Svg {...p}>
      <path d="M4 5.5 5.5 5v4" />
      <path d="M4 13.2c.3-.6.8-.9 1.4-.9.7 0 1.2.4 1.2 1 0 .9-1.6 1.6-2.6 2.7h2.7" />
      <path d="M10 7h10M10 12h10M10 17h10" />
    </Svg>
  ),
  Indent: (p: P) => (
    <Svg {...p}>
      <path d="M4 5h16M11 10h9M11 14h9M4 19h16" />
      <path d="m4 9.5 3 2.5-3 2.5" />
    </Svg>
  ),
  Outdent: (p: P) => (
    <Svg {...p}>
      <path d="M4 5h16M11 10h9M11 14h9M4 19h16" />
      <path d="M7 9.5 4 12l3 2.5" />
    </Svg>
  ),
  Table: (p: P) => (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M15 9.5v10" />
    </Svg>
  ),
  Link: (p: P) => (
    <Svg {...p}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  ),
  ClearFormat: (p: P) => (
    <Svg {...p}>
      <path d="M6 5h11M11.5 5 8 19" />
      <path d="m14 14 6 6M20 14l-6 6" />
    </Svg>
  ),
  TextColor: (p: P) => (
    <Svg {...p}>
      <path d="m6.5 16 5.5-12 5.5 12M8.6 11.5h6.8" />
    </Svg>
  ),
  Pdf: (p: P) => (
    <Svg {...p}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H9M13.5 13v4M13.5 13h2M13.5 15h1.6" />
    </Svg>
  ),
  Code: (p: P) => (
    <Svg {...p}>
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4" />
    </Svg>
  ),
};
