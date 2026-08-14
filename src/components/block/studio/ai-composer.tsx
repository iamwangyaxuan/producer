import { EditorContent } from "@tiptap/react";
import { useImperativeHandle, useState } from "react";
import type { Ref } from "react";
import { cn } from "tailwind-variants";

import { mentionLabel, useAssetMentions } from "#/components/block/studio/use-asset-mentions";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Menu from "#/components/ui/menu";
import type { AssetKind } from "#/db/schema";
import type { AssetSummary } from "#/lib/assets";

export type Modality = "image" | "voice" | "music" | "video";

const MODALITIES = [
  { id: "image", label: "Image", icon: "image" },
  // Voice keeps the waveform and music takes the note: the two sit next to each
  // other and are the pair most worth telling apart at a glance.
  { id: "voice", label: "Voice", icon: "graphic_eq" },
  { id: "music", label: "Music", icon: "music_note" },
  { id: "video", label: "Video", icon: "movie" }
] as const satisfies readonly { id: Modality; label: string; icon: string }[];

/**
 * The selected segment has to win on fill *and* on text, because on this surface
 * neither carries the difference on its own: the strip sits over a near-black
 * canvas, where a film pale enough to read as "filled" is only a few points away
 * from one that reads as nothing at all, and where every segment is already
 * bright enough to look active.
 *
 * So the gap is widened from both ends — the fill is roughly twice what a
 * standalone `secondary` button gets, and the segments that are *not* selected
 * are dimmed a step below their resting colour. Neither half is dramatic on its
 * own; together they are what makes the choice legible at a glance.
 *
 * The inset hairline is the last of it. A single lit pixel along the top edge is
 * what makes the selected chip read as sitting on the strip rather than as a
 * patch of very slightly different black.
 */
const SEGMENT_SELECTED_CLASS = [
  "bg-[rgba(218,220,224,0.18)] text-foreground",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.09)]",
  "hover:bg-[rgba(218,220,224,0.22)]"
].join(" ");

/**
 * A step below `ghost`'s own resting colour. Hover is left alone: it already
 * lifts back to full white, which is what says the segment is still a choice
 * rather than something switched off.
 */
const SEGMENT_CLASS = "text-neutral-400";

export interface ModelOption {
  /** The exact string the provider's API takes. */
  id: string;
  name: string;
  /** Doubles as the menu's group heading, so models arrive sorted by who makes them. */
  provider: string;
  modality: Modality;
  /**
   * Size tiers, one vocabulary across every provider — `480p`/`720p`/`1080p`/`4k`
   * for video, `1K`/`2K`/`4K` for stills — with shape kept out of it and left to
   * `aspectRatios`.
   *
   * Two of these providers do not take a tier: Sora and GPT Image are given a
   * width×height pair instead. Composing one is the call site's job, and the
   * lists here are cut so that every tier×ratio the menus can produce is a pair
   * those APIs accept. Sora's own set is not a full product — it publishes
   * 1024×1792 and 1792×1024 alongside the 16:9 and 9:16 sizes — so that odd pair
   * is left out rather than modelled as a ratio that only exists at one tier.
   */
  resolutions?: readonly string[];
  /** Shape, independent of the tier above. */
  aspectRatios?: readonly string[];
  /** Seconds, video only. */
  durations?: readonly number[];
  /**
   * File kinds this model takes *as input*, when that differs from what its
   * output modality implies — see {@link DEFAULT_ACCEPTS} for the rule this
   * overrides.
   */
  accepts?: readonly AssetKind[];
}

/**
 * What a model will take as an attachment, inferred from what it produces.
 *
 * Coarser than the resolution and duration lists above, and deliberately so:
 * those are enumerated from each provider's documentation because sending a
 * value outside them fails the request, while this only decides whether the
 * composer *offers* a file. Image and video models are image-conditioned
 * across the board — editing a picture, or animating one — and the two sound
 * families are text-to-audio, which is why their default is nothing at all.
 *
 * A model that departs from its family says so with `accepts`, and anything
 * finer than this belongs in that field rather than here.
 */
const DEFAULT_ACCEPTS: Record<Modality, readonly AssetKind[]> = {
  image: ["image"],
  video: ["image"],
  voice: [],
  music: []
};

/** The file kinds this model can be handed, however that was decided. */
export function modelAccepts(model: ModelOption): readonly AssetKind[] {
  return model.accepts ?? DEFAULT_ACCEPTS[model.modality];
}

