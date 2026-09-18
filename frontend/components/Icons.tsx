/**
 * Inline SVG icon set.
 *
 * Drawn locally rather than pulled from an icon package so the app has no
 * runtime network dependency and no third-party script in the bundle.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps) {
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

export const Icon = {
  Open: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7L11.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  ),
  Download: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </Svg>
  ),
  Undo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 7 4 12l5 5" />
      <path d="M4 12h10a6 6 0 0 1 0 12h-3" />
    </Svg>
  ),
  Redo: (p: IconProps) => (
    <Svg {...p}>
      <path d="m15 7 5 5-5 5" />
      <path d="M20 12H10a6 6 0 0 0 0 12h3" />
    </Svg>
  ),
  Cursor: (p: IconProps) => (
    <Svg {...p}>
      <path d="m5 3 7 18 2.5-7L21 11Z" />
    </Svg>
  ),
  TextEdit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6V4h12v2" />
      <path d="M10 4v14" />
      <path d="M8 18h4" />
      <path d="m15 17 5-5 2.5 2.5-5 5H15Z" />
    </Svg>
  ),
  TextAdd: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 6V4h11v2" />
      <path d="M8.5 4v14" />
      <path d="M6.5 18h4" />
      <path d="M18 12v8M14 16h8" />
    </Svg>
  ),
  Image: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
    </Svg>
  ),
  Highlight: (p: IconProps) => (
    <Svg {...p}>
      <path d="m8 15 6-9 4 3-6 9H8Z" />
      <path d="M4 20h9" />
    </Svg>
  ),
  Underline: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 4v7a5 5 0 0 0 10 0V4" />
      <path d="M5 20h14" />
    </Svg>
  ),
  Strike: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 12h14" />
      <path d="M8 8a4 4 0 0 1 8 0" />
      <path d="M16 16a4 4 0 0 1-8 0" />
    </Svg>
  ),
  Comment: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 5h16v11H9l-5 4Z" />
    </Svg>
  ),
  Redact: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="8" width="18" height="8" rx="1" fill="currentColor" stroke="none" />
      <path d="M3 5h18M3 19h18" />
    </Svg>
  ),
  Pages: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="3" width="10" height="13" rx="1.5" />
      <path d="M8 8h13v13H11" />
    </Svg>
  ),
  Search: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Svg>
  ),
  ZoomIn: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M11 8.5v5M8.5 11h5M16 16l4.5 4.5" />
    </Svg>
  ),
  ZoomOut: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M8.5 11h5M16 16l4.5 4.5" />
    </Svg>
  ),
  FitPage: (p: IconProps) => (
    <Svg {...p}>
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </Svg>
  ),
  FitWidth: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 12h18" />
      <path d="m6 9-3 3 3 3M18 9l3 3-3 3" />
    </Svg>
  ),
  Rotate: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </Svg>
  ),
  Trash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </Svg>
  ),
  Copy: (p: IconProps) => (
    <Svg {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Svg>
  ),
  Plus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  Split: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v18" strokeDasharray="3 3" />
      <rect x="2" y="6" width="7" height="12" rx="1.5" />
      <rect x="15" y="6" width="7" height="12" rx="1.5" />
    </Svg>
  ),
  Merge: (p: IconProps) => (
    <Svg {...p}>
      <rect x="2" y="4" width="8" height="10" rx="1.5" />
      <rect x="14" y="10" width="8" height="10" rx="1.5" />
      <path d="M10 9h4" />
    </Svg>
  ),
  Lock: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Svg>
  ),
  Unlock: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 7.5-1.9" />
    </Svg>
  ),
  Export: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14 3h5v5" />
      <path d="M19 3 10 12" />
      <path d="M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5" />
    </Svg>
  ),
  Spell: (p: IconProps) => (
    <Svg {...p}>
      <path d="m3 16 4.5-11L12 16" />
      <path d="M4.8 12.5h5.4" />
      <path d="m14 15 2.5 2.5L22 12" />
    </Svg>
  ),
  Bold: (p: IconProps) => (
    <Svg {...p} strokeWidth={2}>
      <path d="M7 4h6a4 4 0 0 1 0 8H7Z" />
      <path d="M7 12h7a4 4 0 0 1 0 8H7Z" />
    </Svg>
  ),
  Italic: (p: IconProps) => (
    <Svg {...p} strokeWidth={2}>
      <path d="M15 4h-6M14 4 10 20M15 20H9" />
    </Svg>
  ),
  AlignLeft: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />
    </Svg>
  ),
  AlignCenter: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />
    </Svg>
  ),
  AlignRight: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />
    </Svg>
  ),
  AlignJustify: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />
    </Svg>
  ),
  Sidebar: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Svg>
  ),
  Properties: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </Svg>
  ),
  Chevron: (p: IconProps) => (
    <Svg {...p}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  ),
  Close: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  ),
  Check: (p: IconProps) => (
    <Svg {...p}>
      <path d="m5 13 4 4L19 7" />
    </Svg>
  ),
  Warning: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 4 2.5 20h19Z" />
      <path d="M12 10v4M12 17.5v.5" />
    </Svg>
  ),
  Crop: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 2v16h16" />
      <path d="M2 6h16v16" />
    </Svg>
  ),
  Flip: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v18" strokeDasharray="3 3" />
      <path d="M9 7 4 12l5 5Z" />
      <path d="m15 7 5 5-5 5Z" />
    </Svg>
  ),
  Eye: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </Svg>
  ),
  Book: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4Z" />
      <path d="M20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6Z" />
    </Svg>
  ),
  Number: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />
    </Svg>
  ),
  Compress: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v6M9 6l3 3 3-3" />
      <path d="M12 21v-6M9 18l3-3 3 3" />
      <path d="M4 12h16" />
    </Svg>
  ),
};

export type IconName = keyof typeof Icon;
