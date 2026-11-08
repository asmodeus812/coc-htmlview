/** Stylesheets bundled as text (esbuild `loader: { ".css": "text" }`). */
declare module "*.css" {
    const text: string;
    export default text;
}

/** Lua sources bundled as text (esbuild `loader: { ".lua": "text" }`). */
declare module "*.lua" {
    const text: string;
    export default text;
}
