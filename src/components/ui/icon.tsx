import type { ComponentProps } from "react";

export default function Icon({
  name,
  className,
  ...props
}: ComponentProps<"span"> & { name: string }) {
  return (
    <span
      aria-hidden={true}
      {...props}
      className={["material-symbols", className].filter(Boolean).join(" ")}
    >
      <span>{name}</span>
    </span>
  );
}
