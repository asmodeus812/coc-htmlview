import { test } from "node:test";
import * as assert from "node:assert/strict";
import { cellToByte, displayWidth, MarkPriority } from "./index";

test("common: display widths", () => {
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("日本"), 4);
    assert.equal(displayWidth("🔥"), 2);
    assert.equal(displayWidth("é"), 1);
});

test("common: cell to byte", () => {
    assert.equal(cellToByte("│ ab", 2), 4);
    assert.equal(cellToByte("日本x", 4), 6);
    assert.equal(cellToByte("日本x", 1), 0);
    assert.equal(cellToByte("ab", 10), 2);
});

test("common: priority bands are ordered", () => {
    assert.ok(MarkPriority.line < MarkPriority.style && MarkPriority.style < MarkPriority.code);
    assert.ok(MarkPriority.code < MarkPriority.ui);
});
