/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as asgard from "../asgard.js";
import type * as crons from "../crons.js";
import type * as deposits from "../deposits.js";
import type * as funds from "../funds.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_chain from "../lib/chain.js";
import type * as lib_depositMatch from "../lib/depositMatch.js";
import type * as lib_log from "../lib/log.js";
import type * as lib_okx from "../lib/okx.js";
import type * as lib_okxCredentials from "../lib/okxCredentials.js";
import type * as lib_okxTrade from "../lib/okxTrade.js";
import type * as lib_okxTradeCore from "../lib/okxTradeCore.js";
import type * as lib_positionCounts from "../lib/positionCounts.js";
import type * as liveTrading from "../liveTrading.js";
import type * as logs from "../logs.js";
import type * as okxConnections from "../okxConnections.js";
import type * as positions from "../positions.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  asgard: typeof asgard;
  crons: typeof crons;
  deposits: typeof deposits;
  funds: typeof funds;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/chain": typeof lib_chain;
  "lib/depositMatch": typeof lib_depositMatch;
  "lib/log": typeof lib_log;
  "lib/okx": typeof lib_okx;
  "lib/okxCredentials": typeof lib_okxCredentials;
  "lib/okxTrade": typeof lib_okxTrade;
  "lib/okxTradeCore": typeof lib_okxTradeCore;
  "lib/positionCounts": typeof lib_positionCounts;
  liveTrading: typeof liveTrading;
  logs: typeof logs;
  okxConnections: typeof okxConnections;
  positions: typeof positions;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
