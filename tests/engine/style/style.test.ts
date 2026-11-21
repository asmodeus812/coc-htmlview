import { test } from "node:test";
import * as assert from "node:assert/strict";
import { computeStyles, groupName, initialStyle, inheritedProperties, lengthToCells, parseSheets, UA_SHEET } from "../../../src/engine/style/index";
import { defaultHostVars, hostRoles } from "../../../src/engine/style/host";

test("engine/style: lengths compute to cells and lines", () => {
    assert.equal(lengthToCells(2, "ch", "h", 80), 2);
    assert.equal(lengthToCells(1, "em", "v", 80), 1);
    assert.equal(lengthToCells(16, "px", "h", 80), 2);
    assert.equal(lengthToCells(16, "px", "v", 80), 1);
    assert.equal(lengthToCells(50, "%", "h", 80), 40);
    assert.equal(lengthToCells(50, "%", "v", 80), 0);
    assert.ok(Number.isNaN(lengthToCells(1, "vw", "h", 80)));
});

test("engine/style: group naming rule and initial values", () => {
    assert.equal(groupName(".impact-high"), "HtmlViewImpactHigh");
    assert.equal(groupName("--vscode-textLink-foreground"), "HtmlViewVscodeTextLinkForeground");
    assert.equal(initialStyle().display, "inline");
    assert.ok(inheritedProperties.has("color"));
    assert.ok(!inheritedProperties.has("display"));
});

test("engine/style: UA sheet is bundled and host table carries the user decisions", () => {
    assert.match(UA_SHEET, /--htmlview-code/);
    assert.equal(hostRoles.border.links[0], "FloatBorder");
    assert.equal(hostRoles.linkUrl.links[0], "@markup.link.url");
    // @markup.raw is Comment-grey by default (Neovim, habamax): code is painted from a readable accent instead
    assert.deepEqual(hostRoles.inlineCode.links, ["Special", "String"]);
    assert.deepEqual(hostRoles.kbd.links, ["Special"]);
    assert.equal(defaultHostVars["--vscode-textLink-foreground"].role, "linkUrl");
});

test("engine/style: computeStyles and parseSheets are wired to css/", () => {
    assert.equal(typeof computeStyles, "function");
    assert.equal(typeof parseSheets, "function");
});
