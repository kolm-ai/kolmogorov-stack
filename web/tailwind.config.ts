import type { Config } from "tailwindcss";

/**
 * The kolm design system, ported from public/kolm-2026.css.
 *
 * Colours are exposed as CSS variables in app/globals.css (warm paper light +
 * the deep "ledger" dark) and referenced here as raw hex tokens so the static
 * vocabulary survives the migration one-to-one. shadcn/ui semantic tokens
 * (background/foreground/primary/...) are mapped onto the same palette so the
 * generated components inherit the brand without a second source of truth.
 *
 * THREE VOICES: display = Cabinet Grotesk, sans = Switzer, mono = Spline Sans
 * Mono. Mono only where a machine speaks (hashes, control IDs, the verifier).
 */
const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "24px",
      screens: { "2xl": "1140px" },
    },
    extend: {
      colors: {
        // ---- shadcn/ui semantic tokens (mapped onto the kolm palette) ----
        border: "var(--line)",
        input: "var(--line-2)",
        ring: "var(--accent)",
        background: "var(--paper)",
        foreground: "var(--ink)",
        primary: {
          DEFAULT: "var(--accent)",
          foreground: "var(--on-accent)",
        },
        secondary: {
          DEFAULT: "var(--paper-sink)",
          foreground: "var(--ink)",
        },
        muted: {
          DEFAULT: "var(--paper-sink)",
          foreground: "var(--ink-3)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--on-accent)",
          text: "var(--accent-text)",
          soft: "var(--accent-soft)",
          edge: "var(--accent-edge)",
          ink: "var(--accent-on-ink)",
        },
        destructive: {
          DEFAULT: "var(--void)",
          foreground: "var(--paper-2)",
        },
        card: {
          DEFAULT: "var(--paper-2)",
          foreground: "var(--ink)",
        },
        popover: {
          DEFAULT: "var(--paper-2)",
          foreground: "var(--ink)",
        },
        // ---- raw kolm tokens (verbatim from kolm-2026.css) ----
        paper: {
          DEFAULT: "var(--paper)",
          2: "var(--paper-2)",
          sink: "var(--paper-sink)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          2: "var(--ink-2)",
          3: "var(--ink-3)",
          faint: "var(--ink-faint)",
          deep: "var(--ink-deep)",
          "deep-2": "var(--ink-deep-2)",
        },
        "on-ink": {
          DEFAULT: "var(--on-ink)",
          2: "var(--on-ink-2)",
          3: "var(--on-ink-3)",
        },
        void: {
          DEFAULT: "var(--void)",
          soft: "var(--void-soft)",
          edge: "var(--void-edge)",
        },
        line: {
          DEFAULT: "var(--line)",
          2: "var(--line-2)",
        },
      },
      fontFamily: {
        display: ["var(--font-display)"],
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      borderRadius: {
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
        pill: "var(--r-pill)",
      },
      maxWidth: {
        wrap: "1140px",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "none" },
        },
        livedot: {
          "0%": { boxShadow: "0 0 0 0 rgba(17,135,90,0.45)" },
          "70%,100%": { boxShadow: "0 0 0 7px rgba(17,135,90,0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 360ms cubic-bezier(0.2,0.7,0.2,1) both",
        livedot: "livedot 2.4s cubic-bezier(0.2,0.7,0.2,1) infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
