import { getFirebaseAdminAuth, listFirebaseUsers } from '../lib/firebase-admin/admin-core'
import { canViewTopgFirebaseUser } from '../lib/firebase-admin/custom-claims'
import { readFirebaseCustomClaims } from '../lib/firebase-admin/god-directory'
import type { AsgardDirectoryPage } from '../lib/asgard/users'

const pageSize = 100

function json(body: AsgardDirectoryPage | { error: string }, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

export async function handleAsgardUsers(request: Request): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, { allow: 'GET' })

  const token = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) return json({ error: 'Sign in to view users.' }, 401)

  const auth = getFirebaseAdminAuth()
  if (!auth) return json({ error: 'The user directory is unavailable.' }, 503)

  let identity
  try {
    identity = await auth.verifyIdToken(token, true)
  } catch {
    return json({ error: 'Your sign-in session is invalid or expired.' }, 401)
  }
  if (identity.god !== true) return json({ error: 'Asgard access is required.' }, 403)

  try {
    // Firebase ID tokens can outlive changes to custom claims.
    const actor = await auth.getUser(identity.uid)
    const claims = readFirebaseCustomClaims(actor.customClaims)
    if (actor.disabled || claims.god !== true) return json({ error: 'Asgard access is required.' }, 403)

    const pageToken = new URL(request.url).searchParams.get('pageToken') || undefined
    const page = await listFirebaseUsers(pageSize, pageToken)

    return json({
      users: page.users
        .filter((user) => canViewTopgFirebaseUser(claims, readFirebaseCustomClaims(user.customClaims)))
        .map(({ uid, displayName, email, disabled }) => ({
          uid,
          displayName: displayName ?? null,
          email: email ?? null,
          disabled
        })),
      nextPageToken: page.pageToken ?? null
    })
  } catch {
    return json({ error: 'Could not load users. Try again.' }, 502)
  }
}
