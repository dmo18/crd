/**
 * Downloads a CSV of exactly the items given by `query` (filters or `ids=`),
 * with the ID column, so the file can be edited and imported back to update
 * the same items. A plain link: the download is a file, not a page.
 */
export function ExportLink({ query, label }: { query: string; label: string }) {
  return (
    <a
      href={`/api/export${query ? `?${query}` : ""}`} download
      className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-border bg-surface-2 px-4 text-base font-semibold text-text"
    >
      {label}
    </a>
  );
}
