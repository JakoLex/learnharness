import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { accountsEnabled, hasAccounts, requestUser } from "@/src/server";

export const dynamic = "force-dynamic";

/** Sign-in (accounts mode). Without accounts there is nothing to sign in
 *  to; before the first account exists, /setup comes first. */
export default async function LoginPage() {
	if (!accountsEnabled()) redirect("/");
	if (!hasAccounts()) redirect("/setup");
	if (!((await requestUser(undefined)) instanceof Response)) redirect("/");
	return <AuthForm mode="login" />;
}
