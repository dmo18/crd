import { SelectionProvider } from "@/components/manage/selection";

/** Keeps the ticked rows while the owner moves between pages of the list. */
export default function ManageLayout({ children }: { children: React.ReactNode }) {
  return <SelectionProvider>{children}</SelectionProvider>;
}
