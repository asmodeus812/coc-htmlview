/**
 * The host-theme group table (ENGINE.md "Host-theme groups") as data, and the variable table mapping every host
 * variable the sheets use (`--vscode-*` from the caller's stylesheets, `--htmlview-*` from ua.css) to a role.
 *
 * Groups: one role group per role, `HtmlViewHost<Role>` (`hi def link` to the first group of `links` that
 * exists, the rest as the fallback chain), and one group per variable, `groupName(var)` (`hi def link` to its
 * role group). Users override either level. The document's literal colours never pass through this table.
 * Code tokens (treesitter `@x.lang`, hljs classes) stay highlight/'s business and are not roles here.
 */
import type { ColorAttr } from "./index";

export type HostRole =
    | "canvas"
    | "codeBlock"
    | "inlineCode"
    | "kbd"
    | "heading1"
    | "heading2"
    | "heading3"
    | "heading4"
    | "heading5"
    | "heading6"
    | "link"
    | "linkUrl"
    | "strong"
    | "italic"
    | "underline"
    | "strikethrough"
    | "mark"
    | "quote"
    | "quoteBar"
    | "listMarker"
    | "border"
    | "faintBorder"
    | "tableHeader"
    | "muted"
    | "diffAdd"
    | "diffDelete"
    | "passed"
    | "failed"
    | "warn"
    | "info"
    | "button"
    | "badge"
    | "syntaxNumber"
    | "syntaxString"
    | "syntaxOperator"
    | "syntaxPunctuation"
    | "syntaxVariable"
    | "syntaxKeyword"
    | "syntaxConstant"
    | "syntaxPreProc"
    | "syntaxSpecialComment"
    | "linkCursor"
    | "floatBorder"
    | "floatTitle"
    | "folded";

export interface HostRoleEntry {
    /** `HtmlViewHost<Role>`. */
    group: string;
    /** Native groups, first existing wins (`hi def link` + fallback chain). */
    links: readonly string[];
}

function role(name: string, links: string[]): HostRoleEntry {
    return { group: "HtmlViewHost" + name.charAt(0).toUpperCase() + name.slice(1), links };
}

/** Role → default native link chain. `canvas` is always Normal (also in a float). */
export const hostRoles: Readonly<Record<HostRole, HostRoleEntry>> = Object.freeze({
    canvas: role("canvas", ["Normal"]),
    codeBlock: role("codeBlock", ["ColorColumn", "CursorLine"]),
    inlineCode: role("inlineCode", ["@markup.raw", "Special", "String"]),
    kbd: role("kbd", ["@markup.raw", "Special"]),
    heading1: role("heading1", ["@markup.heading.1", "@markup.heading", "Title"]),
    heading2: role("heading2", ["@markup.heading.2", "@markup.heading", "Title"]),
    heading3: role("heading3", ["@markup.heading.3", "@markup.heading", "Title"]),
    heading4: role("heading4", ["@markup.heading.4", "@markup.heading", "Title"]),
    heading5: role("heading5", ["@markup.heading.5", "@markup.heading", "Title"]),
    heading6: role("heading6", ["@markup.heading.6", "@markup.heading", "Title"]),
    link: role("link", ["@markup.link", "Underlined"]),
    /** Also the group of a link's target shown as virtual text (` 🔗 url`). */
    linkUrl: role("linkUrl", ["@markup.link.url", "Underlined", "Directory"]),
    strong: role("strong", ["@markup.strong"]),
    italic: role("italic", ["@markup.italic"]),
    underline: role("underline", ["@markup.underline"]),
    strikethrough: role("strikethrough", ["@markup.strikethrough"]),
    mark: role("mark", ["Search"]),
    quote: role("quote", ["@markup.quote", "Comment"]),
    quoteBar: role("quoteBar", ["NonText"]),
    listMarker: role("listMarker", ["@markup.list", "Special"]),
    /** Table rules, hr, CSS box borders (user decision: FloatBorder first, WinSeparator is too faint). */
    border: role("border", ["FloatBorder", "WinSeparator", "NonText"]),
    /** A faint line (VS Code's `editor.lineHighlightBorder`); used only by that variable. */
    faintBorder: role("faintBorder", ["NonText", "WinSeparator"]),
    tableHeader: role("tableHeader", ["@markup.heading", "Title"]),
    muted: role("muted", ["Comment", "NonText"]),
    diffAdd: role("diffAdd", ["DiffAdd", "@diff.plus"]),
    diffDelete: role("diffDelete", ["DiffDelete", "@diff.minus"]),
    passed: role("passed", ["DiagnosticOk"]),
    failed: role("failed", ["DiagnosticError"]),
    warn: role("warn", ["DiagnosticWarn"]),
    info: role("info", ["DiagnosticInfo"]),
    button: role("button", ["PmenuSel"]),
    badge: role("badge", ["Pmenu"]),
    syntaxNumber: role("syntaxNumber", ["@number", "Number"]),
    syntaxString: role("syntaxString", ["@string", "String"]),
    syntaxOperator: role("syntaxOperator", ["@operator", "Operator"]),
    syntaxPunctuation: role("syntaxPunctuation", ["@punctuation.delimiter", "Delimiter"]),
    syntaxVariable: role("syntaxVariable", ["@variable", "Identifier"]),
    syntaxKeyword: role("syntaxKeyword", ["@keyword", "Keyword"]),
    syntaxConstant: role("syntaxConstant", ["@constant", "Constant"]),
    syntaxPreProc: role("syntaxPreProc", ["@keyword.directive", "PreProc"]),
    syntaxSpecialComment: role("syntaxSpecialComment", ["@comment.documentation", "SpecialComment"]),
    linkCursor: role("linkCursor", ["CursorLine", "Visual"]),
    floatBorder: role("floatBorder", ["FloatBorder"]),
    floatTitle: role("floatTitle", ["FloatTitle"]),
    folded: role("folded", ["Folded"]),
});

