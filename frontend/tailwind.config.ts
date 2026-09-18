import type { Config } from "tailwindcss";

/**
 * Palette is modelled on Acrobat Pro's dark chrome: a near-black workspace,
 * graphite panels, and a single saturated accent for active tools.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        chrome: {
          950: "#141416",
          900: "#1b1b1f",
          850: "#232328",
          800: "#2a2a30",
          750: "#33333a",
          700: "#3d3d45",
          600: "#4d4d57",
          500: "#6b6b77",
          400: "#8e8e9a",
          300: "#b4b4be",
          200: "#d6d6dc",
          100: "#ececf0",
        },
        accent: {
          DEFAULT: "#1473e6",
          hover: "#0d66d0",
          soft: "#1473e626",
          ring: "#1473e666",
        },
        danger: "#e34850",
        warn: "#e68619",
        ok: "#2d9d78",
        canvas: "#4a4a52",
      },
      fontFamily: {
        ui: [
          "Segoe UI",
          "system-ui",
          "-apple-system",
          "Inter",
          "Roboto",
          "Helvetica Neue",
          "sans-serif",
        ],
        mono: ["Cascadia Mono", "Consolas", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["10px", "13px"],
        xs: ["11px", "15px"],
        sm: ["12px", "17px"],
        base: ["13px", "19px"],
      },
      boxShadow: {
        panel: "0 8px 28px rgba(0,0,0,.45)",
        page: "0 2px 6px rgba(0,0,0,.35), 0 12px 32px rgba(0,0,0,.30)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in .12s ease-out",
        "slide-up": "slide-up .14s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
