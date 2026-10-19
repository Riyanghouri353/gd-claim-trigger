import { redirect } from "next/navigation";
import { isSetupDone } from "@/lib/agent/keys";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!(await isSetupDone())) redirect("/agent/setup");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <LoginForm />
    </main>
  );
}
