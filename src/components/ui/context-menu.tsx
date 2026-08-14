import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { useContext, useMemo, useState } from "react";

import { mergeClassName } from "#/components/ui/class-name";
import {
  MENU_POPUP_CLASS,
  MENU_POSITIONER_CLASS,
  MenuCheckboxItem,
  MenuContent,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuTrigger,
  SubmenuContext
} from "#/components/ui/menu";

/**
 * The region a right-click opens the menu over — passed through unstyled,
 * unlike `MenuTrigger`. The press blur that marks an open menu's trigger reads
 * as "this control is busy" on a button; on a region it would take a whole
 * working surface out of focus for as long as someone reads the menu.
 */
export const ContextMenuTrigger = BaseContextMenu.Trigger;

export interface ContextMenuContentProps extends BaseContextMenu.Popup.Props {
  container?: BaseContextMenu.Portal.Props["container"];
  keepMounted?: boolean;
  /**
   * Where to open, in viewport coordinates — for a menu whose right-click is
   * owned by something other than a `Trigger` element.
   *
   * The canvas is that case: React Flow reports the press, and which of the
   * two menus it means, before any element of ours has seen it. Base UI takes
   * an explicit anchor ahead of the one a trigger would have recorded, so
   * handing over the point is enough to get everything below.
   *
   * Leave it off when a `Trigger` wraps the region — it anchors the popup
   * itself, and at the same point.
   */
  point?: { x: number; y: number } | null;
  positioner?: BaseContextMenu.Positioner.Props;
}

/**
 * The same surface `Menu.Content` renders — same portal, positioner and popup
 * parts, same two class lists — landing where a context menu is supposed to
 * land, which is the whole reason this is not just `Menu.Content` with an
 * anchor passed in.
 *
 * Base UI positions a context menu differently on four counts, all of them
 * decided by the parent being a `ContextMenu.Root` rather than by any prop:
 *
 * - `position: fixed` rather than `absolute`, so the popup is placed in the
 *   coordinate system the pointer was reported in.
 * - `alignOffset: 2` / `sideOffset: -5`, which tucks the popup's corner under
 *   the pointer instead of leaving it hanging five pixels off it.
 * - `arrowPadding: 0` — an inset kept clear for an arrow means nothing when
 *   the anchor is a point.
 * - `shift` against the layout viewport rather than a flip, so a menu opened
 *   near an edge slides into view instead of turning inside out and landing
 *   somewhere the pointer is not.
 *
 * Offsets and alignment are therefore left unset here on purpose. `Menu`'s
 * preset names all three, which is why borrowing its `Content` for this was
 * never going to work: the values it passes are the ones that hold a popup
 * clear of the button below it, and against a point they only push it away.
 */
export function ContextMenuContent({
  container,
  keepMounted,
  point,
  positioner,
  className,
  ...props
}: ContextMenuContentProps) {
  const submenu = useContext(SubmenuContext);

  /**
   * The point the menu is *at*, which has to outlive the point it was *given*.
   *
   * `open` and the point come off one piece of caller state, so both clear on
   * the same render — but the popup is still on screen for the length of its
   * exit transition, and the moment ours goes away Base UI falls back to the
   * zero-sized anchor its root holds for a menu no trigger has opened yet. A
   * menu dismissed in the middle of the canvas spent its last 150ms flying
   * into the top-left corner (measured, not feared). Kept here instead, so it
   * closes where it opened.
   */
  const [anchorPoint, setAnchorPoint] = useState(point);

  // Compared by value, not by identity: a caller building the point inline
  // hands over a new object every render, and identity would take each one for
  // a move — which here means a re-render, which means another new object.
  if (point && (point.x !== anchorPoint?.x || point.y !== anchorPoint?.y)) setAnchorPoint(point);

  /**
   * Rebuilt only when the point moves. A fresh anchor object is a fresh
   * reference for the positioner to re-measure against, and this menu spends
   * its life open over a canvas that re-renders whenever a teammate's cursor
   * does.
   */
  const anchor = useMemo(
    () =>
      anchorPoint
        ? { getBoundingClientRect: () => DOMRect.fromRect({ x: anchorPoint.x, y: anchorPoint.y }) }
        : undefined,
    [anchorPoint]
  );

  // A submenu of a context menu is an ordinary menu: Base UI reads the parent
  // type per popup, and this one's parent is the submenu root, not the context
  // menu. So the menu preset here is not merely acceptable — it is the correct
  // one, and the point does not apply.
  if (submenu) {
    return (
      <MenuContent
        container={container}
        keepMounted={keepMounted}
        positioner={positioner}
        className={className}
        {...props}
      />
    );
  }

  return (
    <BaseContextMenu.Portal container={container} keepMounted={keepMounted}>
      <BaseContextMenu.Positioner
        anchor={anchor}
        {...positioner}
        className={mergeClassName(MENU_POSITIONER_CLASS, positioner?.className)}
      >
        <BaseContextMenu.Popup
          // The popup is portalled to the body, clear of whatever swallowed the
          // right-click that opened it, so a second right-click — on the menu
          // itself this time — would otherwise lay the browser's own menu over
          // ours. Base UI only covers the trigger and its backdrops.
          onContextMenu={(event) => event.preventDefault()}
          {...props}
          className={mergeClassName(MENU_POPUP_CLASS, className)}
        />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

const ContextMenu = {
  Root: BaseContextMenu.Root,
  Trigger: ContextMenuTrigger,
  Backdrop: BaseContextMenu.Backdrop,
  Content: ContextMenuContent,
  Item: MenuItem,
  LinkItem: MenuLinkItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: BaseContextMenu.RadioGroup,
  RadioItem: MenuRadioItem,
  Group: BaseContextMenu.Group,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  Submenu: MenuSubmenu,
  SubmenuTrigger: MenuSubmenuTrigger
};

export default ContextMenu;
