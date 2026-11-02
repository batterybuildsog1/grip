import { defineConfig, presetWind, transformerDirectives } from "unocss";

// Every colour, face, corner and shadow reads a --mc-* token (src/styles/themes.css: Grip, Light and
// Dark; design/finals/T1/NOTES.md "Web mapping"). Usage: `bg-sheet
// text-muted border-border rounded-box font-read shadow-float`.
export default defineConfig({
	darkMode: "class",
	presets: [presetWind()],
	transformers: [transformerDirectives()],
	theme: {
		colors: {
			frame: "var(--mc-frame)",
			sheet: "var(--mc-sheet)",
			raised: "var(--mc-raised)",
			border: "var(--mc-border)",
			rule: "var(--mc-rule)",
			control: "var(--mc-control)",
			text: "var(--mc-text)",
			muted: "var(--mc-muted)",
			faint: "var(--mc-faint)",
			accent: { DEFAULT: "var(--mc-accent)", soft: "var(--mc-accent-soft)", on: "var(--mc-on-accent)" },
			primary: { DEFAULT: "var(--mc-primary)", on: "var(--mc-on-primary)" },
			neg: { DEFAULT: "var(--mc-neg)", soft: "var(--mc-neg-soft)", on: "var(--mc-on-neg)" },
			warn: { DEFAULT: "var(--mc-warn)", soft: "var(--mc-warn-soft)" },
			mark: "var(--mc-mark)",
			toast: { DEFAULT: "var(--mc-toast)", on: "var(--mc-on-toast)" },
			focus: "var(--mc-focus)",
			scrim: "var(--mc-scrim)",
		},
		fontFamily: { ui: "var(--mc-font-ui)", read: "var(--mc-font-read)" },
		borderRadius: {
			control: "var(--mc-radius-control)",
			box: "var(--mc-radius-box)",
			sheet: "var(--mc-radius-sheet)",
		},
		boxShadow: { float: "var(--mc-shadow)" },
	},
});
