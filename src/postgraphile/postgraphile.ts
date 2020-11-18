import { Pool, PoolConfig } from 'pg';
import { IncomingMessage, ServerResponse } from 'http';
import { GraphQLSchema, GraphQLError } from 'graphql';
import { EventEmitter } from 'events';
import { createPostGraphileSchema, watchPostGraphileSchema } from 'postgraphile-core';
import createPostGraphileHttpRequestHandler from './http/createPostGraphileHttpRequestHandler';
import exportPostGraphileSchema from './schema/exportPostGraphileSchema';
import { pluginHookFromOptions } from './pluginHook';
import { PostGraphileOptions, mixed, HttpRequestHandler } from '../interfaces';
import chalk from 'chalk';
import { debugPgClient } from './withPostGraphileContext';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// tslint:disable-next-line no-any
function isPlainObject(obj: any) {
  if (!obj || typeof obj !== 'object' || String(obj) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(obj);
  if (proto === null || proto === Object.prototype) {
    return true;
  }
  return false;
}

export interface PostgraphileSchemaBuilder<
  Request extends IncomingMessage = IncomingMessage,
  Response extends ServerResponse = ServerResponse
> {
  _emitter: EventEmitter;
  getGraphQLSchema: () => Promise<GraphQLSchema>;
  options: PostGraphileOptions<Request, Response>;
  releaseWatch: null | (() => Promise<void>);
}

/**
 * Creates a PostGraphile Http request handler by first introspecting the
 * database to get a GraphQL schema, and then using that to create the Http
 * request handler.
 */
export function getPostgraphileSchemaBuilder<
  Request extends IncomingMessage = IncomingMessage,
  Response extends ServerResponse = ServerResponse
>(
  pgPool: Pool,
  schema: string | Array<string>,
  incomingOptions: PostGraphileOptions<Request, Response>,
  releasePgPool: null | (() => void) = null,
): PostgraphileSchemaBuilder {
  let releaseWatchFn: null | (() => Promise<void>) = null;
  async function releaseWatch() {
    if (releaseWatchFn) {
      await releaseWatchFn();
      releaseWatchFn = null;
    }
  }

  let released = false;
  async function releaseOnce() {
    if (released) {
      throw new Error(
        'Already released this PostGraphile schema builder; should not have attempted a second release',
      );
    }
    released = true;
    await releaseWatch();
    if (releasePgPool) {
      await releasePgPool();
    }
  }
  if (incomingOptions.live && incomingOptions.subscriptions == null) {
    // live implies subscriptions
    incomingOptions.subscriptions = true;
  }
  const pluginHook = pluginHookFromOptions(incomingOptions);
  const options = pluginHook('postgraphile:options', incomingOptions, {
    pgPool,
    schema,
  });
  // Check for a jwtSecret without a jwtPgTypeIdentifier
  // a secret without a token identifier prevents JWT creation
  if (options.jwtSecret && !options.jwtPgTypeIdentifier) {
    // tslint:disable-next-line no-console
    console.warn(
      'WARNING: jwtSecret provided, however jwtPgTypeIdentifier (token identifier) not provided.',
    );
  }

  if (options.handleErrors && (options.extendedErrors || options.showErrorStack)) {
    throw new Error(`You cannot combine 'handleErrors' with the other error options`);
  }

  // Creates the Postgres schemas array.
  const pgSchemas: Array<string> = Array.isArray(schema) ? schema : [schema];

  const _emitter: EventEmitter = options['_emitter'] || new EventEmitter();

  // Creates a promise which will resolve to a GraphQL schema. Connects a
  // client from our pool to introspect the database.
  //
  // This is not a constant because when we are in watch mode, we want to swap
  // out the `gqlSchema`.
  let gqlSchema: GraphQLSchema;
  const gqlSchemaPromise: Promise<GraphQLSchema> = createGqlSchema();

  return {
    _emitter,
    getGraphQLSchema: () => (gqlSchema ? Promise.resolve(gqlSchema) : gqlSchemaPromise),
    options,
    releaseWatch,
  };

  async function createGqlSchema(): Promise<GraphQLSchema> {
    let attempts = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (options.watchPg) {
          if (releaseWatchFn) {
            throw new Error(`releaseWatchFn should not have been set at this point.`);
          }
          releaseWatchFn = await watchPostGraphileSchema(pgPool, pgSchemas, options, newSchema => {
            gqlSchema = newSchema;
            _emitter.emit('schemas:changed');
            exportGqlSchema(gqlSchema);
          });
          if (!gqlSchema) {
            throw new Error(
              "Consistency error: watchPostGraphileSchema promises to call the callback before the promise resolves; but this hasn't happened",
            );
          }
        } else {
          gqlSchema = await createPostGraphileSchema(pgPool, pgSchemas, options);
          exportGqlSchema(gqlSchema);
        }
        if (attempts > 0) {
          // tslint:disable-next-line no-console
          console.error(
            `Schema ${
              attempts > 15 ? 'eventually' : attempts > 5 ? 'finally' : 'now'
            } generated successfully`,
          );
        }
        return gqlSchema;
      } catch (error) {
        attempts++;
        const delay = Math.min(100 * Math.pow(attempts, 2), 30000);
        if (typeof options.retryOnInitFail === 'function') {
          const start = process.hrtime();
          try {
            const retry = await options.retryOnInitFail(error, attempts);
            const diff = process.hrtime(start);
            const dur = diff[0] * 1e3 + diff[1] * 1e-6;
            if (!retry) {
              await releaseOnce();
              throw error;
            } else {
              if (dur < 50) {
                // retryOnInitFail didn't wait long enough; use default wait.
                console.error(
                  `Your retryOnInitFail function should include a delay before resolving; falling back to a ${delay}ms wait (attempts = ${attempts}) to avoid overwhelming the database.`,
                );
                await sleep(delay);
              }
            }
          } catch (e) {
            throw Object.defineProperties(
              new GraphQLError(
                'Failed to initialize GraphQL schema.',
                undefined,
                undefined,
                undefined,
                undefined,
                e,
              ),
              {
                status: {
                  value: 503,
                  enumerable: false,
                },
              },
            );
          }
        } else {
          const exitOnFail = !options.retryOnInitFail;
          // If we fail to build our schema, log the error and either exit or retry shortly
          logSeriousError(
            error,
            'building the initial schema' + (attempts > 1 ? ` (attempt ${attempts})` : ''),
            exitOnFail
              ? 'Exiting because `retryOnInitFail` is not set.'
              : `We'll try again in ${delay}ms.`,
          );
          if (exitOnFail) {
            process.exit(34);
          }
          // Retry shortly
          await sleep(delay);
        }
      }
    }
  }

  async function exportGqlSchema(newGqlSchema: GraphQLSchema): Promise<void> {
    try {
      await exportPostGraphileSchema(newGqlSchema, options);
    } catch (error) {
      // If we exit cleanly; let calling scripts know there was a problem.
      process.exitCode = 35;
      // If we fail to export our schema, log the error.
      logSeriousError(error, 'exporting the schema');
    }
  }
}
export default function postgraphile<
  Request extends IncomingMessage = IncomingMessage,
  Response extends ServerResponse = ServerResponse
