"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Light/dark toggle for the agent. The layout's inline script applies the
 * saved theme pre-paint via <html data-agent-theme>; this flips it live
 * and persists the choice to localStorage.
 */
export default function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.dataset.agentTheme === "light");
  }, []);

  function toggle() {
    const next = !light;
    setLight(next);
    if (next) {
      document.documentElement.dataset.agentTheme = "light";
    } else {
      delete document.documentElement.dataset.agentTheme;
    }
    try {
      localStorage.setItem("agent-theme", next ? "light" : "dark");
    } catch {
      /* private mode — theme just won't persist */
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      title={light ? "Switch to dark theme" : "Switch to light theme"}
      aria-label="Toggle theme"
    >
      {light ? <Moon className="size-[18px]" /> : <Sun className="size-[18px]" />}
    </Button>
  );
}
