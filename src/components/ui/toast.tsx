import { Toast } from "@base-ui/react";
import type { ReactNode } from "react";

export default function ToastProvider({ children }: { children: ReactNode }) {
  return <Toast.Provider>{children}</Toast.Provider>;
}
