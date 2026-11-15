import { redirect } from "next/navigation";
import { appOriginHost } from "@/lib/env";
import { getSession } from "./session";

export async function isOwner(): Promise<boolean> {
  try {
    const session = await getSession();
    return session.owner === true;
  } catch {
    return false;
  }
}

export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) redirect("/login");
}

/**
 * Pure origin check for requests that change data. Browsers send Origin on
 * cross-site POSTs; compare its host with the host the request was sent to,
 * or with the host of APP_ORIGIN (the public address) when one is given.
 */
export function checkSameOrigin(request: Request, appHost: string | null = null): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (appHost && originHost === appHost.toLowerCase()) return true;
    return host !== "" && originHost === host;
  }
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

function json(status: number, error: string) {
  return Response.json({ error }, { status });
}

/** Call first in every route handler. Returns a response to send, or null when OK. */
export async function guardApi(request: Request): Promise<Response | null> {
  if (!(await isOwner())) return json(401, "Please sign in.");
  if (!checkSameOrigin(request, appOriginHost())) return json(403, "This request was blocked.");
  return null;
}
