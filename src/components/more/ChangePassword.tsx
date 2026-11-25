import { Card, Notice } from "@/components/ui";
import { passwordSource } from "@/lib/auth/password";
import { ChangePasswordForm } from "./ChangePasswordForm";

/** Owner only (the More page calls requireOwner first). */
export function ChangePassword() {
  const source = passwordSource().source;
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Password</h2>
      {source === "db" ? (
        <>
          <p className="text-sm text-muted">Changing it signs out every other phone and computer.</p>
          <ChangePasswordForm />
        </>
      ) : (
        <Notice tone="neutral">
          Your password is set in the server settings, so it cannot be changed here. Ask whoever runs the server to change it.
        </Notice>
      )}
    </Card>
  );
}
