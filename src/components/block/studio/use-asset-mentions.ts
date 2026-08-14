import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionProps } from "@tiptap/suggestion";
import { useCallback, useEffect, useRef, useState } from "react";

import { ASSET_MENTION_NAME, AssetMention } from "#/components/block/studio/asset-mention";
import type { AssetKind } from "#/db/schema";
import { assetTitle } from "#/lib/asset-links";
import type { AssetSummary } from "#/lib/assets";

/**
 * The composer's editing core: a small ProseMirror document whose only unusual
 * content is the file mentions, plus the `@` list that inserts them.
 *
 * An editor rather than a textarea because a mention has to be one object. In a
 * textarea it could only ever be a run of characters standing in for an id, and
 * every edit inside those characters — a backspace, a paste over half of them —
 * silently desynchronised the label from what was actually going to be sent.
 * Here the node is atomic: backspace removes the whole file, and the id travels
 * with it.
 */

/** How many candidates the `@` list shows before asking for a narrower query. */
const MENTION_LIMIT = 6;

/**
 * What a file is called when it is named in a prompt.
 *
 * The same name the file carries everywhere else — its URL, its download —
 * because a chip reading `beach sunset` beside a link ending in a different
 * name would be two answers to one question. `assetTitle` already flattens and
 * bounds it, which is what a chip in running text needs.
 */
export function mentionLabel(asset: AssetSummary) {
  return assetTitle(asset);
}

export interface MentionDraft {
  /** The prompt as the model will read it, mentions rendered as `@label`. */
  text: string;
  /** The files behind those mentions, in the order they appear. */
  assetIds: string[];
}

/**
 * Which files the draft currently names.
 *
 * A `Set` and not an array, because every caller wants one of the two things a
 * Set is: "is this one already in" for the two places that refuse a duplicate,
 * and insertion order — which here is document order — for the one that has to
 * send the list. That second one is why this is not a `Set` built from a sorted
 * or hashed source: `read` spreads it straight into the wire format, and the
 * order files were named in is the order they are handed to the model.
 */
function mentionedIds(editor: Editor) {
  const ids = new Set<string>();

  editor.state.doc.descendants((node) => {
    if (node.type.name !== ASSET_MENTION_NAME) return;

    const id = node.attrs.id as string | null;

    if (id) ids.add(id);
  });

  return ids;
}

export interface UseAssetMentionsOptions {
  assets?: readonly AssetSummary[];
  /** Kinds the chosen model can be handed; anything else is not offered. */
  accepts: readonly AssetKind[];
  /** Enter, when the `@` list is not the one being driven. */
  onSubmit: () => void;
  /** Whether the composer is currently locked. */
  disabled: boolean;
}

