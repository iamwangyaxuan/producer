import { Menu as BaseMenu } from "@base-ui/react/menu";
import { createContext, useContext } from "react";
import { cn, tv } from "tailwind-variants";

import Icon from "#/components/ui/icon";

type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

function mergeClassName<State>(preset: string, className: ClassName<State>): ClassName<State> {
  if (typeof className !== "function") return cn(preset, className);

  return (state) => cn(preset, className(state));
}

const SubmenuContext = createContext(false);

const itemClass = tv({
  base: "flex cursor-default items-center gap-2 rounded-xl p-2 text-[11px] leading-4 outline-hidden transition-colors duration-100 select-none data-highlighted:bg-[rgba(218,220,224,0.05)] active:blur-[1.5px] data-disabled:pointer-events-none data-disabled:text-neutral-500",
  variants: {
    inset: { true: "ps-7.5" },
    submenu: { true: "data-popup-open:bg-[rgba(218,220,224,0.05)]" }
  }
});

export interface MenuContentProps extends BaseMenu.Popup.Props {
  container?: BaseMenu.Portal.Props["container"];
  keepMounted?: boolean;
  positioner?: BaseMenu.Positioner.Props;
}

export function MenuContent({
  container,
  keepMounted,
  positioner,
  className,
  ...props
}: MenuContentProps) {
  const offsets = useContext(SubmenuContext)
    ? { sideOffset: 16, alignOffset: -8 }
    : { sideOffset: 8, alignOffset: 0 };

  return (
    <BaseMenu.Portal container={container} keepMounted={keepMounted}>
      <BaseMenu.Positioner
        align="start"
        {...offsets}
        {...positioner}
        className={mergeClassName("z-50 min-w-48 outline-hidden", positioner?.className)}
      >
        <BaseMenu.Popup
          {...props}
          className={mergeClassName(
            "min-w-max origin-(--transform-origin) rounded-[18px] bg-[rgba(22,23,24,0.9)] p-2 text-foreground shadow-[0_16px_40px_rgba(0,0,0,0.45)] outline-hidden backdrop-blur-2xl transition-[transform,opacity] duration-150 ease-out max-h-(--available-height) overflow-y-auto overscroll-contain data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none",
            className
          )}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

interface InsetProps {
  inset?: boolean;
}

export function MenuItem({ className, inset, ...props }: BaseMenu.Item.Props & InsetProps) {
  return <BaseMenu.Item {...props} className={mergeClassName(itemClass({ inset }), className)} />;
}

export function MenuLinkItem({ className, inset, ...props }: BaseMenu.LinkItem.Props & InsetProps) {
  return (
    <BaseMenu.LinkItem {...props} className={mergeClassName(itemClass({ inset }), className)} />
  );
}

export function MenuCheckboxItem({ className, children, ...props }: BaseMenu.CheckboxItem.Props) {
  return (
    <BaseMenu.CheckboxItem {...props} className={mergeClassName(itemClass(), className)}>
      <BaseMenu.CheckboxItemIndicator
        keepMounted
        className="flex size-3.5 shrink-0 items-center justify-center data-unchecked:invisible"
      >
        <Icon name="check" className="text-sm" />
      </BaseMenu.CheckboxItemIndicator>
      {children}
    </BaseMenu.CheckboxItem>
  );
}

export function MenuRadioItem({ className, children, ...props }: BaseMenu.RadioItem.Props) {
  return (
    <BaseMenu.RadioItem {...props} className={mergeClassName(itemClass(), className)}>
      <BaseMenu.RadioItemIndicator
        keepMounted
        className="flex size-3.5 shrink-0 items-center justify-center data-unchecked:invisible"
      >
        <span className="size-1.5 rounded-full bg-current" />
      </BaseMenu.RadioItemIndicator>
      {children}
    </BaseMenu.RadioItem>
  );
}

export function MenuSubmenuTrigger({
  className,
  children,
  inset,
  ...props
}: BaseMenu.SubmenuTrigger.Props & InsetProps) {
  return (
    <BaseMenu.SubmenuTrigger
      {...props}
      className={mergeClassName(itemClass({ inset, submenu: true }), className)}
    >
      {children}
      <Icon name="chevron_right" className="ml-auto text-sm text-neutral-400" />
    </BaseMenu.SubmenuTrigger>
  );
}

export function MenuSubmenu({ children, ...props }: BaseMenu.SubmenuRoot.Props) {
  return (
    <BaseMenu.SubmenuRoot {...props}>
      <SubmenuContext value={true}>{children}</SubmenuContext>
    </BaseMenu.SubmenuRoot>
  );
}

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

export function MenuSeparator({ className, ...props }: BaseMenu.Separator.Props) {
  return (
    <BaseMenu.Separator
      {...props}
      className={mergeClassName("my-1.5 h-px bg-[rgba(218,220,224,0.1)]", className)}
    />
  );
}

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
  Submenu: MenuSubmenu,
  SubmenuTrigger: MenuSubmenuTrigger,
  createHandle: BaseMenu.createHandle
};

export default Menu;