>(
  poolOrConfig?: Pool | PoolConfig | string,
  schema?: string | Array<string>,
  options?: PostGraphileOptions<Request, Response>,
): HttpRequestHandler;
export default function postgraphile<
  Request extends IncomingMessage = IncomingMessage,
  Response extends ServerResponse = ServerResponse
>(
  poolOrConfig?: Pool | PoolConfig | string,
  options?: PostGraphileOptions<Request, Response>,
): HttpRequestHandler;
export default function postgraphile<
  Request extends IncomingMessage = IncomingMessage,
  Response extends ServerResponse = ServerResponse
>(
  poolOrConfig?: Pool | PoolConfig | string,
  schemaOrOptions?: string | Array<string> | PostGraphileOptions<Request, Response>,
  maybeOptions?: PostGraphileOptions<Request, Response>,
): HttpRequestHandler {
  let schema: string | Array<string>;
  // These are the raw options we're passed in; getPostgraphileSchemaBuilder
  // must process them with `pluginHook` before we can rely on them.
  let incomingOptions: PostGraphileOptions<Request, Response>;

  // If the second argument is a string or array, it is the schemas so set the
  // `schema` value and try to use the third argument (or a default) for
  // `incomingOptions`.
  if (typeof schemaOrOptions === 'string' || Array.isArray(schemaOrOptions)) {
    schema = schemaOrOptions;
    incomingOptions = maybeOptions || {};
  }
  // If the second argument is null or an object then use default `schema`
  // and set incomingOptions to second or third argument (or default).
  else if (typeof schemaOrOptions === 'object') {
    schema = 'public';
    incomingOptions = schemaOrOptions || maybeOptions || {};
  }
  // Otherwise if the second argument is present it's invalid: throw an error.
  else if (arguments.length > 1) {
    throw new Error(
      'The second argument to postgraphile was invalid... did you mean to set a schema?',
    );
  }
  // No schema or options specified, use defaults.
  else {
    schema = 'public';
    incomingOptions = {};
  }

  if (typeof poolOrConfig === 'undefined' && arguments.length >= 1) {
    throw new Error(
      'The first argument to postgraphile was `undefined`... did you mean to set pool options?',
    );
  }

  // Do some things with `poolOrConfig` so that in the end, we actually get a
  // Postgres pool.
  const { pgPool, releasePgPool } = toPgPool(poolOrConfig);

  pgPool.on('error', err => {
    /*
     * This handler is required so that client connection errors don't bring
     * the server down (via `unhandledError`).
     *
     * `pg` will automatically terminate the client and remove it from the
     * pool, so we don't actually need to take any action here, just ensure
     * that the event listener is registered.
     */
    // tslint:disable-next-line no-console
    console.error('PostgreSQL client generated error: ', err.message);
  });

  pgPool.on('connect', pgClient => {
    // Enhance our Postgres client with debugging stuffs.
    debugPgClient(pgClient, !!options.allowExplain);
  });

  const { getGraphQLSchema, options, _emitter, releaseWatch } = getPostgraphileSchemaBuilder<
    Request,
    Response
  >(pgPool, schema, incomingOptions, releasePgPool);

  async function release() {
    if (releaseWatch) {
      await releaseWatch();
    }
    if (releasePgPool) {
      await releasePgPool();
    }
  }

  return createPostGraphileHttpRequestHandler({
    ...(typeof poolOrConfig === 'string' ? { ownerConnectionString: poolOrConfig } : {}),
    ...options,
    getGqlSchema: getGraphQLSchema,
    pgPool,
    _emitter,
    release,
  });
}

