import type { FirebaseAdminUserSummary } from '../firebase-admin/admin-users'

export const asgardUsersApiPath = '/api/asgard/users'

export type AsgardUser = Pick<FirebaseAdminUserSummary, 'uid' | 'displayName' | 'email' | 'disabled'>

export type AsgardDirectoryPage = {
  users: AsgardUser[]
  nextPageToken: string | null
}
