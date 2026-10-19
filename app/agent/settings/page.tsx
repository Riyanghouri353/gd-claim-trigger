import { redirect } from "next/navigation";
import { getSession } from "@/lib/agent/auth";
import SettingsClient from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session.loggedIn) redirect("/agent/login");
  return <SettingsClient />;
}
