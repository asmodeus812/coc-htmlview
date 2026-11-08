import { test } from "node:test";
import * as assert from "node:assert/strict";
import Module from "node:module";
import type { HtmlViewApi } from "../src/api";

// coc.nvim is types only outside the editor: give index.ts a stub with the settings
const nvim = {};
const stub = {
    workspace: {
        nvim,
        root: "/ws",
        expand: (f: string): string => f,
        getConfiguration: () => ({ get: (k: string, d: unknown): unknown => (k === "view.mode" ? "float" : k === "stylesheets" ? ["x.css"] : d) })
    },
    window: { showWarningMessage: async (): Promise<void> => undefined }
};
const load = (Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown })._load;
(Module as unknown as { _load: unknown })._load = (request: string, ...rest: unknown[]): unknown => (request === "coc.nvim" ? stub : load(request, ...rest));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const htmlview = require("../src/index") as typeof import("../src/index");

test("index: activate is the only runtime export", () => {
    assert.deepEqual(Object.keys(htmlview), ["activate"]);
    assert.equal(typeof htmlview.activate, "function");
});

test("index: activate returns the versioned api", () => {
    const api: HtmlViewApi = htmlview.activate({} as never);
    assert.deepEqual(Object.keys(api), ["version", "render"]);
    assert.equal(api.version, 1);
    assert.equal(typeof api.render, "function");
});
