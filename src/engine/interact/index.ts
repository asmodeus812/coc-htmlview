/**
 * Interactive state: radio/checkbox `:checked` (tabs and framework contexts are radio groups styled by
 * `:checked ~ …` rules), plus the link/anchor targets the view activates. State is an immutable value: the view
 * keeps it, calls {@link toggle} on a key, and re-runs the cascade (style.computeStyles) and layout with it.
 *
 * Keys: a control's key is its `id` attribute, else `name=value` (radio) / `name` (checkbox), else `#<dom id>`.
 * Radio groups are keyed by the `name` attribute (unnamed radios form a group of one, keyed by their control key).
 *
 * Mapping onto the unchanged Layout: a toggle target is emitted as `LinkTarget {kind: "context", contexts:
 * <radio group name | "checkbox">, key: <control key>}`, and the view's existing `selected` record
 * (`LayoutOptions.selected`: group → key) is exactly the radio half of {@link FormState} ({@link fromSelection}).
 *
 * Pure; no nvim.
 */
import type { DomDocument, DomElement } from "../dom";
import type { Link, LinkTarget } from "../../types";

export interface FormState {
    /** Radio group name → key of its checked control. A group absent here has no checked radio. */
    radios: ReadonlyMap<string, string>;
    /** Checkbox key → checked. */
    checkboxes: ReadonlyMap<string, boolean>;
}

/** A toggleable control found in the document. */
export interface Control {
    kind: "radio" | "checkbox";
    /** DOM id of the `<input>`. */
    element: number;
    key: string;
    /** Radio group name (radios only). */
    group?: string;
    /** DOM ids of the labels activating it (`label[for=id]` and enclosing labels). */
    labels: number[];
    /** From the `checked` attribute (the last checked radio of a group wins, as in a browser). */
    defaultChecked: boolean;
}

/** The control kind of an element, if it is a radio/checkbox `<input>`. */
function controlKind(el: DomElement): "radio" | "checkbox" | undefined {
    const type: string = (el.attrs.type ?? "").trim().toLowerCase();
    let kind: "radio" | "checkbox" | undefined;
    if (el.tag === "input" && (type === "radio" || type === "checkbox")) {
        kind = type;
    }
    return kind;
}

/** The key of a control (see the module doc). */
function keyOf(el: DomElement, kind: "radio" | "checkbox"): string {
    const id: string = el.attrs.id ?? "";
    const name: string = el.attrs.name ?? "";
    let key: string;
    if (id !== "") {
        key = id;
    } else if (name !== "") {
        key = kind === "radio" ? `${name}=${el.attrs.value ?? "on"}` : name;
    } else {
        key = `#${el.id}`;
    }
    return key;
}

/** Elements below `el` (preorder), `el` excluded. */
function descendants(el: DomElement, out: DomElement[]): DomElement[] {
    for (const child of el.children) {
        if (child.type === "element") {
            out.push(child);
            descendants(child, out);
        }
    }
    return out;
}

/** Controls per document: the DOM never changes after parsing, so one scan serves every restyle and toggle. */
const controlsByDoc: WeakMap<DomDocument, readonly Control[]> = new WeakMap<DomDocument, readonly Control[]>();

/** Every radio/checkbox of `doc` in document order, scanned once per document. */
export function findControls(doc: DomDocument): readonly Control[] {
    const controls: readonly Control[] = controlsByDoc.get(doc) ?? scanControls(doc);
    controlsByDoc.set(doc, controls);
    return controls;
}

function scanControls(doc: DomDocument): Control[] {
    const controls: Control[] = [];
    const byDomId: Map<number, Control> = new Map<number, Control>();
    const byAttrId: Map<string, Control> = new Map<string, Control>();
    for (const node of doc.nodes) {
        const kind = node.type === "element" ? controlKind(node) : undefined;
        if (node.type === "element" && kind !== undefined) {
            const key: string = keyOf(node, kind);
            const control: Control = {
                kind,
                element: node.id,
                key,
                labels: [],
                defaultChecked: node.attrs.checked !== undefined,
            };
            if (kind === "radio") {
                const name: string = node.attrs.name ?? "";
                control.group = name !== "" ? name : key;
            }
            controls.push(control);
            byDomId.set(node.id, control);
            if (node.attrs.id !== undefined && node.attrs.id !== "" && !byAttrId.has(node.attrs.id)) {
                byAttrId.set(node.attrs.id, control);
            }
        }
    }
    // A browser keeps only the last checked radio of a group.
    const lastChecked: Map<string, Control> = new Map<string, Control>();
    for (const c of controls) {
        if (c.kind === "radio" && c.defaultChecked && c.group !== undefined) {
            const prev: Control | undefined = lastChecked.get(c.group);
            if (prev !== undefined) {
                prev.defaultChecked = false;
            }
            lastChecked.set(c.group, c);
        }
    }
    for (const node of doc.nodes) {
        if (node.type === "element" && node.tag === "label") {
            const forId: string | undefined = node.attrs.for;
            let target: Control | undefined;
            if (forId !== undefined) {
                target = byAttrId.get(forId);
            } else {
                const first: DomElement | undefined = descendants(node, []).find((d: DomElement): boolean => controlKind(d) !== undefined);
                target = first !== undefined ? byDomId.get(first.id) : undefined;
            }
            if (target !== undefined) {
                target.labels.push(node.id);
            }
        }
    }
    return controls;
}

