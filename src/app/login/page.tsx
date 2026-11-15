import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Card, LinkButton, Notice } from "@/components/ui";
import { isOwner } from "@/lib/auth/guard";
import { passwordSource, setupAvailable } from "@/lib/auth/password";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  await connection();
  if (await isOwner()) redirect("/");
  const noPassword = passwordSource().source === "none";
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-4">
      <h1 className="text-2xl font-bold">Card Vault</h1>
      {noPassword ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Finish setup first</h2>
          {setupAvailable() ? (
            <>
              <p className="text-sm text-muted">No password has been set yet. Choose one to start using Card Vault.</p>
              <LinkButton href="/setup">Set your password</LinkButton>
            </>
          ) : (
            <Notice tone="warn">
              No password has been set yet, and setup is turned off. Add a SETUP_CODE in the server settings, then come back.
            </Notice>
          )}
        </Card>
      ) : (
        <LoginForm />
      )}
    </main>
  );
}
