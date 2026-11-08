/**
 * The htmlview engine: a browser-style core. html → dom → (css + style) → layout → Layout → view. Each part's
 * index.ts is its contract (see doc/CONTRACT.md); this file only re-exports the parts. Nothing here imports
 * host-extension code.
 */
export * as dom from "./dom";
export * as css from "./css";
export * as style from "./style";
export * as layout from "./layout";
export * as interact from "./interact";
export { defaultHostVars } from "./style/host";

export type { HtmlPrepass } from "../api";
