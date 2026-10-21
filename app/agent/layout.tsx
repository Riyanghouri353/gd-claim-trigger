import type { ReactNode } from "react";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], display: "swap" });

/** Agent-wide shell: shadcn theme scope + font for every /agent page. */
export default function AgentLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`agent-shell min-h-dvh bg-background text-foreground ${inter.className}`}>
      {children}
    </div>
  );
}
