import { logout } from "@/lib/auth/actions";
import { Button } from "@/components/ui";

export function SignOutButton() {
  return (
    <form action={logout}>
      <Button type="submit" variant="secondary">Sign out</Button>
    </form>
  );
}
