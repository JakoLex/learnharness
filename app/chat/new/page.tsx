import { redirect } from "next/navigation";

/** A new session starts inside a project: pick one first (projects wave). */
export default function LegacyNewSessionPage() {
	redirect("/");
}
