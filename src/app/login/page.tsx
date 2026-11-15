import { redirect } from "next/navigation";
import { isOwner } from "@/lib/auth/guard";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await isOwner()) redirect("/");
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-4">
      <h1 className="text-2xl font-bold">Card Vault</h1>
      <LoginForm />
    </main>
  );
}
