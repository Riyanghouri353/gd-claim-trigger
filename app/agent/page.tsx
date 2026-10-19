import { redirect } from "next/navigation";
import { getSession } from "@/lib/agent/auth";
import ChatApp from "./chat-app";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  if (!session.loggedIn) redirect("/agent/login");
  return <ChatApp />;
}
