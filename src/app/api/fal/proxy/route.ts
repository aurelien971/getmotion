import { createRouteHandler } from "@fal-ai/server-proxy/nextjs";
import { ALLOWED_ENDPOINTS } from "@/lib/models";

export const { GET, POST, PUT } = createRouteHandler({
  allowedEndpoints: ALLOWED_ENDPOINTS,
  // Always sign with the server key. The default falls back to the browser's
  // Authorization header, which on the password-protected site is the Basic
  // auth header, and fal rejects it.
  resolveFalAuth: async () => `Key ${process.env.FAL_KEY}`,
});
