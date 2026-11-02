import { createSignal } from "solid-js";

/**
 * Mileage's "Needs you" count for the views column ("Mileage 6"), as the last report read said.
 * Known once Mileage has opened in this tab (the column doesn't read the report on its own).
 */
export const [mileageNeeds, setMileageNeeds] = createSignal<number | null>(null);
