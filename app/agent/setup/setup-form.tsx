"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function SetupForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    setError("");
    const res = await fetch("/api/agent/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(j.error || "Setup failed");
      return;
    }
    router.push("/agent/login");
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[#4f44d6] text-white shadow-lg shadow-primary/20">
          <Sparkles className="size-6" />
        </div>
        <CardTitle className="mt-2 text-xl">Welcome to Riyan Agent</CardTitle>
        <CardDescription>
          First run: set the password you'll use to log in from now on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="setup-password">New password</Label>
            <Input
              id="setup-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-confirm">Confirm password</Label>
            <Input
              id="setup-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !password} className="w-full">
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Saving…" : "Set password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
