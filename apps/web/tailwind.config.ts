import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.25rem",
      screens: { "2xl": "1440px" },
    },
    extend: {
      colors: {
        ink: "#111827",
        canvas: "#f5f7fb",
        line: "#e5eaf2",
        navy: "#101828",
        coral: "#f26b5b",
        mint: "#3bbf9b",
      },
      boxShadow: {
        soft: "0 8px 30px rgba(16, 24, 40, 0.06)",
        panel: "0 1px 2px rgba(16, 24, 40, 0.03), 0 12px 32px rgba(16, 24, 40, 0.05)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