export function useAssetMentions(options: UseAssetMentionsOptions) {
  /**
   * The editor is built once and never rebuilt, because rebuilding it would
   * throw away the draft. Everything it needs that *does* change — the file
   * list, the model's appetite, what Enter should do — is read through a ref at
   * the moment it is needed rather than captured when the extensions were
   * configured.
   */
  const latest = useRef(options);
  latest.current = options;

  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<readonly AssetSummary[]>([]);
  const [empty, setEmpty] = useState(true);

  /**
   * The highlighted row lives in a ref as well as in state: the arrow keys are
   * handled inside a ProseMirror plugin, whose handler was created before any
   * of this component's later renders and cannot see their state.
   */
  const highlightRef = useRef(0);
  const [highlight, setHighlightState] = useState(0);

  const setHighlight = useCallback((index: number) => {
    highlightRef.current = index;
    setHighlightState(index);
  }, []);

  /** Set by the suggestion plugin; inserts the node for the picked file. */
  const commandRef = useRef<((asset: AssetSummary) => void) | null>(null);
  const candidatesRef = useRef<readonly AssetSummary[]>([]);

  const openList = useCallback(
    (items: readonly AssetSummary[]) => {
      candidatesRef.current = items;
      setCandidates(items);
      setOpen(items.length > 0);
      setHighlight(0);
    },
    [setHighlight]
  );

  const closeList = useCallback(() => {
    candidatesRef.current = [];
    commandRef.current = null;
    setCandidates([]);
    setOpen(false);
    setHighlight(0);
  }, [setHighlight]);

  const editor = useEditor({
    // SSR would render the editor's DOM on the server and then hydrate it,
    // which ProseMirror has no use for — it owns that subtree outright.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        // A prompt is one run of prose. Everything structural is turned off
        // rather than left available through a keyboard shortcut nobody would
        // discover: a heading or a list inside the composer would be
        // flattened by `getText()` anyway.
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
        link: false,
        underline: false
      }),
      Placeholder.configure({ placeholder: "Ask anything, @ to attach a file" }),
      SubmitOnEnter.configure({ onSubmit: () => latest.current.onSubmit() }),
      AssetMention.configure({
        suggestion: {
          char: "@",
          // The node itself is the whole insertion, followed by a space so the
          // caret lands in the sentence rather than against the chip.
          command: ({ editor: instance, range, props }) => {
            instance
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: ASSET_MENTION_NAME, attrs: props },
                { type: "text", text: " " }
              ])
              .run();
          },
          items: ({ editor: instance, query }) => {
            const { assets, accepts } = latest.current;
            const term = query.toLowerCase();
            // Already in the draft is already answered: a second chip for one
            // file is a second way to say the same thing, and the id behind it
            // is dropped on the way out anyway (see `read`). Filtering before
            // the slice is what keeps the list full — the space an attached
            // file gives up goes to the next candidate rather than going blank.
            const attached = mentionedIds(instance);

            return (assets ?? [])
              .filter((asset) => accepts.includes(asset.kind))
              .filter((asset) => !attached.has(asset.id))
              .filter((asset) => mentionLabel(asset).toLowerCase().includes(term))
              .slice(0, MENTION_LIMIT);
          },
          render: () => ({
            onStart: (props: SuggestionProps<AssetSummary>) => {
              commandRef.current = (asset) =>
                props.command({ id: asset.id, label: mentionLabel(asset), kind: asset.kind });
              openList(props.items);
            },
            onUpdate: (props: SuggestionProps<AssetSummary>) => {
              commandRef.current = (asset) =>
                props.command({ id: asset.id, label: mentionLabel(asset), kind: asset.kind });
              openList(props.items);
            },
            // Returning true is what stops the key reaching the document, so
            // the arrows move through the list instead of the sentence.
            onKeyDown: ({ event }) => {
              const items = candidatesRef.current;

              if (items.length === 0) return false;

              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;

                setHighlight((highlightRef.current + step + items.length) % items.length);

                return true;
              }

              // Tab as well as Enter: the list is a completion, and completions
              // are what Tab does everywhere else.
              if (event.key === "Enter" || event.key === "Tab") {
                const asset = items[highlightRef.current];

                if (asset) commandRef.current?.(asset);

                return true;
              }

              if (event.key === "Escape") {
                closeList();

                return true;
              }

              return false;
            },
            onExit: closeList
          })
        }
      })
    ],
    editorProps: {
      attributes: {
        "aria-label": "Message",
        // `break-words` matters more than it looks: a pasted URL with no
        // spaces would otherwise widen the composer past the canvas.
        class: "min-h-8 w-full px-2 py-1.5 text-[13px] leading-5 break-words outline-none [&_p]:m-0"
      }
    },
    onUpdate: ({ editor: instance }) => setEmpty(isBlank(instance)),
    onCreate: ({ editor: instance }) => setEmpty(isBlank(instance))
  });

  // Kept in step rather than passed at construction: `useEditor` builds the
  // instance once, so a composer that becomes disabled mid-request has to be
  // told.
  if (editor && editor.isEditable === options.disabled) editor.setEditable(!options.disabled);

  /**
   * The draft is deduplicated at the two doors above, so this scan should never
   * have a duplicate to drop. It drops them anyway, because the set it spreads
   * is the last thing between a draft and the reference table's primary key,
   * and a draft can also be arrived at sideways — a paste, an undo that puts a
   * chip back beside the one that replaced it.
   */
  const read = useCallback((): MentionDraft => {
    if (!editor) return { text: "", assetIds: [] };

    return { text: editor.getText().trim(), assetIds: [...mentionedIds(editor)] };
  }, [editor]);

  /**
   * A file that leaves the board leaves the draft with it.
   *
   * `assets` here is what `@` can reach — the files whose nodes are on the
   * canvas — so a deletion removes the asset from this list whoever performed
   * it, the tab that pressed delete and every tab watching the node vanish
   * through the collab document alike. That makes this one rule cover every way
   * a file can go, rather than hanging off the delete handler and missing the
   * remote half.
   *
   * A chip left behind would not merely be stale: it would still carry the id
   * into `referenceAssetIds`, where the server checks every reference is a live
   * asset of this project and rejects the whole generation over it. So the
   * alternative to pruning is not an odd-looking draft, it is a prompt that
   * cannot be sent and does not say why.
   *
   * `undefined` means the list is not known yet rather than known to be empty —
   * without that distinction a hiccup in the assets query would read as "every
   * file is gone" and take the draft with it.
   */
  useEffect(() => {
    const live = options.assets;

    if (!editor || !live) return;

    const known = new Set(live.map((asset) => asset.id));
    const doc = editor.state.doc;
    const doomed: Array<{ from: number; to: number }> = [];

    doc.descendants((node, pos) => {
      if (node.type.name !== ASSET_MENTION_NAME) return;

      const id = node.attrs.id as string | null;

      if (!id || known.has(id)) return;

      // The space after the chip goes with it. Both doors that can insert one
      // write `[chip, " "]`, so taking that space back is the exact inverse of
      // the insertion rather than a guess at what the sentence wanted — and
      // without it a pruned draft is left with the double spaces of every file
      // that used to be there. A chip whose space the writer already deleted
      // has no space to find here, and one they typed a second space after
      // keeps the second.
      const end = pos + node.nodeSize;
      const next = doc.textBetween(end, Math.min(end + 1, doc.content.size));

      doomed.push({ from: pos, to: next === " " ? end + 1 : end });
    });

    if (doomed.length === 0) return;

    // Back to front: deleting a chip shifts everything after it, and the
    // positions were all measured against the document as it stands now.
    const tr = editor.state.tr;

    for (const { from, to } of doomed.reverse()) tr.delete(from, to);

    editor.view.dispatch(tr);
  }, [editor, options.assets]);

  const clear = useCallback(() => {
    editor?.commands.clearContent(true);
    setEmpty(true);
  }, [editor]);

  /**
   * Puts a file into the draft from outside the editor — what the canvas's own
   * "add to prompt" does. Appended at the end with a trailing space, because
   * there is no caret to speak of when the click came from a node.
   */
  const attach = useCallback(
    (asset: AssetSummary) => {
      if (!editor) return;

      // Clicking "add to prompt" on a file the draft already names is never
      // a request for a second copy of it — there is no sentence to place the
      // second chip in, the way there is when someone types `@` mid-thought.
      // Focused all the same: a click that visibly does nothing reads as
      // broken, and the caret lands on the draft that already has what was
      // asked for.
      if (mentionedIds(editor).has(asset.id)) {
        editor.commands.focus("end");

        return;
      }

      editor
        .chain()
        .focus("end")
        .insertContent([
          {
            type: ASSET_MENTION_NAME,
            attrs: { id: asset.id, label: mentionLabel(asset), kind: asset.kind }
          },
          { type: "text", text: " " }
        ])
        .run();
    },
    [editor]
  );

  return {
    editor,
    open,
    candidates,
    highlight,
    active: candidates[highlight],
    setHighlight,
    choose: (asset: AssetSummary) => commandRef.current?.(asset),
    empty,
    read,
    clear,
    attach
  };
}

/**
 * A draft of only whitespace is not one worth sending.
 *
 * `getText()` rather than `isEmpty`, because a draft holding nothing but a
 * file chip is not empty in any sense that matters — the mention renders as
 * `@label`, so it counts as something to send.
 */
function isBlank(editor: Editor) {
  return editor.getText().trim() === "";
}

interface SubmitOnEnterOptions {
  onSubmit: () => void;
}

/**
 * Enter sends; Shift+Enter breaks the line.
 *
 * Registered as an extension rather than a DOM listener so it sits in
 * ProseMirror's own keymap, *below* the suggestion plugin — which means the
 * `@` list gets first refusal on Enter and this only runs when no list is open.
 * It also inherits ProseMirror's composition handling, so an Enter that is
 * choosing a candidate in an IME never reaches here.
 */
const SubmitOnEnter = Extension.create<SubmitOnEnterOptions>({
  name: "submitOnEnter",

  addOptions() {
    return { onSubmit: () => {} };
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        this.options.onSubmit();

        return true;
      }
    };
  }
});
