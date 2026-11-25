import { getFirebaseAdminAuth, listFirebaseUsers } from '../lib/firebase-admin/admin-core'
import { canViewTopgFirebaseUser } from '../lib/firebase-admin/custom-claims'
import { readFirebaseCustomClaims } from '../lib/firebase-admin/god-directory'
import { asgardPositionCountsPath, asgardUsersPageSize, type AsgardDirectoryPage, type AsgardOpenPositions } from '../lib/asgard/users'

function json(body: AsgardDirectoryPage | { error: string }, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

async function loadOpenPositions(token: string, uids: string[]): Promise<Map<string, AsgardOpenPositions>> {
  const siteUrl = process.env.CONVEX_SITE_URL?.trim()
  const secret = process.env.ASGARD_POSITION_COUNTS_SECRET?.trim()
  if (!siteUrl || !secret || !uids.length) return new Map()

  try {
    const response = await fetch(new URL(asgardPositionCountsPath, siteUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-asgard-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify(uids),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) {
      console.warn('Asgard position counts request was rejected.', response.status)
      return new Map()
    }
    const counts: Array<AsgardOpenPositions & { uid: string }> = await response.json()
    return new Map(counts.map(({ uid, up, down }) => [uid, { up, down }]))
  } catch (error) {
    console.warn('Could not fetch Asgard position counts.', error instanceof Error ? error.name : 'Unknown error')
    return new Map()
  }
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
    const page = await listFirebaseUsers(asgardUsersPageSize, pageToken)
    const users = page.users.filter((user) => canViewTopgFirebaseUser(claims, readFirebaseCustomClaims(user.customClaims)))
    const openPositions = await loadOpenPositions(token, users.map((user) => user.uid))

    return json({
      users: users.map(({ uid, displayName, email, disabled }) => ({
        uid,
        displayName: displayName ?? null,
        email: email ?? null,
        disabled,
        openPositions: openPositions.get(uid) ?? null
      })),
      nextPageToken: page.pageToken ?? null
    })
  } catch {
    return json({ error: 'Could not load users. Try again.' }, 502)
  }
}
