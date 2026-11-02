/**
 * One trip's street map (MapLibre GL over a .pmtiles extract, styled from the theme tokens). It opens
 * close at the endpoint that matters, with "Whole route" / "Close up"; the recording gap is dashed;
 * the two ends carry their names. A map that can't draw says "The map didn't load" with Try again,
 * and the trip's names and addresses stay where they are. Redrawn when the appearance changes.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl, { type LngLatBoundsLike, type Map as MlMap } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import type { MileageTripView } from "../../api/mileage";
import { useApp } from "../../store/app";
import { lastGround, mapStyle, token } from "./map-style";
import { closeUp, type Fix, focusOf, gapOf, routeOf } from "./route";

let protocolAdded = false;
/** PMTiles over MapLibre. After a failure, a fresh protocol: the old one keeps the failed archive. */
function addProtocol(fresh = false) {
	if (protocolAdded && !fresh) return;
	if (protocolAdded) maplibregl.removeProtocol("pmtiles");
	maplibregl.addProtocol("pmtiles", new Protocol().tile);
	protocolAdded = true;
}

type Pad = { top: number; right: number; bottom: number; left: number };
const ll = (p: [number, number] | Fix): [number, number] => [p[1], p[0]];
const boundsOf = (pts: ([number, number] | Fix)[]): LngLatBoundsLike => {
	const b = new maplibregl.LngLatBounds(ll(pts[0]), ll(pts[0]));
	for (const p of pts) b.extend(ll(p));
	return b;
};
const line = (pts: Fix[]) => ({
	type: "Feature" as const,
	properties: {},
	geometry: { type: "LineString" as const, coordinates: pts.map(ll) },
});

export type MapPhase = "loading" | "ready" | "failed";

