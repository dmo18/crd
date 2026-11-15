import { notFound } from "next/navigation";
import { connection } from "next/server";
import { setupAvailable } from "@/lib/auth/password";
import { SetupForm } from "./SetupForm";

export const metadata = { title: "Set up" };

/**
 * Public on purpose: the first visit has no password yet. Exists only while
 * no password is set anywhere and SETUP_CODE is set; otherwise not found.
 */
export default async function SetupPage() {
  await connection();
  if (!setupAvailable()) notFound();
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Set up Card Vault</h1>
        <p className="text-sm text-muted">
          Choose the password you will use to sign in. You need the setup code from the server settings
          (in Coolify: your app, then Environment Variables, SETUP_CODE).
        </p>
      </div>
      <SetupForm />
    </main>
  );
}
