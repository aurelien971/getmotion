import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Originkit components are vendored as served; they aren't edited or linted here.
  globalIgnores(["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "src/components/originkit/**"]),
]);