/** The state the markup starts in (`checked` attributes). */
export function initialFormState(doc: DomDocument): FormState {
    const radios: Map<string, string> = new Map<string, string>();
    const checkboxes: Map<string, boolean> = new Map<string, boolean>();
    for (const c of findControls(doc)) {
        if (c.kind === "radio" && c.group !== undefined) {
            if (c.defaultChecked) {
                radios.set(c.group, c.key);
            }
        } else {
            checkboxes.set(c.key, c.defaultChecked);
        }
    }
    return { radios, checkboxes };
}

/**
 * Activates the control `key` (or the control a label with that key's `for` points at): a radio becomes its
 * group's checked one; a checkbox flips. Unknown keys return `state` unchanged. Never mutates `state`.
 */
export function toggle(doc: DomDocument, state: FormState, key: string): FormState {
    const control: Control | undefined = findControls(doc).find((c: Control): boolean => c.key === key);
    let next: FormState = state;
    if (control !== undefined && control.kind === "radio" && control.group !== undefined) {
        const radios: Map<string, string> = new Map<string, string>(state.radios);
        radios.set(control.group, control.key);
        next = { radios, checkboxes: state.checkboxes };
    } else if (control !== undefined) {
        const checkboxes: Map<string, boolean> = new Map<string, boolean>(state.checkboxes);
        checkboxes.set(control.key, state.checkboxes.get(control.key) !== true);
        next = { radios: state.radios, checkboxes };
    }
    return next;
}

/** The `:checked` hook for css/ (`MatchContext.checked`): whether `el` is a checked radio/checkbox in `state`. */
export function isChecked(doc: DomDocument, state: FormState, el: DomElement): boolean {
    const kind = controlKind(el);
    let checked: boolean = false;
    if (kind === "radio") {
        const control: Control | undefined = findControls(doc).find((c: Control): boolean => c.element === el.id);
        checked = control !== undefined && control.group !== undefined && state.radios.get(control.group) === control.key;
    } else if (kind === "checkbox") {
        checked = state.checkboxes.get(keyOf(el, kind)) === true;
    }
    return checked;
}

/** The control an element activates (a label's control, or the control itself), if any. */
export function controlFor(doc: DomDocument, el: DomElement): Control | undefined {
    return findControls(doc).find((c: Control): boolean => c.element === el.id || c.labels.includes(el.id));
}

/** Converts the view's `selected` record (group → key) to a state: radios from it, the rest from the markup. */
export function fromSelection(doc: DomDocument, selected: Readonly<Record<string, string>>): FormState {
    const base: FormState = initialFormState(doc);
    const radios: Map<string, string> = new Map<string, string>(base.radios);
    const controls: readonly Control[] = findControls(doc);
    for (const group of Object.keys(selected)) {
        const key: string = selected[group];
        if (controls.some((c: Control): boolean => c.kind === "radio" && c.group === group && c.key === key)) {
            radios.set(group, key);
        }
    }
    return { radios, checkboxes: base.checkboxes };
}

/** What activating a link target asks the view to do. */
export type Activation =
    /** Re-run style + layout with this state (a toggle). */
    | { kind: "restyle"; state: FormState }
    /** Open this URL (`vim.ui.open` on Neovim, the system opener otherwise). */
    | { kind: "open"; href: string }
    /** Jump to the Anchor with this id. */
    | { kind: "jump"; id: string }
    /** Nothing to do (unknown control). */
    | { kind: "none" };

/**
 * The view's single entry point for `<CR>` / click on a Link: context targets toggle (→ restyle with
 * {@link toggle}), url targets open, anchor targets jump. Pure; the view performs the action.
 */
export function activate(doc: DomDocument, state: FormState, target: LinkTarget): Activation {
    let result: Activation;
    if (target.kind === "url") {
        result = { kind: "open", href: target.href };
    } else if (target.kind === "anchor") {
        result = { kind: "jump", id: target.id };
    } else if (findControls(doc).some((c: Control): boolean => c.key === target.key)) {
        result = { kind: "restyle", state: toggle(doc, state, target.key) };
    } else {
        result = { kind: "none" };
    }
    return result;
}

/** Converts a state back to the view's `selected` record (radios only). */
export function toSelection(state: FormState): Record<string, string> {
    const out: Record<string, string> = {};
    state.radios.forEach((key: string, group: string): void => {
        out[group] = key;
    });
    return out;
}

/** An empty state (no checked controls); `computeStyles` callers without a document state use it. */
export function emptyFormState(): FormState {
    return { radios: new Map<string, string>(), checkboxes: new Map<string, boolean>() };
}

/** Links of a Layout that toggle controls (context-kind targets), for the view's key handling. */
export function toggleLinks(links: readonly Link[]): Link[] {
    return links.filter((l: Link): boolean => l.target.kind === "context");
}
