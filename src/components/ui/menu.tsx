import { Menu as BaseMenu } from "@base-ui/react/menu";

import Icon from "#/components/ui/icon";

/**
 * Base UI takes either a class string or a function of the part's state, and
 * both forms have to survive being merged with the presets below.
 */
type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

/**
 * The caller's classes come last so they win a specificity tie. There is no
 * class-merging pass here, so a caller overriding a preset utility is still
 * subject to the order Tailwind emits the two rules in.
 */
function mergeClassName<State>(preset: string, className: ClassName<State>): ClassName<State> {
  if (typeof className !== "function") return [preset, className].filter(Boolean).join(" ");

  return (state) => [preset, className(state)].filter(Boolean).join(" ");
}

/** Positions the popup and nothing else — every visual belongs to the popup itself. */
const POSITIONER_CLASS = "z-50 outline-hidden";

const POPUP_CLASS = [
  // The panel: 18px corners, 8px of padding, and a near-black that lets a
  // little of the page through.
  "rounded-[18px] bg-[rgba(22,23,24,0.9)] p-2 text-foreground",
  // No border — the shadow carries the edge on its own.
  "shadow-[0_16px_40px_rgba(0,0,0,0.45)] outline-hidden",
  // `--available-height` is set on the positioner and inherits down, so a menu
  // taller than the space below its trigger scrolls instead of overflowing it.
  "max-h-[var(--available-height)] overflow-y-auto overscroll-contain",
  // Grows from wherever the positioner anchored it.
  "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 ease-out",
  "data-starting-style:scale-95 data-starting-style:opacity-0",
  "data-ending-style:scale-95 data-ending-style:opacity-0",
  // Base UI asks for an instant close after a click or a dismiss; animating it
  // would leave the popup on screen after the action has already run.
  "data-instant:transition-none"
].join(" ");

/**
 * One row: 11px text, 8px of padding, 12px corners.
 *
 * The hover colour hangs off `data-highlighted` rather than `hover:` because
 * Base UI highlights on pointer move *and* on keyboard navigation — keying off
 * the attribute is what makes arrowing through the menu look like hovering it.
 */
const ITEM_CLASS = [
  "flex cursor-default items-center gap-2 rounded-[12px] p-2 text-[11px] leading-4 select-none",
  "outline-hidden transition-[background-color,backdrop-filter] duration-100",
  "data-highlighted:bg-[rgba(218,220,224,0.05)]",
  // Pressed: the panel behind the row blurs slightly. `backdrop-filter` rather
  // than `filter`, which would take the row's own label with it.
  "active:backdrop-blur-[1.5px]",
  "data-disabled:pointer-events-none data-disabled:text-neutral-500"
].join(" ");

/** Keeps the row lit while its submenu is open, on top of the shared item styles. */
const SUBMENU_TRIGGER_CLASS = "data-popup-open:bg-[rgba(218,220,224,0.05)]";

/**
 * Kept mounted and merely hidden when unchecked, so ticking an item doesn't
 * shift its label sideways.
 */
const INDICATOR_CLASS =
  "flex size-3.5 shrink-0 items-center justify-center data-unchecked:invisible";

export interface MenuContentProps extends BaseMenu.Popup.Props {
  /** A parent element for the portal; defaults to `<body>`. */
  container?: BaseMenu.Portal.Props["container"];
  /** Keeps the popup in the DOM while the menu is closed. */
  keepMounted?: boolean;
  /**
   * Everything positioning-related, forwarded to `Menu.Positioner`: `side`,
   * `align`, `sideOffset`, `collisionPadding`, and so on. A submenu usually
   * wants `{ side: "inline-end", sideOffset: 4 }`.
   */
  positioner?: BaseMenu.Positioner.Props;
}

/**
 * The portal, the positioner and the popup in one part, since a menu never
 * needs one without the others. `className` styles the popup — the visible
 * panel — and positioning goes through {@link MenuContentProps.positioner}.
 */
