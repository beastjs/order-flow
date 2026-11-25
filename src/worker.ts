import { asgardUsersApiPath } from './lib/asgard/users'
import { handleAsgardUsers } from './server/asgard-users'

export default {
  fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }) {
    if (new URL(request.url).pathname === asgardUsersApiPath) return handleAsgardUsers(request)
    return env.ASSETS.fetch(request)
  }
}