function logSeriousError(error: Error, when: string, nextSteps?: string) {
  // tslint:disable-next-line no-console
  console.error(
    `A ${chalk.bold('serious error')} occurred when ${chalk.bold(when)}. ${
      nextSteps ? nextSteps + ' ' : ''
    }Error details:\n\n${error.stack}\n`,
  );
}

function hasPoolConstructor(obj: mixed): boolean {
  return (
    // tslint:disable-next-line no-any
    (obj && typeof obj.constructor === 'function' && obj.constructor === (Pool as any).super_) ||
    false
  );
}

function constructorName(obj: mixed): string | null {
  return (
    (obj &&
      typeof obj.constructor === 'function' &&
      obj.constructor.name &&
      String(obj.constructor.name)) ||
    null
  );
}

// tslint:disable-next-line no-any
function toPgPool(poolOrConfig: any): { pgPool: Pool; releasePgPool: null | (() => void) } {
  if (quacksLikePgPool(poolOrConfig)) {
    // If it is already a `Pool`, just use it.
    return { pgPool: poolOrConfig, releasePgPool: null };
  }

  if (typeof poolOrConfig === 'string') {
    // If it is a string, let us parse it to get a config to create a `Pool`.
    const pgPool = new Pool({ connectionString: poolOrConfig });
    return { pgPool, releasePgPool: () => pgPool.end() };
  } else if (!poolOrConfig) {
    // Use an empty config and let the defaults take over.
    const pgPool = new Pool({});
    return { pgPool, releasePgPool: () => pgPool.end() };
  } else if (isPlainObject(poolOrConfig)) {
    // The user handed over a configuration object, pass it through
    const pgPool = new Pool(poolOrConfig);
    return { pgPool, releasePgPool: () => pgPool.end() };
  } else {
    throw new Error('Invalid connection string / Pool ');
  }
}

// tslint:disable-next-line no-any
function quacksLikePgPool(pgConfig: any): pgConfig is Pool {
  if (pgConfig instanceof Pool) return true;
  if (hasPoolConstructor(pgConfig)) return true;

  // A diagnosis of exclusion
  if (!pgConfig || typeof pgConfig !== 'object') return false;
  if (constructorName(pgConfig) !== 'Pool' && constructorName(pgConfig) !== 'BoundPool')
    return false;
  if (!pgConfig['Client']) return false;
  if (!pgConfig['options']) return false;
  if (typeof pgConfig['connect'] !== 'function') return false;
  if (typeof pgConfig['end'] !== 'function') return false;
  if (typeof pgConfig['query'] !== 'function') return false;
  return true;
}
