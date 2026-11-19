import pkg from "../../package.json";

/**
 * The version shown in the footer: the package version plus the first 7
 * letters of the deployed git commit. Coolify sets SOURCE_COMMIT in the
 * running container. Anything that is not a plain hex commit is ignored, so
 * the footer never shows unexpected text.
 */
export function appVersion(commit: string | undefined = process.env.SOURCE_COMMIT): string {
  const c = (commit ?? "").trim().toLowerCase();
  const short = /^[0-9a-f]{7,40}$/.test(c) ? c.slice(0, 7) : "dev";
  return `Version ${pkg.version} (${short})`;
}
