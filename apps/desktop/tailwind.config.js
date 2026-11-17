/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "hsl(var(--bg))", side: "hsl(var(--side))", bubble: "hsl(var(--bubble))", theirs: { DEFAULT: "hsl(var(--theirs))", line: "hsl(var(--theirs-line))" },
        mine: { DEFAULT: "hsl(var(--mine))", fg: "hsl(var(--mine-fg))" },
        brand: { DEFAULT: "hsl(var(--brand))", fg: "hsl(var(--brand-fg))", soft: "hsl(var(--brand-soft))" },
        rail: { DEFAULT: "hsl(var(--rail))", fg: "hsl(var(--rail-fg))", hover: "hsl(var(--rail-hover))" },
        me: { DEFAULT: "hsl(var(--me))", fg: "hsl(var(--me-fg))" }, btn: { DEFAULT: "hsl(var(--btn))", fg: "hsl(var(--btn-fg))" },
        fg: { DEFAULT: "hsl(var(--fg))", 2: "hsl(var(--fg2))", 3: "hsl(var(--fg3))" },
        line: "hsl(var(--line))", hover: "hsl(var(--hover))", sel: "hsl(var(--sel))", elev: "hsl(var(--elev))", quote: "hsl(var(--quote))",
        warm: { DEFAULT: "hsl(var(--warm))", dot: "hsl(var(--warm-dot))", soft: "hsl(var(--warm-soft))" },
        ok: "hsl(var(--ok))",
        run: { DEFAULT: "hsl(var(--run))", soft: "hsl(var(--run-soft))" },
        err: { DEFAULT: "hsl(var(--err))", soft: "hsl(var(--err-soft))" },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      transitionTimingFunction: { out: "var(--ease-out)", "in-out": "var(--ease-in-out)" },
      transitionDuration: { fast: "var(--dur-fast)", base: "var(--dur-base)", slow: "var(--dur-slow)" },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
