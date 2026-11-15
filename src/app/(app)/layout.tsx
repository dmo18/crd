import { TabBar } from "@/components/nav/TabBar";
import { requireOwner } from "@/lib/auth/guard";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  return (
    <>
      <main className="mx-auto w-full max-w-xl flex-1 p-4 pb-28">{children}</main>
      <TabBar />
    </>
  );
}