export function MenuContent({
  container,
  keepMounted,
  positioner,
  className,
  ...props
}: MenuContentProps) {
  return (
    <BaseMenu.Portal container={container} keepMounted={keepMounted}>
      <BaseMenu.Positioner
        sideOffset={8}
        align="start"
        {...positioner}
        className={mergeClassName(POSITIONER_CLASS, positioner?.className)}
      >
        <BaseMenu.Popup {...props} className={mergeClassName(POPUP_CLASS, className)} />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

/** An action. Closes the menu when clicked, unless `closeOnClick={false}`. */
export function MenuItem({ className, ...props }: BaseMenu.Item.Props) {
  return <BaseMenu.Item {...props} className={mergeClassName(ITEM_CLASS, className)} />;
}

/**
 * An item that navigates. Renders an `<a>`, so it keeps middle-click and
 * "open in new tab"; pass `render` to hand it a router link instead.
 */
export function MenuLinkItem({ className, ...props }: BaseMenu.LinkItem.Props) {
  return <BaseMenu.LinkItem {...props} className={mergeClassName(ITEM_CLASS, className)} />;
}

/** An item that toggles a setting. Stays open on click, like a native menu. */
export function MenuCheckboxItem({ className, children, ...props }: BaseMenu.CheckboxItem.Props) {
  return (
    <BaseMenu.CheckboxItem {...props} className={mergeClassName(ITEM_CLASS, className)}>
      <BaseMenu.CheckboxItemIndicator keepMounted className={INDICATOR_CLASS}>
        <Icon name="check" className="text-sm" />
      </BaseMenu.CheckboxItemIndicator>
      {children}
    </BaseMenu.CheckboxItem>
  );
}

/** One choice inside a `Menu.RadioGroup`. */
export function MenuRadioItem({ className, children, ...props }: BaseMenu.RadioItem.Props) {
  return (
    <BaseMenu.RadioItem {...props} className={mergeClassName(ITEM_CLASS, className)}>
      <BaseMenu.RadioItemIndicator keepMounted className={INDICATOR_CLASS}>
        <span className="size-1.5 rounded-full bg-current" />
      </BaseMenu.RadioItemIndicator>
      {children}
    </BaseMenu.RadioItem>
  );
}

/**
 * An item that opens a submenu. The caret is part of the row rather than
 * something each caller passes, because it is what marks the row as a submenu.
 */
export function MenuSubmenuTrigger({
  className,
  children,
  ...props
}: BaseMenu.SubmenuTrigger.Props) {
  return (
    <BaseMenu.SubmenuTrigger
      {...props}
      className={mergeClassName(`${ITEM_CLASS} ${SUBMENU_TRIGGER_CLASS}`, className)}
    >
      {children}
      <Icon name="chevron_right" className="ml-auto text-sm text-neutral-400" />
    </BaseMenu.SubmenuTrigger>
  );
}

/** Names a `Menu.Group`; announced with the group rather than focusable itself. */
export function MenuGroupLabel({ className, ...props }: BaseMenu.GroupLabel.Props) {
  return (
    <BaseMenu.GroupLabel
      {...props}
      className={mergeClassName(
        "px-2 py-1.5 text-[11px] leading-4 font-medium text-neutral-400",
        className
      )}
    />
  );
}

/** A hairline between groups of items. */
export function MenuSeparator({ className, ...props }: BaseMenu.Separator.Props) {
  return (
    <BaseMenu.Separator
      {...props}
      className={mergeClassName("my-1.5 h-px bg-[rgba(218,220,224,0.1)]", className)}
    />
  );
}

/**
 * The menu, preset to this app's shape. Parts that carry no styling of their
 * own — the root, the trigger, groups — are Base UI's, re-exported here so a
 * whole menu can be assembled from a single import:
 *
 * ```tsx
 * <Menu.Root>
 *   <Menu.Trigger>…</Menu.Trigger>
 *   <Menu.Content>
 *     <Menu.Item onClick={rename}>Rename</Menu.Item>
 *     <Menu.Separator />
 *     <Menu.Item onClick={remove}>Delete</Menu.Item>
 *   </Menu.Content>
 * </Menu.Root>
 * ```
 */
const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Backdrop: BaseMenu.Backdrop,
  Content: MenuContent,
  Item: MenuItem,
  LinkItem: MenuLinkItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: BaseMenu.RadioGroup,
  RadioItem: MenuRadioItem,
  Group: BaseMenu.Group,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  /** `Menu.SubmenuRoot` in Base UI; wraps a {@link MenuSubmenuTrigger} and its own `Menu.Content`. */
  Submenu: BaseMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
  /** Connects a `Menu.Root` to triggers rendered outside of it. */
  createHandle: BaseMenu.createHandle
};

export default Menu;
