import type { FirebaseAdminUserSummary } from '../firebase-admin/admin-users'

export const asgardUsersApiPath = '/api/asgard/users'
export const asgardPositionCountsPath = '/asgard/position-counts'
export const asgardUsersPageSize = 100

export type AsgardOpenPositions = { up: number; down: number }

export type AsgardUser = Pick<FirebaseAdminUserSummary, 'uid' | 'displayName' | 'email' | 'disabled'> & {
  openPositions: AsgardOpenPositions | null
}

export type AsgardDirectoryPage = {
  users: AsgardUser[]
  nextPageToken: string | null
}
