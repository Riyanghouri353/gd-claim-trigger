"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    <form onSubmit={submit} className="w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-bold">Welcome to Riyan Agent</h1>
      <p className="text-sm text-zinc-400">
        First run: set the password you'll use to log in from now on.
      </p>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="New password (min 8 chars)"
        autoFocus
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 outline-none focus:border-indigo-500"
      />
      <input
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Confirm password"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 outline-none focus:border-indigo-500"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy || !password}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 font-medium hover:bg-indigo-500 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}
