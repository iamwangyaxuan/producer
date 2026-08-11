import { createFileRoute } from "@tanstack/react-router";

import Icon from "#/components/ui/icon";
import Menu from "#/components/ui/menu";

export const Route = createFileRoute("/menu-preview")({
  component: MenuPreview
});

function MenuPreview() {
  return (
    <div className="grid min-h-screen place-items-center bg-[url('https://placehold.co/1200x800/1e293b/475569/png')] bg-cover">
      <Menu.Root modal={false}>
        <Menu.Trigger className="rounded-lg bg-neutral-800 px-3 py-2 text-sm text-white">
          Open menu
        </Menu.Trigger>
        <Menu.Content className="min-w-48">
          <Menu.Group>
            <Menu.GroupLabel>Project</Menu.GroupLabel>
            <Menu.Item>
              <Icon name="edit" className="text-sm" />
              Rename
            </Menu.Item>
            <Menu.Item>Duplicate</Menu.Item>
          </Menu.Group>
          <Menu.CheckboxItem defaultChecked>Show hidden</Menu.CheckboxItem>
          <Menu.Separator />
          <Menu.RadioGroup defaultValue="grid">
            <Menu.RadioItem value="grid">Grid</Menu.RadioItem>
            <Menu.RadioItem value="list">List</Menu.RadioItem>
          </Menu.RadioGroup>
          <Menu.Separator />
          <Menu.Submenu>
            <Menu.SubmenuTrigger>Share</Menu.SubmenuTrigger>
            <Menu.Content positioner={{ side: "inline-end", sideOffset: 4 }}>
              <Menu.Item>Copy link</Menu.Item>
              <Menu.Item>Invite</Menu.Item>
            </Menu.Content>
          </Menu.Submenu>
          <Menu.Item disabled>Archive</Menu.Item>
          <Menu.Item>Delete</Menu.Item>
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}
