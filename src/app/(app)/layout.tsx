import { TabBar } from "@/components/nav/TabBar";
import { requireOwner } from "@/lib/auth/guard";
import { maybeCleanupPhotos } from "@/lib/images/cleanup";
import { reviewCount } from "@/lib/items/duplicates";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  // Runs in the background at most once a day; the page does not wait for it.
  void maybeCleanupPhotos();
  return (
    <>
      <main className="mx-auto w-full max-w-xl flex-1 p-4 pb-28">{children}</main>
      <TabBar reviewCount={reviewCount()} />
    </>
  );
}