const MileageMap: Component<{
	trip: MileageTripView;
	/** The map's box (height, corners). */
	class?: string;
	pad?: Pad;
}> = (props) => {
	const [state] = useApp();
	const [phase, setPhase] = createSignal<MapPhase>("loading");
	const [whole, setWhole] = createSignal(false);
	/** What was drawn: the appearance, whether a gap was dashed, the land and minor-road colours. */
	const [drawn, setDrawn] = createSignal({ mode: "", gap: false, earth: "", road: "" });
	const [labels, setLabels] = createSignal<
		{ x: number; y: number; text: string; below: boolean }[]
	>([]);
	let box: HTMLDivElement | undefined;
	let canvasHost: HTMLDivElement | undefined;
	let map: MlMap | null = null;
	let fixes: Fix[] = [];
	let run = 0;
	let retrying = false;

	const pad = () => props.pad ?? { top: 44, right: 48, bottom: 24, left: 48 };
	const frameOf = (w: boolean) => (w ? fixes : closeUp(fixes, focusOf(props.trip)));

	const placeLabels = () => {
		if (!map || !box) return;
		const W = box.clientWidth;
		const H = box.clientHeight;
		const ends: [Fix, string][] = [
			[fixes[0], props.trip.start.name],
			[fixes[fixes.length - 1], props.trip.end.name],
		];
		setLabels(
			ends
				.map(([p, text]) => ({ ...(map as MlMap).project(ll(p)), text }))
				.filter((l) => l.x >= -2 && l.y >= -2 && l.x <= W + 2 && l.y <= H + 2)
				.map((l) => ({ x: l.x, y: l.y, text: l.text, below: l.y < 44 })),
		);
	};

	const draw = async () => {
		const mine = ++run;
		setPhase("loading");
		setLabels([]);
		map?.remove();
		map = null;
		try {
			addProtocol(phase() === "failed" || retrying);
			retrying = false;
			fixes = await routeOf(props.trip);
			if (mine !== run || !canvasHost) return;
			const gap = gapOf(props.trip, fixes);
			const accent = token("--mc-accent");
			const casing = token("--mc-sheet");
			const gapColor = token("--mc-faint");
			const m = new maplibregl.Map({
				container: canvasHost,
				style: mapStyle(),
				bounds: boundsOf(frameOf(whole())),
				fitBoundsOptions: { padding: pad(), maxZoom: 16 },
				interactive: false,
				attributionControl: false,
				fadeDuration: 0,
				// A still picture: keep it in the buffer so a screenshot (and the compositor after a
				// tab switch) shows the streets, not an empty canvas.
				canvasContextAttributes: { preserveDrawingBuffer: true },
			});
			map = m;
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const fail = (why: string) => {
					if (settled) return;
					settled = true;
					reject(new Error(`map: ${why}`));
				};
				const timer = setTimeout(() => fail("timed out"), 20_000);
				m.on("error", (e: { error?: Error; sourceId?: string }) => {
					if (!m.loaded() || e.sourceId === "protomaps") fail(e.error?.message ?? "error");
				});
				m.on("load", () => {
					const parts = gap ? [fixes.slice(0, gap[0] + 1), fixes.slice(gap[1])] : [fixes];
					m.addSource("r-gap", {
						type: "geojson",
						data: {
							type: "FeatureCollection",
							features: gap ? [line(fixes.slice(gap[0], gap[1] + 1))] : [],
						},
					});
					m.addLayer({
						id: "r-gap",
						type: "line",
						source: "r-gap",
						layout: { "line-join": "round" },
						paint: { "line-color": gapColor, "line-width": 3, "line-dasharray": [1, 1.5] },
					});
					m.addSource("r-main", {
						type: "geojson",
						data: {
							type: "FeatureCollection",
							features: parts.filter((p) => p.length > 1).map(line),
						},
					});
					m.addLayer({
						id: "r-main-case",
						type: "line",
						source: "r-main",
						layout: { "line-join": "round", "line-cap": "round" },
						paint: { "line-color": casing, "line-width": 7 },
					});
					m.addLayer({
						id: "r-main",
						type: "line",
						source: "r-main",
						layout: { "line-join": "round", "line-cap": "round" },
						paint: { "line-color": accent, "line-width": 4 },
					});
					const pt = (p: Fix, role: string) => ({
						type: "Feature" as const,
						properties: { role },
						geometry: { type: "Point" as const, coordinates: ll(p) },
					});
					m.addSource("ends", {
						type: "geojson",
						data: {
							type: "FeatureCollection",
							features: [pt(fixes[0], "start"), pt(fixes[fixes.length - 1], "end")],
						},
					});
					m.addLayer({
						id: "ends",
						type: "circle",
						source: "ends",
						paint: {
							"circle-radius": 6,
							"circle-color": ["match", ["get", "role"], "start", casing, accent],
							"circle-stroke-color": ["match", ["get", "role"], "start", accent, casing],
							"circle-stroke-width": ["match", ["get", "role"], "start", 3, 2.5],
						},
					});
					m.once("idle", () => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve();
					});
				});
			});
			if (mine !== run) return;
			placeLabels();
			setDrawn({
				mode: state.appearance,
				gap: !!gap,
				earth: lastGround.earth,
				road: lastGround.roadMinor,
			});
			setPhase("ready");
		} catch (e) {
			if (mine !== run) return;
			console.warn("mileage map", e);
			map?.remove();
			map = null;
			setPhase("failed");
		}
	};

	// Draw for the trip, and again when the appearance changes (the style is built from tokens).
	createEffect(
		on(
			() => [props.trip.id, props.trip.revision, state.appearance] as const,
			([id], prev) => {
				if (!prev || prev[0] !== id) setWhole(false);
				// After the attribute change has applied the new tokens.
				requestAnimationFrame(() => void draw());
			},
		),
	);

	const toggle = () => {
		const next = !whole();
		setWhole(next);
		if (!map || phase() !== "ready") return;
		map.fitBounds(boundsOf(frameOf(next)), { padding: pad(), maxZoom: 16, animate: false });
		map.once("idle", placeLabels);
		placeLabels();
	};

	onCleanup(() => {
		run++;
		map?.remove();
		map = null;
	});

	return (
		<div
			ref={box}
			data-testid="mileage-map"
			data-phase={phase()}
			data-drawn-mode={drawn().mode}
			data-gap={drawn().gap ? "true" : "false"}
			data-earth={drawn().earth}
			data-road-minor={drawn().road}
			data-frame={whole() ? "whole" : focusOf(props.trip)}
			class={`mc-map relative overflow-hidden bg-raised ${props.class ?? ""}`}
		>
			{/* MapLibre makes its container position: relative: the box gives it the full size. */}
			<div ref={canvasHost} class="absolute inset-0 h-full w-full" aria-hidden="true" />
			<Show when={phase() === "failed"}>
				<output
					data-testid="map-failed"
					class="absolute inset-0 z-5 flex flex-col items-start justify-center gap-1.5 bg-raised px-5 py-4"
				>
					<p>
						<b style={{ "font-weight": "var(--mc-strong-weight)" }}>The map didn't load.</b> Both
						addresses are below; nothing about the trip is lost.
					</p>
					<button
						type="button"
						data-testid="map-retry"
						class="font-medium text-accent hover:underline"
						onClick={() => {
							retrying = true;
							void draw();
						}}
					>
						Try again
					</button>
				</output>
			</Show>
			<Show when={phase() !== "failed"}>
				{labels().map((l) => (
					<span
						class="mc-map-label"
						data-below={l.below ? "true" : undefined}
						style={{
							left: `${Math.max(8, Math.min((box?.clientWidth ?? 0) - 8, l.x))}px`,
							top: `${l.y}px`,
						}}
					>
						{l.text}
					</span>
				))}
				<button
					type="button"
					data-testid="map-whole"
					class="mc-map-toggle"
					aria-pressed={whole()}
					onClick={toggle}
				>
					{whole() ? "Close up" : "Whole route"}
				</button>
				<span class="mc-map-attrib">© OpenStreetMap</span>
			</Show>
		</div>
	);
};

export default MileageMap;
