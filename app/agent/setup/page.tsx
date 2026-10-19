import { redirect } from "next/navigation";
import { isSetupDone } from "@/lib/agent/keys";
import SetupForm from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isSetupDone()) redirect("/agent/login");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <SetupForm />
    </main>
  );
}
