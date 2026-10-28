import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { accountsEnabled, hasAccounts } from "@/src/server";

export const dynamic = "force-dynamic";

/** First setup (accounts mode): only while no account exists. */
export default async function SetupPage() {
	if (!accountsEnabled()) redirect("/");
	if (hasAccounts()) redirect("/login");
	return <AuthForm mode="setup" />;
}
