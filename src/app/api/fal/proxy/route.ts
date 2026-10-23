import { createRouteHandler } from "@fal-ai/server-proxy/nextjs";
import { ALLOWED_ENDPOINTS } from "@/lib/models";

export const { GET, POST, PUT } = createRouteHandler({
  allowedEndpoints: ALLOWED_ENDPOINTS,
});
