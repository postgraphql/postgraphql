import { Pool, PoolConfig } from 'pg'
import { parse as parsePgConnectionString } from 'pg-connection-string'
import { GraphQLSchema } from 'graphql'
import chalk = require('chalk')
import createPostGraphQLSchema from './schema/createPostGraphQLSchema'
import createPostGraphQLHttpRequestHandler, { HttpRequestHandler } from './http/createPostGraphQLHttpRequestHandler'
import watchPgSchemas from './watch/watchPgSchemas'
import ServerSideNetworkLayer from './http/ServerSideNetworkLayer'

type PostGraphQLOptions = {
  classicIds?: boolean,
  dynamicJson?: boolean,
  graphqlRoute?: string,
  graphiqlRoute?: string,
  graphiql?: boolean,
  pgDefaultRole?: string,
  jwtSecret?: string,
  jwtPgTypeIdentifier?: string,
  watchPg?: boolean,
  showErrorStack?: boolean,
  disableQueryLog?: boolean,
  disableDefaultMutations?: boolean,
  enableCors?: boolean,
}

/**
 * Creates a PostGraphQL Http request handler by first introspecting the
 * database to get a GraphQL schema, and then using that to create the Http
 * request handler.
 */
interface ServerSideNetworkLayerFactory {
  (jwtToken: string, done: (err?: Error, result?: ServerSideNetworkLayer) => void): void
}
export default function postgraphql (poolOrConfig?: Pool | PoolConfig | string, schema?: string | Array<string>, options?: PostGraphQLOptions): HttpRequestHandler
export default function postgraphql (poolOrConfig?: Pool | PoolConfig | string, options?: PostGraphQLOptions): HttpRequestHandler
export default function postgraphql (
  poolOrConfig?: Pool | PoolConfig | string,
  schemaOrOptions?: string | Array<string> | PostGraphQLOptions,
  maybeOptions?: PostGraphQLOptions,
): HttpRequestHandler {
  const {getGqlSchema, pgPool, options} = _postgraphql(poolOrConfig, schemaOrOptions, maybeOptions)
  // Finally create our Http request handler using our options, the Postgres
  // pool, and GraphQL schema. Return the final result.
  return createPostGraphQLHttpRequestHandler(Object.assign({}, options, {
    getGqlSchema,
    pgPool,
  }))
}

export function postgraphqlServerSideNetworkLayerFactory (poolOrConfig?: Pool | PoolConfig | string, schema?: string | Array<string>, options?: PostGraphQLOptions): ServerSideNetworkLayerFactory
export function postgraphqlServerSideNetworkLayerFactory (poolOrConfig?: Pool | PoolConfig | string, options?: PostGraphQLOptions): ServerSideNetworkLayerFactory
export function postgraphqlServerSideNetworkLayerFactory (
  poolOrConfig?: Pool | PoolConfig | string,
  schemaOrOptions?: string | Array<string> | PostGraphQLOptions,
  maybeOptions?: PostGraphQLOptions,
): ServerSideNetworkLayerFactory {
  const {getGqlSchema, pgPool, options} = _postgraphql(poolOrConfig, schemaOrOptions, maybeOptions)
  return (async (jwtToken, done) => {
    let gqlSchema: GraphQLSchema
    try {
      gqlSchema = await getGqlSchema()
    } catch (e) {
      done(e)
      return
    }
    done(undefined, new ServerSideNetworkLayer(
      pgPool,
      gqlSchema,
      jwtToken,
      options,
    ))
  })
}

function _postgraphql(
  poolOrConfig?: Pool | PoolConfig | string,
  schemaOrOptions?: string | Array<string> | PostGraphQLOptions,
  maybeOptions?: PostGraphQLOptions,
) {
  let schema: string | Array<string>
  let options: PostGraphQLOptions

  // If the second argument is undefined, use defaults for both `schema` and
  // `options`.
  if (typeof schemaOrOptions === 'undefined') {
    schema = 'public'
    options = {}
  }
  // If the second argument is a string or array, it is the schemas so set the
  // `schema` value and try to use the third argument (or a default) for
  // `options`.
  else if (typeof schemaOrOptions === 'string' || Array.isArray(schemaOrOptions)) {
    schema = schemaOrOptions
    options = maybeOptions || {}
  }
  // Otherwise the second argument is the options so set `schema` to the
  // default and `options` to the second argument.
  else {
    schema = 'public'
    options = schemaOrOptions
  }

  // Creates the Postgres schemas array.
  const pgSchemas: Array<string> = Array.isArray(schema) ? schema : [schema]

  // Do some things with `poolOrConfig` so that in the end, we actually get a
  // Postgres pool.
  const pgPool =
    // If it is already a `Pool`, just use it.
    poolOrConfig instanceof Pool
      ? poolOrConfig
      : new Pool(typeof poolOrConfig === 'string'
        // Otherwise if it is a string, let us parse it to get a config to
        // create a `Pool`.
        ? parsePgConnectionString(poolOrConfig)
        // Finally, it must just be a config itself. If it is undefined, we
        // will just use an empty config and let the defaults take over.
        : poolOrConfig || {},
      )

  // Creates a promise which will resolve to a GraphQL schema. Connects a
  // client from our pool to introspect the database.
  //
  // This is not a constant because when we are in watch mode, we want to swap
  // out the `gqlSchema`.
  let gqlSchema = createGqlSchema()

  // If the user wants us to watch the schema, execute the following:
  if (options.watchPg) {
    watchPgSchemas({
      pgPool,
      pgSchemas,
      onChange: ({ commands }) => {
        // tslint:disable-next-line no-console
        console.log(`Restarting PostGraphQL API after Postgres command(s)${options.graphiql ? '. Make sure to reload GraphiQL' : ''}: ️${commands.map(command => chalk.bold.cyan(command)).join(', ')}`)

        // Actually restart the GraphQL schema by creating a new one. Note that
        // `createGqlSchema` returns a promise and we aren’t ‘await’ing it.
        gqlSchema = createGqlSchema()
      },
    })
      // If an error occurs when watching the Postgres schemas, log the error and
      // exit the process.
      .catch(error => {
        // tslint:disable-next-line no-console
        console.error(`${error.stack}\n`)
        process.exit(1)
      })
  }
  return {
    getGqlSchema: () => gqlSchema,
    options,
    pgPool,
  };


  /**
   * Creates a GraphQL schema by connecting a client from our pool which will
   * be used to introspect our Postgres database. If this function fails, we
   * will log the error and exit the process.
   *
   * This may only be executed once, at startup. However, if we are in watch
   * mode this will be updated whenever there is a change in our schema.
   */
  async function createGqlSchema (): Promise<GraphQLSchema> {
    try {
      const pgClient = await pgPool.connect()
      const newGqlSchema = await createPostGraphQLSchema(pgClient, pgSchemas, options)

      // If no release function exists, don’t release. This is just for tests.
      if (pgClient && pgClient.release)
        pgClient.release()

      return newGqlSchema
    }
    // If we fail to build our schema, log the error and exit the process.
    catch (error) {
      // tslint:disable no-console
      console.error(`${error.stack}\n`)
      process.exit(1)

      // This is just here to make TypeScript type check. `process.exit` will
      // quit our program meaning we never execute this code.
      return null as never
    }
  }
}
