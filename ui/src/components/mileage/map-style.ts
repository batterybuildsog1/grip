/**
 * The street map's style, from the theme tokens (the design kit's shared/map/map.js, ported): a
 * Protomaps flavor where land sits between the frame and the text, roads lean toward the sheet and
 * labels use the muted ink, so the route (the accent) is the one hue that reads. POI icons, road
 * shields and one-way arrows are removed (no icons); street names stay.
 *
 * Tiles and glyphs are operator build settings: VITE_MILEAGE_TILES / VITE_MILEAGE_GLYPHS.
 * Without tiles, return an empty basemap; the route overlay can still render. No dataset ships.
 */
import { type Flavor, layers, namedFlavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";

const absolute = (url: string) => (/^[a-z]+:\/\//i.test(url) ? url : `${location.origin}${url}`);

export const TILES_URL = import.meta.env.VITE_MILEAGE_TILES
	? absolute(import.meta.env.VITE_MILEAGE_TILES)
	: "";
export const GLYPHS_URL = import.meta.env.VITE_MILEAGE_GLYPHS
	? absolute(import.meta.env.VITE_MILEAGE_GLYPHS)
	: undefined;

/** A token's value on <html> (the theme in force). */
export const token = (name: string) =>
	getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function rgb(c: string): number[] {
	const h = c.trim();
	if (h.startsWith("#")) {
		const x = h.length === 4 ? h.replace(/[0-9a-f]/gi, "$&$&") : h;
		return [1, 3, 5].map((i) => Number.parseInt(x.slice(i, i + 2), 16));
	}
	const m = h.match(/rgba?\(([^)]+)\)/);
	return m
		? m[1]
				.split(/[ ,/]+/)
				.slice(0, 3)
				.map(Number)
		: [128, 128, 128];
}
const hex = (a: number[]) =>
	`#${a
		.map((v) =>
			Math.round(Math.max(0, Math.min(255, v)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
/** a toward b by t (0..1). */
export const mix = (a: string, b: string, t: number) => {
	const B = rgb(b);
	return hex(rgb(a).map((v, i) => v + (B[i] - v) * t));
};

/**
 * The flavor for the theme in force. Dark is tuned past the kit's (a known shortfall): minor roads
 * and their names sit a clear step above the land, so a street is readable at street level.
 */
/** The land and minor-road colours of the last style built (the map says them on its element). */
export let lastGround = { earth: "", roadMinor: "" };

function flavor(dark: boolean): Flavor {
	const sheet = token("--mc-sheet");
	const frame = token("--mc-frame");
	const text = token("--mc-text");
	const muted = token("--mc-muted");
	const f = structuredClone(namedFlavor(dark ? "dark" : "light"));
	const earth = dark ? mix(sheet, frame, 0.35) : mix(frame, text, 0.035);
	const road = dark ? mix(earth, text, 0.3) : sheet;
	const roadMinor = dark ? mix(earth, text, 0.21) : road;
	lastGround = { earth, roadMinor };
	const casing = mix(earth, text, dark ? 0.08 : 0.13);
	const water = mix(earth, token("--mc-map-water"), dark ? 0.45 : 0.55);
	const green = mix(earth, token("--mc-map-park"), dark ? 0.35 : 0.4);
	const build = mix(earth, text, 0.06);
	const label = muted;
	Object.assign(f, {
		background: earth,
		earth,
		buildings: build,
		water,
		pier: earth,
		park_a: green,
		park_b: green,
		wood_a: green,
		wood_b: green,
		scrub_a: earth,
		scrub_b: earth,
		zoo: green,
		hospital: earth,
		industrial: earth,
		school: earth,
		pedestrian: earth,
		sand: earth,
		beach: earth,
		glacier: earth,
		aerodrome: earth,
		runway: casing,
		military: earth,
		highway: road,
		major: road,
		link: road,
		minor_a: roadMinor,
		minor_b: roadMinor,
		minor_service: roadMinor,
		other: roadMinor,
		bridges_highway: road,
		bridges_major: road,
		bridges_link: road,
		bridges_minor: roadMinor,
		bridges_other: roadMinor,
		tunnel_highway: road,
		tunnel_major: road,
		tunnel_link: road,
		tunnel_minor: roadMinor,
		tunnel_other: roadMinor,
		railway: casing,
		boundaries: casing,
		roads_label_minor: label,
		roads_label_minor_halo: earth,
		roads_label_major: label,
		roads_label_major_halo: earth,
		address_label: label,
		address_label_halo: earth,
		subplace_label: label,
		subplace_label_halo: earth,
		city_label: label,
		city_label_halo: earth,
		state_label: label,
		state_label_halo: earth,
		country_label: label,
		ocean_label: label,
	});
	const loose = f as unknown as Record<string, unknown>;
	for (const k of Object.keys(loose)) if (/casing/.test(k)) loose[k] = casing;
	if (f.landcover) {
		f.landcover = Object.fromEntries(
			Object.keys(f.landcover).map((k) => [k, /forest|grass|farm/.test(k) ? green : earth]),
		) as unknown as typeof f.landcover;
	}
	return f;
}

export function mapStyle(): StyleSpecification {
	const dark = document.documentElement.dataset.mode === "dark";
	const drawn = layers("protomaps", flavor(dark), { lang: "en" })
		.filter((l) => !["pois", "roads_shields", "roads_oneway"].includes(l.id))
		.map((l) => {
			const layout = (l as { layout?: Record<string, unknown> }).layout;
			if (layout && "icon-image" in layout) {
				const { "icon-image": _, ...rest } = layout;
				return { ...l, layout: rest } as typeof l;
			}
			return l;
		});
	return {
		version: 8,
		glyphs: GLYPHS_URL,
		sources: TILES_URL
			? {
					protomaps: {
						type: "vector",
						url: `pmtiles://${TILES_URL}`,
						attribution: import.meta.env.VITE_MILEAGE_ATTRIBUTION || "© OpenStreetMap",
					},
				}
			: {},
		layers: TILES_URL ? drawn : [],
	};
}
