import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionOptions } from "@tiptap/suggestion";

import Icon from "#/components/ui/icon";
import PreviewCard from "#/components/ui/preview-card";
import type { AssetKind } from "#/db/schema";
import { assetContentUrl } from "#/lib/asset-links";

/**
 * A file named inside a prompt.
 *
 * An atom node rather than styled text, which is the whole reason the composer
 * runs on an editor at all: a mention is one indivisible thing. Backspace
 * removes the file, not its last letter; the caret steps over it; and it cannot
 * be half-edited into a label that no longer names anything. What the draft
 * carries is the asset id, and the label is only what that id looks like.
 */

export const ASSET_MENTION_NAME = "assetMention";

export interface AssetMentionAttrs {
  id: string;
  label: string;
  kind: AssetKind;
}

/** The glyph for each kind, matching the composer's own modality strip. */
const KIND_ICONS: Record<AssetKind, string> = {
  image: "image",
  voice: "graphic_eq",
  music: "music_note",
  video: "movie"
};

export interface AssetMentionOptions {
  /** Wired up by the composer — see `useMentionSuggestion`. */
  suggestion: Omit<SuggestionOptions, "editor">;
}

export const AssetMention = Node.create<AssetMentionOptions>({
  name: ASSET_MENTION_NAME,
  group: "inline",
  inline: true,
  // Atomic and non-draggable: the editor treats it as a single character, and
  // dragging one out of a sentence is not a gesture this composer offers.
  atom: true,
  selectable: false,

  addOptions() {
    return { suggestion: { char: "@" } };
  },

  addAttributes() {
    return {
      id: { default: null },
      label: { default: "" },
      kind: { default: "image" satisfies AssetKind }
    };
  },

  parseHTML() {
    return [{ tag: `span[data-${ASSET_MENTION_NAME}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ [`data-${ASSET_MENTION_NAME}`]: "" }, HTMLAttributes)];
  },

  /**
   * What the node becomes in `editor.getText()`, and so what the model is
   * actually asked. The prompt reads as a sentence with a filename in it —
   * which is what the person typed, and what the reference ids alongside it
   * then point at.
   */
  renderText({ node }) {
    return `@${node.attrs.label}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionChip);
  },

  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })];
  }
});

/**
 * The chip, and the card that opens when the pointer rests on it.
 *
 * The preview needs nothing fetched: an asset's URL is a pure function of its
 * id, so the thumbnail is addressable from what the node already stores.
 */
function MentionChip({ node }: NodeViewProps) {
  const { id, label, kind } = node.attrs as AssetMentionAttrs;

  return (
    // Plain inline text, coloured. No chip, no background, no icon: a mention
    // is part of the sentence, and giving it a box made it sit apart from the
    // words around it — and made it fight the line's own metrics, which is
    // what had it riding above the text. Colour alone is enough to say "this
    // is a file", and it costs the line nothing.
    //
    // `as="span"` because this lives inside a paragraph; a div would break the
    // line the sentence is being written on.
    <NodeViewWrapper as="span">
      <PreviewCard.Root>
        <PreviewCard.Trigger
          render={
            // Not focusable and not a button: it sits in running text, and a
            // tab stop per attached file would make the draft tedious to
            // leave. Removing one is the editor's job — backspace.
            //
            // The one colour in a greyscale palette, so a mention is legible
            // as something other than prose without a second visual device.
            <span className="cursor-default text-[#8ab4f8]" />
          }
        >
          {/* The name alone — no `@`. That character is how a mention is
              *typed*, not what it is: once the colour says "this is a file",
              the marker is a leftover of the gesture that inserted it. It
              survives in `renderText`, which is what the model reads, where it
              still marks which words point at an attachment. */}
          {label}
        </PreviewCard.Trigger>

        <PreviewCard.Content>
          <AssetPreview id={id} label={label} kind={kind} />
        </PreviewCard.Content>
      </PreviewCard.Root>
    </NodeViewWrapper>
  );
}

/**
 * What the card shows: the file itself where that means anything, and its name
 * either way.
 *
 * Sound has no picture, so it gets the glyph its kind is labelled with rather
 * than an empty frame — and a video is shown as a still first frame rather than
 * a player, because this is a reminder of which file was attached, not
 * somewhere to watch it.
 */
function AssetPreview({ id, label, kind }: AssetMentionAttrs) {
  const src = assetContentUrl(id);
  const visual = kind === "image" || kind === "video";

  return (
    <div className="flex flex-col">
      <div className="flex aspect-video items-center justify-center bg-[rgba(218,220,224,0.06)]">
        {kind === "image" ? (
          <img src={src} alt={label} className="size-full object-contain" draggable={false} />
        ) : kind === "video" ? (
          // `preload="metadata"` is what makes a poster appear without
          // streaming the clip; muted so nothing can start making noise from a
          // hover.
          <video src={src} preload="metadata" muted className="size-full object-contain" />
        ) : (
          <Icon name={KIND_ICONS[kind]} className="text-3xl text-neutral-500" />
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <Icon name={KIND_ICONS[kind]} className="shrink-0 text-sm text-neutral-400" />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4">{label}</span>
        {visual ? null : <span className="text-[11px] text-neutral-500 capitalize">{kind}</span>}
      </div>
    </div>
  );
}
