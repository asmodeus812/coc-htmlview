import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DEFAULT_LINK_TARGET, linkTargetText, paintPriority } from "./index";
import type { VirtText } from "../../types";

test("engine/layout: paint priority grows with depth and layer, capped", () => {
    assert.equal(paintPriority(100, 0, 0), 100);
    assert.equal(paintPriority(100, 2, 1), 109);
    assert.equal(paintPriority(100, 2, 9), 111);
    assert.equal(paintPriority(100, 50, 0), 199);
});

test("engine/layout: url links get an inline link-target virtual text, other targets none", () => {
    const vt: VirtText | undefined = linkTargetText({ line: 3, startCol: 2, endCol: 9, target: { kind: "url", href: "https://x.y" } }, DEFAULT_LINK_TARGET.symbol);
    assert.deepEqual(vt, { line: 3, col: 9, pos: "inline", chunks: [{ text: " 🔗 https://x.y", groups: ["HtmlViewHostLinkUrl"] }], role: "link-target" });
    assert.equal(linkTargetText({ line: 0, startCol: 0, endCol: 1, target: { kind: "anchor", id: "a" } }, "🔗"), undefined);
});
