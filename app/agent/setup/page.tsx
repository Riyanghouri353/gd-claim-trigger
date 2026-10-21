import { redirect } from "next/navigation";
import { isSetupDone } from "@/lib/agent/keys";
import SetupForm from "./setup-form";
import ThemeToggle from "../theme-toggle";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isSetupDone()) redirect("/agent/login");
  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <SetupForm />
    </main>
  );
}
