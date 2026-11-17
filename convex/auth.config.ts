import type { AuthConfig } from "convex/server";

// Firebase Auth ID tokens are OIDC JWTs: issuer securetoken.google.com/<project>,
// audience <project>. Set FIREBASE_PROJECT_ID on each Convex deployment
// (`npx convex env set FIREBASE_PROJECT_ID <id>`) to match PUBLIC_FIREBASE_PROJECT_ID.
const projectId = process.env.FIREBASE_PROJECT_ID;

export default {
  providers: projectId
    ? [{ domain: `https://securetoken.google.com/${projectId}`, applicationID: projectId }]
    : [],
} satisfies AuthConfig;
