/**
 * The default language table: common code-block language names and aliases (markdown fence / GitHub linguist
 * style) -> engine ids, and the lookup the highlighter uses. Pure data. Extended per render through
 * {@link buildLanguageTable}.
 *
 * hljs names are those registered in highlight.js (a test checks it); treesitter names are
 * `vim.treesitter.language` names (nvim-treesitter parser names), a missing parser is simply skipped at runtime.
 */
import type { LanguageEntry, LanguageOptions, LanguageTable } from "./index";

/** Builds an entry; an empty string means "that engine is not tried". */
function entry(treesitter: string, hljs: string): LanguageEntry {
    const result: LanguageEntry = {};
    if (treesitter !== "") {
        result.treesitter = treesitter;
    }
    if (hljs !== "") {
        result.hljs = hljs;
    }
    return result;
}

/** Follows alias chains at most this deep (cycles and dangling aliases end as "no language"). */
const MAX_ALIAS_DEPTH = 8;

/** The table data (see the module doc). Keys are lowercase language names. */
export const LANGUAGES: Readonly<LanguageTable> = Object.freeze({
    javascript: entry("javascript", "javascript"),
    js: entry("javascript", "javascript"),
    jsx: entry("javascript", "javascript"),
    mjs: entry("javascript", "javascript"),
    cjs: entry("javascript", "javascript"),
    typescript: entry("typescript", "typescript"),
    ts: entry("typescript", "typescript"),
    tsx: entry("tsx", "typescript"),
    python: entry("python", "python"),
    py: entry("python", "python"),
    java: entry("java", "java"),
    kotlin: entry("kotlin", "kotlin"),
    kt: entry("kotlin", "kotlin"),
    csharp: entry("c_sharp", "csharp"),
    cs: entry("c_sharp", "csharp"),
    "c#": entry("c_sharp", "csharp"),
    c: entry("c", "c"),
    cpp: entry("cpp", "cpp"),
    "c++": entry("cpp", "cpp"),
    cc: entry("cpp", "cpp"),
    h: entry("cpp", "cpp"),
    hpp: entry("cpp", "cpp"),
    objectivec: entry("objc", "objectivec"),
    objc: entry("objc", "objectivec"),
    go: entry("go", "go"),
    golang: entry("go", "go"),
    rust: entry("rust", "rust"),
    rs: entry("rust", "rust"),
    ruby: entry("ruby", "ruby"),
    rb: entry("ruby", "ruby"),
    php: entry("php", "php"),
    scala: entry("scala", "scala"),
    swift: entry("swift", "swift"),
    dart: entry("dart", "dart"),
    shell: entry("bash", "bash"),
    sh: entry("bash", "bash"),
    bash: entry("bash", "bash"),
    zsh: entry("bash", "bash"),
    powershell: entry("powershell", "powershell"),
    ps1: entry("powershell", "powershell"),
    sql: entry("sql", "sql"),
    html: entry("html", "xml"),
    htm: entry("html", "xml"),
    xml: entry("xml", "xml"),
    svg: entry("xml", "xml"),
    css: entry("css", "css"),
    scss: entry("scss", "scss"),
    less: entry("css", "less"),
    json: entry("json", "json"),
    jsonc: entry("json", "json"),
    yaml: entry("yaml", "yaml"),
    yml: entry("yaml", "yaml"),
    toml: entry("toml", "ini"),
    ini: entry("ini", "ini"),
    dockerfile: entry("dockerfile", "dockerfile"),
    docker: entry("dockerfile", "dockerfile"),
    hcl: entry("hcl", ""),
    terraform: entry("hcl", ""),
    tf: entry("hcl", ""),
    lua: entry("lua", "lua"),
    vim: entry("vim", "vim"),
    viml: entry("vim", "vim"),
    markdown: entry("markdown", "markdown"),
    md: entry("markdown", "markdown"),
    diff: entry("diff", "diff"),
    patch: entry("diff", "diff"),
    makefile: entry("make", "makefile"),
    make: entry("make", "makefile"),
    graphql: entry("graphql", "graphql"),
    proto: entry("proto", "protobuf"),
    protobuf: entry("proto", "protobuf"),
    r: entry("r", "r"),
    perl: entry("perl", "perl"),
    haskell: entry("haskell", "haskell"),
    hs: entry("haskell", "haskell"),
    elixir: entry("elixir", "elixir"),
    ex: entry("elixir", "elixir"),
    erlang: entry("erlang", "erlang"),
    clojure: entry("clojure", "clojure"),
    clj: entry("clojure", "clojure"),
    groovy: entry("groovy", "groovy"),
    gradle: entry("groovy", "groovy"),
    actionscript: entry("", "actionscript"),
    vb: entry("vb", "vbnet"),
    vbnet: entry("vb", "vbnet"),
    cobol: entry("cobol", ""),
    bicep: entry("bicep", ""),
});

/**
 * Merges user language options over a base table. A string value is an alias to another key (resolved in the merged
 * table; `""` means no language); an object gives engine ids directly. Keys are lowercased. Never mutates the base.
 */
export function buildLanguageTable(base: Readonly<LanguageTable>, extra?: LanguageOptions): LanguageTable {
    const table: LanguageTable = { ...base };
    const aliases: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(extra ?? {})) {
        const key: string = rawKey.toLowerCase();
        if (typeof value === "string") {
            aliases[key] = value.toLowerCase();
        } else {
            table[key] = entry(value.treesitter ?? "", value.hljs ?? "");
        }
    }
    for (const key of Object.keys(aliases)) {
        let target: string = aliases[key];
        let depth = 0;
        while (target !== "" && Object.prototype.hasOwnProperty.call(aliases, target) && depth < MAX_ALIAS_DEPTH) {
            target = aliases[target];
            depth += 1;
        }
        const known: boolean = Object.prototype.hasOwnProperty.call(table, target);
        if (target === "" || depth >= MAX_ALIAS_DEPTH) {
            table[key] = {};
        } else if (known) {
            table[key] = table[target];
        } else {
            table[key] = { treesitter: target, hljs: target };
        }
    }
    return table;
}

/**
 * Engine ids for a language name: lowercased, then the table entry, else the name itself for both engines (an
 * unknown name the engines happen to know still highlights). `""` (no language) gives an empty entry: nothing is
 * tried, no auto-detection.
 */
export function resolveLanguage(name: string, table: LanguageTable): LanguageEntry {
    const key: string = name.toLowerCase();
    let result: LanguageEntry = {};
    if (Object.prototype.hasOwnProperty.call(table, key)) {
        result = table[key];
    } else if (key !== "") {
        result = { treesitter: key, hljs: key };
    }
    return result;
}
