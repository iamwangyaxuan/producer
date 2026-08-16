import { EditorContent } from "@tiptap/react";
import { useImperativeHandle, useState } from "react";
import type { Ref } from "react";
import { cn } from "tailwind-variants";

import { KIND_ICONS } from "#/components/block/studio/asset-mention";
import { mentionLabel, useAssetMentions } from "#/components/block/studio/use-asset-mentions";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Menu from "#/components/ui/menu";
import type { AssetKind } from "#/db/schema";
import type { AssetSummary } from "#/lib/assets";
import { MODELS, modelAccepts } from "#/lib/models";
import type { Modality, ModelOption } from "#/lib/models";
import { formatUsd } from "#/lib/money";
import { quoteGeneration } from "#/lib/pricing";

/**
 * Re-exported so the modules that already read these from the composer keep
 * working: the catalogue moved to `#/lib/models` because the server needs it
 * too, and that is not a reason to touch every import of `Modality`.
 */
export { modelAccepts, MODELS };
export type { Modality, ModelOption };

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
   * Where a finished prompt goes. Optional because the composer is complete
   * without it — it manages its own draft and clears on send.
   *
   * Returning `false` refuses the press and leaves the draft where it is, which
   * is what the canvas does when the organization's wallet cannot cover the
   * generation. Anything else (including nothing) accepts it and clears the
   * editor.
   */
  onSubmit?: (submission: ComposerSubmission) => boolean | void;
  /** Disables the composer and puts a spinner in the send button. */
  pending?: boolean;
  /**
   * What `@` can reach — the project's own files. Passed in rather than fetched
   * here because the canvas already holds this list for its own reasons, and
   * two copies of it would disagree the moment one of them refetched.
   */
  assets?: readonly AssetSummary[];
  /**
   * Whether model calls are billed at all — that is, whether this deployment
   * has an AI Gateway key.
   *
   * Passed in rather than derived, because it is a server fact and the price
   * shown here has to be the price the server will charge. It arrives on the
   * wallet query the canvas already loads to check the balance before it lets
   * a generation start. Defaults to false, so a caller that has not answered
   * yet quotes nothing rather than quoting a price that may not apply.
   */
  billingEnabled?: boolean;
  ref?: Ref<ComposerHandle>;
  className?: string;
}

/**
 * Fixed ids rather than generated ones: there is only ever one composer on the
 * canvas, and `aria-activedescendant` needs to name an element by id.
 */
const MENTION_LIST_ID = "composer-mentions";

const optionId = (assetId: string) => `composer-mention-${assetId}`;

export default function AIComposer({
  onSubmit,
  pending = false,
  assets,
  billingEnabled = false,
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

  // Priced from the controls alone. The prompt is deliberately left out even
  // though speech is billed by its length: the text lives in the editor and
  // reading it on every keystroke would re-render this whole component to
  // change one label. Speech is marked approximate instead — see below.
  const quote = quoteGeneration({ model: model.id, resolution, duration }, billingEnabled);
  const approximate = quote.unit === "1k_chars";

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

    const accepted = onSubmit?.({
      text: draft.text,
      modality,
      model: model.id,
      resolution,
      aspectRatio,
      duration,
      referenceAssetIds: draft.assetIds
    });

    // A refused press keeps the draft. The canvas turns one away when the
    // wallet cannot cover it, and clearing the editor anyway would take the
    // prompt as payment for the refusal — the one thing somebody in that
    // position still has, and the thing they will need again after topping up.
    if (accepted === false) return;

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

          {/*
           * What pressing the button will cost, next to the button.
           *
           * The wallet is spent per generation, so the price belongs where the
           * decision is made rather than on a billing page somebody would have
           * to go and look at first. It moves with the controls beside it — a
           * duration or a resolution changes it in place — which is also the
           * cheapest way to explain why 1080p costs what it does.
           *
           * Absent, not zero, when nothing is being charged: a model the
           * Gateway does not serve returns a stand-in file, and "¥0.00" next to
           * the send button would read as a claim about the price rather than
           * about the file.
           */}
          {quote.billable ? (
            <span
              className="shrink-0 text-[11px] leading-4 text-neutral-500 tabular-nums"
              title={
                approximate
                  ? "Charged per 1,000 characters of text, so the final amount depends on what you write."
                  : undefined
              }
            >
              {approximate ? "~" : ""}
              {formatUsd(quote.total)}
            </span>
          ) : null}

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
