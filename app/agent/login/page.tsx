import { redirect } from "next/navigation";
import { isSetupDone } from "@/lib/agent/keys";
import LoginForm from "./login-form";
import ThemeToggle from "../theme-toggle";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!(await isSetupDone())) redirect("/agent/setup");
  return (
    <main className="relative flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <LoginForm />
    </main>
  );
}
