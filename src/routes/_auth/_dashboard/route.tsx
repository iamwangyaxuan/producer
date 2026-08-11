import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/_dashboard")({
  component: RouteComponent
});

function RouteComponent() {
  return (
    <main>
      <aside></aside>
      <div>
        <Outlet />
      </div>
    </main>
  );
}
