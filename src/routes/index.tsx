import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main>
      <header>
        <Link to={"/login"}>Sign In</Link>
      </header>
    </main>
  );
}
