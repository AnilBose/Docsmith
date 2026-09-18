/**
 * Client-side view of where the editor service lives.
 *
 * The value is resolved once in next.config.mjs and injected at build time, so
 * this module and the /api proxy can never disagree about the port. Nothing
 * here issues requests to the origin directly -- the browser always talks to
 * the Next.js rewrite -- it exists so error messages can name the right port.
 */
const FALLBACK = "http://127.0.0.1:8420";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || FALLBACK;

export const API_PORT = (() => {
  try {
    return new URL(API_URL).port || "80";
  } catch {
    return new URL(FALLBACK).port;
  }
})();