/** One host variable: the role that backs it and the attribute of the role group holding its colour. */
export interface HostVarEntry {
    role: HostRole;
    attr: ColorAttr;
}

/** Variable name (with `--`) → role. Variables absent here (fonts, sizes) are not colours and resolve to nothing. */
export type HostVarTable = Readonly<Record<string, HostVarEntry>>;

function v(r: HostRole, attr: ColorAttr): HostVarEntry {
    return { role: r, attr };
}

/** Every colour variable the host theme knows, plus those of ua.css (fonts/sizes omitted on purpose). */
export const defaultHostVars: HostVarTable = Object.freeze({
    // VS Code theme variables
    "--vscode-button-background": v("button", "bg"),
    "--vscode-button-foreground": v("button", "fg"),
    "--vscode-diffEditor-insertedLineBackground": v("diffAdd", "bg"),
    "--vscode-diffEditor-removedLineBackground": v("diffDelete", "bg"),
    "--vscode-editor-background": v("canvas", "bg"),
    "--vscode-editor-foreground": v("canvas", "fg"),
    "--vscode-editor-lineHighlightBorder": v("faintBorder", "fg"),
    "--vscode-gitDecoration-stageDeletedResourceForeground": v("syntaxString", "fg"),
    "--vscode-input-background": v("badge", "bg"),
    "--vscode-input-foreground": v("badge", "fg"),
    "--vscode-inputValidation-warningBorder": v("warn", "fg"),
    "--vscode-issues-open": v("muted", "fg"),
    "--vscode-sideBar-background": v("codeBlock", "bg"),
    "--vscode-symbolIcon-variableForeground": v("syntaxVariable", "fg"),
    "--vscode-tab-activeModifiedBorder": v("listMarker", "fg"),
    "--vscode-terminal-ansiBlue": v("syntaxKeyword", "fg"),
    "--vscode-terminal-ansiBrightRed": v("syntaxConstant", "fg"),
    "--vscode-terminal-ansiBrightWhite": v("syntaxSpecialComment", "fg"),
    "--vscode-terminal-ansiCyan": v("syntaxPreProc", "fg"),
    "--vscode-testing-iconFailed": v("failed", "fg"),
    "--vscode-testing-iconPassed": v("passed", "fg"),
    "--vscode-textBlockQuote-background": v("codeBlock", "bg"),
    "--vscode-textBlockQuote-border": v("quoteBar", "fg"),
    "--vscode-textLink-background": v("linkCursor", "bg"),
    "--vscode-textLink-foreground": v("linkUrl", "fg"),
    // ua.css: VS Code ids where VS Code has one
    "--vscode-textPreformat-foreground": v("inlineCode", "fg"),
    "--vscode-textPreformat-background": v("codeBlock", "bg"),
    "--vscode-textCodeBlock-background": v("codeBlock", "bg"),
    "--vscode-keybindingLabel-foreground": v("kbd", "fg"),
    "--vscode-keybindingLabel-background": v("badge", "bg"),
    "--vscode-editor-findMatchHighlightBackground": v("mark", "bg"),
    "--vscode-descriptionForeground": v("muted", "fg"),
    "--vscode-textSeparator-foreground": v("border", "fg"),
    "--vscode-debugTokenExpression-number": v("syntaxNumber", "fg"),
    "--vscode-debugTokenExpression-string": v("syntaxString", "fg"),
    "--vscode-symbolIcon-operatorForeground": v("syntaxOperator", "fg"),
    "--vscode-editorWarning-foreground": v("warn", "fg"),
    "--vscode-editorInfo-foreground": v("info", "fg"),
    "--vscode-badge-background": v("badge", "bg"),
    "--vscode-badge-foreground": v("badge", "fg"),
    "--vscode-keybindingLabel-border": v("border", "fg"),
    "--vscode-keybindingLabel-bottomBorder": v("border", "fg"),
    "--vscode-textLink-activeForeground": v("link", "fg"),
    "--vscode-editor-findMatchBackground": v("mark", "bg"),
    // ua.css: htmlview's own, for terminal adaptations VS Code has no colour id for
    "--htmlview-heading-1-foreground": v("heading1", "fg"),
    "--htmlview-heading-2-foreground": v("heading2", "fg"),
    "--htmlview-heading-3-foreground": v("heading3", "fg"),
    "--htmlview-heading-4-foreground": v("heading4", "fg"),
    "--htmlview-heading-5-foreground": v("heading5", "fg"),
    "--htmlview-heading-6-foreground": v("heading6", "fg"),
    "--htmlview-mark-foreground": v("mark", "fg"),
    "--htmlview-quote-foreground": v("quote", "fg"),
    "--htmlview-list-marker": v("listMarker", "fg"),
    "--htmlview-border": v("border", "fg"),
    "--htmlview-table-border": v("border", "fg"),
    "--htmlview-table-header-foreground": v("tableHeader", "fg"),
    "--htmlview-caption-foreground": v("tableHeader", "fg"),
    "--htmlview-link-url": v("linkUrl", "fg"),
    "--htmlview-syntax-punctuation": v("syntaxPunctuation", "fg"),
});
