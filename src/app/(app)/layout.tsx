import { TabBar } from "@/components/nav/TabBar";
import { requireOwner } from "@/lib/auth/guard";
import { startPhotoArchiver } from "@/lib/images/archive";
import { maybeCleanupPhotos } from "@/lib/images/cleanup";
import { reviewCount } from "@/lib/items/duplicates";
import { scanQueueBusy } from "@/lib/scans/process";
import { appVersion } from "@/lib/version";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  // Runs in the background at most once a day; the page does not wait for it.
  void maybeCleanupPhotos();
  // Converts waiting photos to their small archive form, a few per minute,
  // while no scan is being read. Does nothing when it is already running.
  void startPhotoArchiver({ busy: scanQueueBusy });
  return (
    <>
      <main className="mx-auto w-full max-w-xl flex-1 p-4 pb-28">
        {children}
        <footer className="mt-8 text-center text-xs text-muted">{appVersion()}</footer>
      </main>
      <TabBar reviewCount={reviewCount()} />
    </>
  );
}