/**
 * Every entry here is a model with a public API whose size and length options
 * are enumerated in that provider's own documentation — the lists are what the
 * API accepts, not a plausible-looking guess, so a picked combination is one a
 * request can actually be built from.
 *
 * That bar is what decides who is in it. Several models that top the 2026
 * rankings are deliberately absent: Midjourney V8.1 and Suno v5 have no
 * self-serve public API to call, and for Seedance 2.0, Kling 3.0, Hailuo 3.0,
 * Runway Gen-4.5, Luma Ray3, FLUX.2, Ideogram 4 and Recraft V4.1 the resolution
 * and duration values published by resellers and roundups disagree with each
 * other. Adding one is a single entry once its own docs are read.
 *
 * First entry of each modality is that modality's default.
 */
export const MODELS: readonly ModelOption[] = [
  // Image — a size tier and a shape, no length.
  {
    id: "gpt-image-2",
    name: "GPT Image 2",
    provider: "OpenAI",
    modality: "image",
    // Takes a pixel pair, any width×height divisible by 16 between 1:3 and 3:1
    // and no larger than 3840×2160 — so the tiers below are the call site's to
    // compose, and every ratio here stays inside that envelope at 4K.
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"]
  },
  {
    id: "gemini-3-pro-image",
    name: "Nano Banana Pro",
    provider: "Google",
    modality: "image",
    // Gemini rejects a lowercase `k`, so the casing here is the wire value.
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Nano Banana 2",
    provider: "Google",
    modality: "image",
    // Also takes `512px`, the one value in either family that is neither a `p`
    // nor a `K` tier; left out rather than shown in a vocabulary of its own.
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
  },
  {
    id: "imagen-4.0-generate-001",
    name: "Imagen 4",
    provider: "Google",
    modality: "image",
    // Its published sizes run 1024² through 2816×1536 — two tiers, five shapes.
    resolutions: ["1K", "2K"],
    aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"]
  },
  {
    id: "grok-imagine-image-2.0",
    name: "Grok Imagine 2.0",
    provider: "xAI",
    modality: "image",
    // Grok already separates the two, which is the shape everything else here
    // is being brought into line with. It documents 14 ratios; these are the
    // ones that are not a niche social crop.
    resolutions: ["1K", "2K"],
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2"]
  },
  {
    // ⚠ The one id here not taken from its provider's own docs: BytePlus renders
    // its documentation client-side, so the model list could not be read, and
    // ByteDance's real endpoint ids carry a release-date suffix
    // (`doubao-seedream-4-0-250828`). Confirm against ModelArk before this is
    // put in a request — the option lists below are corroborated, the id is not.
    id: "doubao-seedream-5-0-pro",
    name: "Seedream 5.0 Pro",
    provider: "ByteDance",
    modality: "image",
    // Two tiers and eight shapes, agreed on by two independent API hosts.
    resolutions: ["1K", "2K"],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"]
  },

  // Voice — speech and TTS only, now that the two music generators have a
  // heading of their own. Neither resolution nor duration applies, so a picked
  // voice model leaves the composer with just the model menu.
  // The one voice model here that is not text-to-speech: it is a speech-to-
  // speech conversation model, so it takes audio in as well as out.
  {
    id: "gpt-realtime-2.1",
    name: "GPT Realtime 2.1",
    provider: "OpenAI",
    modality: "voice",
    accepts: ["voice"]
  },
  { id: "gpt-4o-mini-tts", name: "GPT-4o mini TTS", provider: "OpenAI", modality: "voice" },
  {
    id: "gemini-3.1-flash-tts-preview",
    name: "Gemini 3.1 Flash TTS",
    provider: "Google",
    modality: "voice"
  },
  { id: "eleven_v3", name: "Eleven v3", provider: "ElevenLabs", modality: "voice" },
  { id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", provider: "ElevenLabs", modality: "voice" },
  { id: "grok-voice-think-fast-2.0", name: "Grok Voice 2.0", provider: "xAI", modality: "voice" },

  // Music — the two that were sitting under voice while it was still called
  // audio, plus Lyria's clip model from the same published list Pro came from.
  //
  // No duration, even though a track has one: ElevenLabs takes a length in
  // milliseconds and Lyria's own bounds are not in the model list, so there is
  // no enumerated set to put in a menu. It arrives when those are read, the same
  // rule the rest of this catalogue is held to.
  { id: "lyria-3-pro-preview", name: "Lyria 3 Pro", provider: "Google", modality: "music" },
  { id: "lyria-3-clip-preview", name: "Lyria 3 Clip", provider: "Google", modality: "music" },
  { id: "music_v2", name: "ElevenLabs Music v2", provider: "ElevenLabs", modality: "music" },

  // Video — all three, and the lists differ per model rather than per provider:
  // Veo Lite drops 4k, and only Sora Pro reaches 1080p.
  {
    id: "veo-3.1-generate-preview",
    name: "Veo 3.1",
    provider: "Google",
    modality: "video",
    resolutions: ["720p", "1080p", "4k"],
    // Veo's own lowercase `4k` next to an uppercase `1K` elsewhere is not a
    // typo: each is the string that provider's API accepts.
    aspectRatios: ["16:9", "9:16"],
    durations: [4, 6, 8]
  },
  {
    id: "veo-3.1-lite-generate-preview",
    name: "Veo 3.1 Lite",
    provider: "Google",
    modality: "video",
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    durations: [4, 6, 8]
  },
  {
    id: "sora-2",
    name: "Sora 2",
    provider: "OpenAI",
    modality: "video",
    // 1280×720 and 720×1280. The 1024×1792 pair it also takes is left out — see
    // the note on `resolutions` above.
    resolutions: ["720p"],
    aspectRatios: ["16:9", "9:16"],
    durations: [4, 8, 12, 16, 20]
  },
  {
    id: "sora-2-pro",
    name: "Sora 2 Pro",
    provider: "OpenAI",
    modality: "video",
    // Pro is the only one of the two that reaches 1920×1080 / 1080×1920.
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    durations: [4, 8, 12, 16, 20]
  },
  {
    id: "grok-imagine-video-1.5",
    name: "Grok Imagine Video 1.5",
    provider: "xAI",
    modality: "video",
    resolutions: ["480p", "720p"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    // Grok takes any whole number of seconds from 1 to 15 and defaults to 6.
    // These are presets across that range, not the API's own list.
    durations: [4, 6, 8, 12, 15]
  },
  {
    // Same id caveat as Seedream above.
    id: "doubao-seedance-2-0",
    name: "Seedance 2.0",
    provider: "ByteDance",
    modality: "video",
    // Two API hosts publish this model's inputs and agree on the six ratios and
    // on 480p/720p; one of them additionally lists 1080p. Kept to what both say,
    // because the cost of offering a tier the endpoint rejects is a failed
    // request and the cost of omitting one is a menu row.
    resolutions: ["480p", "720p"],
    // Reordered from the published list so 16:9 leads: the first entry is what
    // the composer defaults to, and 21:9 is a deliberate choice rather than
    // something to hand someone who never opened the menu.
    aspectRatios: ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"],
    // 4 to 15 seconds, any whole number — presets across the range, as with Grok.
    durations: [4, 6, 8, 10, 12, 15]
  }
];

/**
 * Every named ratio Material Symbols actually draws — the full set, taken from
 * the font's own codepoints list rather than from memory, which is how `21:9`
 * and `2:3` were found to have glyphs after first being sent to the fallback.
 *
 * It stops there. The font has no `crop_4_3`, `crop_3_4`, `crop_4_5`, `crop_2_1`
 * or `crop_1_2`, so those five cannot be told apart by a crop glyph and take the
 * frame for their orientation instead: `4:3` and `2:1` share the landscape one,
 * `3:4`, `4:5` and `1:2` the portrait one. A ratio there is named on the chip
 * beside its icon, so the two that look alike still read apart.
 */
const RATIO_ICONS: Record<string, string> = {
  "1:1": "crop_square",
  "2:3": "crop_2_3",
  "3:2": "crop_3_2",
  "5:4": "crop_5_4",
  "7:5": "crop_7_5",
  "9:16": "crop_9_16",
  "16:9": "crop_16_9",
  "21:9": "crop_21_9"
};

export function aspectRatioIcon(ratio: string) {
  const exact = RATIO_ICONS[ratio];

  if (exact) return exact;

  const [width, height] = ratio.split(":").map(Number);

  if (!width || !height) return "crop";

  return width >= height ? "crop_landscape" : "crop_portrait";
}

function modelsFor(modality: Modality) {
  return MODELS.filter((model) => model.modality === modality);
}

/**
 * Groups in first-seen order rather than alphabetically, so the catalogue above
 * decides what the menu leads with and the order does not shuffle when a model
 * is added.
 */
function groupByProvider(models: readonly ModelOption[]) {
  const groups: { label: string; options: { value: string; title: string }[] }[] = [];

  for (const model of models) {
    const group = groups.find((entry) => entry.label === model.provider);
    const option = { value: model.id, title: model.name };

    if (group) group.options.push(option);
    else groups.push({ label: model.provider, options: [option] });
  }

  return groups;
}

export interface ComposerSubmission {
  text: string;
  modality: Modality;
  model: string;
  /** A size tier, not a pixel pair — see `ModelOption.resolutions`. */
  resolution?: string;
  aspectRatio?: string;
  /** Seconds; video models only. */
  duration?: number;
  /** Files named with `@`, in the order they were attached. */
  referenceAssetIds?: string[];
}

/**
 * What the canvas can ask of the composer.
 *
 * Imperative because the two questions come from a right-click on a node, which
 * is nowhere near this component and wants an answer once, at the moment the
 * menu opens — not a subscription to the model selection.
 */
export interface ComposerHandle {
  /** Whether the chosen model would take this kind of file as an input. */
  accepts: (kind: AssetKind) => boolean;
  /** Puts a file into the draft, as if it had been typed with `@`. */
  attach: (asset: AssetSummary) => void;
}

export interface AIComposerProps {
  /**
   * Optional because the composer is complete without it: it manages its own
   * draft and clears on send. There is no chat table, no server function and no
   * provider credentials wired up behind this yet, so today nothing passes a
   * handler — this is the seam that gets filled when a prompt has somewhere to go.
   */
  onSubmit?: (submission: ComposerSubmission) => void;
  /** Disables the composer and puts a spinner in the send button. */
  pending?: boolean;
  /**
   * What `@` can reach — the project's own files. Passed in rather than fetched
   * here because the canvas already holds this list for its own reasons, and
   * two copies of it would disagree the moment one of them refetched.
   */
  assets?: readonly AssetSummary[];
  ref?: Ref<ComposerHandle>;
  className?: string;
}

/**
 * Fixed ids rather than generated ones: there is only ever one composer on the
 * canvas, and `aria-activedescendant` needs to name an element by id.
 */
const MENTION_LIST_ID = "composer-mentions";

const optionId = (assetId: string) => `composer-mention-${assetId}`;

/** The glyph that says what a candidate is, borrowed from the modality strip. */
const KIND_ICONS: Record<AssetSummary["kind"], string> = {
  image: "image",
  voice: "graphic_eq",
  music: "music_note",
  video: "movie"
};

export default function AIComposer({
  onSubmit,
  pending = false,
  assets,
  ref,
  className
}: AIComposerProps) {
  const [modality, setModality] = useState<Modality>("image");

  /**
   * Keyed by modality and by model rather than held as loose values, so the
   * composer cannot reach a state its own controls disagree with: a resolution
   * belongs to the model it was picked under, and switching away and back finds
   * it again instead of silently resetting. Falling back to the first option
   * also means there is nothing to reconcile when a model's list changes.
   */
  const [modelByModality, setModelByModality] = useState<Partial<Record<Modality, string>>>({});
  const [resolutionByModel, setResolutionByModel] = useState<Record<string, string>>({});
  const [aspectByModel, setAspectByModel] = useState<Record<string, string>>({});
  const [durationByModel, setDurationByModel] = useState<Record<string, number>>({});

  const models = modelsFor(modality);
  const model = models.find((entry) => entry.id === modelByModality[modality]) ?? models[0];

  const resolution = model.resolutions
    ? (resolutionByModel[model.id] ?? model.resolutions[0])
    : undefined;
  const aspectRatio = model.aspectRatios
    ? (aspectByModel[model.id] ?? model.aspectRatios[0])
    : undefined;
  const duration = model.durations ? (durationByModel[model.id] ?? model.durations[0]) : undefined;

  const mentions = useAssetMentions({
    assets,
    accepts: modelAccepts(model),
    disabled: pending,
    onSubmit: () => submit()
  });

  useImperativeHandle(
    ref,
    () => ({
      accepts: (kind) => modelAccepts(model).includes(kind),
      attach: mentions.attach
    }),
    [model, mentions.attach]
  );

  function submit() {
    if (mentions.empty || pending) return;

    const draft = mentions.read();

    if (draft.text === "") return;

    onSubmit?.({
      text: draft.text,
      modality,
      model: model.id,
      resolution,
      aspectRatio,
      duration,
      referenceAssetIds: draft.assetIds
    });

    mentions.clear();
  }

  return (
    <div className={cn("relative flex flex-col items-start gap-2", className)}>
      {/* Toggle buttons rather than a radiogroup: a radiogroup owes the reader
          arrow-key navigation and a roving tabindex, and for three always-visible
          options `aria-pressed` says the same thing while leaving each segment
          reachable by Tab. */}
      <div
        role="group"
        aria-label="Output type"
        className={cn(
          "inline-flex items-center gap-0.5 rounded-xl border p-1",
          "border-[rgba(218,220,224,0.1)] bg-background/80 backdrop-blur-xl"
        )}
      >
        {MODALITIES.map((entry) => {
          const active = entry.id === modality;

          return (
            <Button
              key={entry.id}
              size="sm"
              // Both states start from `ghost` and are told apart below, rather
              // than by swapping to `secondary`: the difference between the two
              // has to be built deliberately, and picking it up from a variant
              // meant for standalone buttons is what made it too faint to read.
              variant="ghost"
              aria-pressed={active}
              disabled={pending}
              onClick={() => setModality(entry.id)}
              className={active ? SEGMENT_SELECTED_CLASS : SEGMENT_CLASS}
            >
              <Icon name={entry.icon} className="text-sm" />
              {entry.label}
            </Button>
          );
        })}
      </div>

      {/* Positioned against the whole composer rather than laid out inside it.
          As a sibling in the column the list took real height, shoving the
          modality strip and everything above it upward on every `@`; anchored
          to the input box alone it covered that strip instead. Hung off the
          outer container it clears both — the composer does not move, and none
          of it is hidden.

          Above rather than at the caret: the composer is pinned to the bottom
          of the viewport, so there is only one direction a list can open in,
          and a full-width list is easier to hit than one floating
          mid-sentence. */}
      {mentions.open ? (
        <div
          id={MENTION_LIST_ID}
          role="listbox"
          aria-label="Files"
          className={cn(
            "absolute bottom-full left-0 z-10 mb-2 flex w-full flex-col gap-0.5 rounded-2xl border p-1",
            "border-[rgba(218,220,224,0.1)] bg-background/95 backdrop-blur-xl",
            "shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
          )}
        >
          {mentions.candidates.map((asset, index) => {
            const selected = index === mentions.highlight;

            return (
              // Not a button, and not focusable: the editor keeps focus the
              // whole time so typing never stops. `mousedown` rather than
              // `click`, because losing focus would otherwise close the list
              // and take the row out from under the press.
              <div
                key={asset.id}
                id={optionId(asset.id)}
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => {
                  event.preventDefault();
                  mentions.choose(asset);
                }}
                onMouseEnter={() => mentions.setHighlight(index)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-[13px]",
                  selected ? "bg-[rgba(218,220,224,0.12)] text-foreground" : "text-neutral-400"
                )}
              >
                <Icon name={KIND_ICONS[asset.kind]} className="shrink-0 text-sm" />
                <span className="min-w-0 flex-1 truncate">{mentionLabel(asset)}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div
        className={cn(
          "flex w-full flex-col gap-1 rounded-2xl border p-2",
          // Translucent black rather than the usual light film: this sits over
          // the canvas rather than over the page, and the dot grid reading
          // through the text is what the blur and darker fill are here to stop.
          "border-[rgba(218,220,224,0.1)] bg-background/80 backdrop-blur-xl"
        )}
      >
        {/* `nowheel` keeps a scroll inside a long draft from reaching the canvas
            — without it, scrolling the text zooms the whole graph instead. The
            editor grows with its content on its own, so the mirror element a
            textarea needed for that is gone with it. */}
        <div className="nowheel max-h-40 overflow-y-auto">
          <EditorContent
            editor={mentions.editor}
            role="combobox"
            aria-expanded={mentions.open}
            aria-controls={MENTION_LIST_ID}
            aria-activedescendant={
              mentions.open && mentions.active ? optionId(mentions.active.id) : undefined
            }
            aria-autocomplete="list"
          />
        </div>

        <div className="flex items-end gap-2">
          {/* Separate menus rather than one with submenus, and each is here only
              while the chosen model has something for it to set: voice models
              have no size or length, so those two chips are absent rather than
              present and empty. */}
          <div className="flex flex-1 flex-wrap items-center gap-1">
            <ControlMenu
              label="Model"
              value={model.id}
              onChange={(next) =>
                setModelByModality((current) => ({ ...current, [modality]: next }))
              }
              disabled={pending}
              groups={groupByProvider(models)}
            />

            {model.resolutions && resolution ? (
              <ControlMenu
                label="Resolution"
                icon="hd"
                value={resolution}
                onChange={(next) =>
                  setResolutionByModel((current) => ({ ...current, [model.id]: next }))
                }
                disabled={pending}
                options={model.resolutions.map((entry) => ({ value: entry, title: entry }))}
              />
            ) : null}

            {model.aspectRatios && aspectRatio ? (
              <ControlMenu
                label="Aspect ratio"
                value={aspectRatio}
                onChange={(next) =>
                  setAspectByModel((current) => ({ ...current, [model.id]: next }))
                }
                disabled={pending}
                // Every row carries its own frame and the trigger borrows the
                // selected one, so the chip shows the shape rather than naming it.
                options={model.aspectRatios.map((entry) => ({
                  value: entry,
                  title: entry,
                  icon: aspectRatioIcon(entry)
                }))}
              />
            ) : null}

            {model.durations && duration ? (
              <ControlMenu
                label="Duration"
                icon="timer"
                value={String(duration)}
                onChange={(next) =>
                  setDurationByModel((current) => ({ ...current, [model.id]: Number(next) }))
                }
                disabled={pending}
                options={model.durations.map((entry) => ({
                  value: String(entry),
                  title: `${entry}s`
                }))}
              />
            ) : null}
          </div>

          <Button
            icon
            shape="circle"
            className="shrink-0"
            aria-label="Send"
            disabled={mentions.empty}
            pending={pending}
            onClick={submit}
          >
            <Icon name="arrow_upward" className="text-base" />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ControlOption {
  value: string;
  title: string;
  /** Shown on the row, and on the trigger when this is the selected one. */
  icon?: string;
}

interface ControlGroup {
  label: string;
  options: readonly ControlOption[];
}

interface ControlMenuProps {
  /** Names the control for screen readers; the trigger itself only shows a value. */
  label: string;
  icon?: string;
  value: string;
  /** Flat list, for menus short enough that headings would only add noise. */
  options?: readonly ControlOption[];
  /** Headed sections, for the model menu — the heading is the provider. */
  groups?: readonly ControlGroup[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * One chip for every menu in the row, so a control added later cannot drift out
 * of step with the others on size, spacing, or how it opens.
 */
function ControlMenu({
  label,
  icon,
  value,
  options,
  groups,
  onChange,
  disabled
}: ControlMenuProps) {
  const flat = groups ? groups.flatMap((group) => group.options) : (options ?? []);
  const selected = flat.find((option) => option.value === value) ?? flat[0];
  // The selected row's own icon wins, so a control whose options each look
  // different says which one is active without repeating it in words.
  const triggerIcon = selected?.icon ?? icon;

  /** Shared by both branches below so a grouped menu and a flat one draw a row the same way. */
  function renderOption(option: ControlOption) {
    return (
      <Menu.RadioItem key={option.value} value={option.value}>
        {option.icon ? <Icon name={option.icon} className="text-sm" /> : null}
        {option.title}
      </Menu.RadioItem>
    );
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        render={<Button variant="ghost" size="sm" disabled={disabled} />}
      >
        {triggerIcon ? <Icon name={triggerIcon} className="text-sm" /> : null}
        {selected?.title}
        <Icon name="expand_more" className="text-sm" />
      </Menu.Trigger>
      {/* Opens upward: the composer is already at the bottom of the viewport, so
          a menu dropped below it would have nowhere to go. */}
      <Menu.Content positioner={{ side: "top", align: "start", sideOffset: 8 }}>
        {/* The radio group wraps the sections rather than sitting inside each of
            them: one selection spans the whole menu, and a group per section
            would let two providers each hold a checked row. */}
        <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as string)}>
          {groups
            ? groups.map((group) => (
                <Menu.Group key={group.label}>
                  <Menu.GroupLabel>{group.label}</Menu.GroupLabel>
                  {group.options.map(renderOption)}
                </Menu.Group>
              ))
            : (options ?? []).map(renderOption)}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}
