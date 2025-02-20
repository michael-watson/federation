import { Headers } from 'node-fetch';
import {
  GraphQLError,
  Kind,
  TypeNameMetaFieldDef,
  GraphQLFieldResolver,
  GraphQLFormattedError,
  isAbstractType,
  GraphQLSchema,
  isObjectType,
  isInterfaceType,
  GraphQLErrorOptions,
  DocumentNode,
  executeSync,
  OperationTypeNode,
  FieldNode,
} from 'graphql';
import { Trace, google } from '@apollo/usage-reporting-protobuf';
import { GraphQLDataSource, GraphQLDataSourceRequestKind } from './datasources/types';
import { OperationContext } from './operationContext';
import {
  FetchNode,
  PlanNode,
  QueryPlan,
  ResponsePath,
  QueryPlanSelectionNode,
  QueryPlanFieldNode,
  getResponseName,
  FetchDataInputRewrite,
  FetchDataOutputRewrite,
} from '@apollo/query-planner';
import { deepMerge } from './utilities/deepMerge';
import { isNotNullOrUndefined } from './utilities/array';
import { SpanStatusCode } from "@opentelemetry/api";
import { OpenTelemetrySpanNames, tracer } from "./utilities/opentelemetry";
import { assert, defaultRootName, errorCodeDef, ERRORS, isDefined, operationFromDocument, Schema } from '@apollo/federation-internals';
import { GatewayGraphQLRequestContext, GatewayExecutionResult } from '@apollo/server-gateway-interface';
import { computeResponse } from './resultShaping';

export type ServiceMap = {
  [serviceName: string]: GraphQLDataSource;
};

type ResultMap = Record<string, any>;

/**
 * Represents some "cursor" within the full result, or put another way, a path into the full result and where it points to.
 *
 * Note that results can include lists and the the `path` considered can traverse those lists (the path will have a '@' character) so
 * the data pointed by a cursor is not necessarily a single "branch" of the full results, but is in general a flattened list of all
 * the sub-branches pointed by the path.
 */
type ResultCursor = {
  // Path into `fullResult` this cursor is pointing at.
  path: ResponsePath,

  // The data pointed by this cursor.
  data: ResultMap | ResultMap[],

  // The full result .
  fullResult: ResultMap,
}

interface ExecutionContext {
  queryPlan: QueryPlan;
  operationContext: OperationContext;
  serviceMap: ServiceMap;
  requestContext: GatewayGraphQLRequestContext;
  supergraphSchema: GraphQLSchema;
  errors: GraphQLError[];
}

function makeIntrospectionQueryDocument(introspectionSelection: FieldNode): DocumentNode {
  return {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: OperationTypeNode.QUERY,
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [ introspectionSelection ],
        }
      }
    ],
  };
}

function executeIntrospection(
  schema: GraphQLSchema,
  introspectionSelection: FieldNode,
): any {
  const { data } = executeSync({
    schema,
    document: makeIntrospectionQueryDocument(introspectionSelection),
    rootValue: {},
  });
  assert(data, () => `Introspection query for ${JSON.stringify(introspectionSelection)} should not have failed`);
  return data[introspectionSelection.name.value];
}

export async function executeQueryPlan(
  queryPlan: QueryPlan,
  serviceMap: ServiceMap,
  requestContext: GatewayGraphQLRequestContext,
  operationContext: OperationContext,
  supergraphSchema: GraphQLSchema,
  apiSchema: Schema,
): Promise<GatewayExecutionResult> {

  const logger = requestContext.logger || console;

  return tracer.startActiveSpan(OpenTelemetrySpanNames.EXECUTE, async span => {
    try {
      const errors: GraphQLError[] = [];

      const context: ExecutionContext = {
        queryPlan,
        operationContext,
        serviceMap,
        requestContext,
        supergraphSchema,
        errors,
      };

      const unfilteredData: ResultMap = Object.create(null);

      const captureTraces = !!(
          requestContext.metrics && requestContext.metrics.captureTraces
      );

      if (queryPlan.node) {
        const traceNode = await executeNode(
          context,
          queryPlan.node,
          {
            path: [],
            data: unfilteredData,
            fullResult: unfilteredData,
          },
          captureTraces,
        );
        if (captureTraces) {
          requestContext.metrics!.queryPlanTrace = traceNode;
        }
      }

      const result = await tracer.startActiveSpan(OpenTelemetrySpanNames.POST_PROCESSING, async (span) => {
        let data;
        try {
          const operation = operationFromDocument(
            apiSchema,
            {
              kind: Kind.DOCUMENT,
              definitions: [
                operationContext.operation,
                ...Object.values(operationContext.fragments),
              ],
            },
            {
              validate: false,
            }
          );

          let postProcessingErrors: GraphQLError[];
          ({ data, errors: postProcessingErrors } = computeResponse({
            operation,
            variables: requestContext.request.variables,
            input: unfilteredData,
            introspectionHandling: (f) => executeIntrospection(operationContext.schema, f.expandFragments().toSelectionNode()),
          }));

          // If we have errors during the post-processing, we ignore them if any other errors have been thrown during
          // query plan execution. That is because in many cases, errors during query plan execution will leave the
          // internal data in a state that triggers additional post-processing errors, but that leads to 2 errors recorded
          // for the same problem and that is unexpected by clients. See https://github.com/apollographql/federation/issues/981
          // for additional context.
          // If we had no errors during query plan execution, then we do ship any post-processing ones as there is little
          // reason not to and it might genuinely help debugging (note that if subgraphs return no errors and we assume that
          // subgraph do return graphQL valid responses, then our composition rules should guarantee no post-processing errors,
          // so getting a post-processing error points to either 1) a bug in our code or in composition or 2) a subgraph not
          // returning valid graphQL results, both of which are well worth surfacing (see [this comment for instance](https://github.com/apollographql/federation/pull/159#issuecomment-801132906))).
          //
          // That said, note that this is still not perfect in the sense that if someone does get subgraph errors, then
          // while postProcessingErrors may duplicate those, it may also contain additional unrelated errors (again, something
          // like a subgraph returning non-grapqlQL valid data unknowingly), and we don't surface those. In a perfect worlds
          // we've be able to filter the post-proessing errors that duplicate errors from subgraph and still ship anything that
          // remains, but it's unclear how to do that at all (it migth be that checking the error path helps, but not sure
          // that's fullproof).
          if (errors.length === 0 && postProcessingErrors.length > 0) {
            span.setStatus({ code:SpanStatusCode.ERROR });
            return { errors: postProcessingErrors, data };
          }
        } catch (error) {
          span.setStatus({ code:SpanStatusCode.ERROR });
          if (error instanceof GraphQLError) {
            return { errors: [error] };
          } else if (error instanceof Error) {
            return {
              errors: [
                new GraphQLError(
                  error.message,
                  { originalError: error },
                )
              ]
            };
          } else {
            // The above cases should cover the known cases, but if we received
            // something else in the `catch` — like an object or something, we
            // may not want to merely return this to the client.
            logger.error(
              "Unexpected error during query plan execution: " + error);
            return {
              errors: [
                new GraphQLError(
                  "Unexpected error during query plan execution",
                )
              ]
            };
          }
        }
        finally {
          span.end()
        }
        if(errors.length > 0) {
          span.setStatus({ code:SpanStatusCode.ERROR });
        }
        return errors.length === 0 ? { data } : { errors, data };
      });

      if(result.errors) {
        span.setStatus({ code:SpanStatusCode.ERROR });
      }
      return result;
    }
    catch (err) {
      span.setStatus({ code:SpanStatusCode.ERROR });
      throw err;
    }
    finally {
      span.end();
    }
  });
}

// Note: this function always returns a protobuf QueryPlanNode tree, even if
// we're going to ignore it, because it makes the code much simpler and more
// typesafe. However, it doesn't actually ask for traces from the backend
// service unless we are capturing traces for Studio.
async function executeNode(
  context: ExecutionContext,
  node: PlanNode,
  currentCursor: ResultCursor | undefined,
  captureTraces: boolean,
): Promise<Trace.QueryPlanNode> {
  if (!currentCursor) {
    // XXX I don't understand `results` threading well enough to understand when this happens
    //     and if this corresponds to a real query plan node that should be reported or not.
    //
    // This may be if running something like `query { fooOrNullFromServiceA {
    // somethingFromServiceB } }` and the first field is null, then we don't bother to run the
    // inner field at all.
    return new Trace.QueryPlanNode();
  }

  switch (node.kind) {
    case 'Sequence': {
      const traceNode = new Trace.QueryPlanNode.SequenceNode();
      for (const childNode of node.nodes) {
        const childTraceNode = await executeNode(
          context,
          childNode,
          currentCursor,
          captureTraces,
        );
        traceNode.nodes.push(childTraceNode!);
      }
      return new Trace.QueryPlanNode({ sequence: traceNode });
    }
    case 'Parallel': {
      const childTraceNodes = await Promise.all(
        node.nodes.map(async (childNode) =>
          executeNode(
            context,
            childNode,
            currentCursor,
            captureTraces,
          ),
        ),
      );
      return new Trace.QueryPlanNode({
        parallel: new Trace.QueryPlanNode.ParallelNode({
          nodes: childTraceNodes,
        }),
      });
    }
    case 'Flatten': {
      return new Trace.QueryPlanNode({
        flatten: new Trace.QueryPlanNode.FlattenNode({
          responsePath: node.path.map(
            id =>
              new Trace.QueryPlanNode.ResponsePathElement(
                typeof id === 'string' ? { fieldName: id } : { index: id },
              ),
          ),
          node: await executeNode(
            context,
            node.node,
            moveIntoCursor(currentCursor, node.path),
            captureTraces,
          ),
        }),
      });
    }
    case 'Fetch': {
      const traceNode = new Trace.QueryPlanNode.FetchNode({
        serviceName: node.serviceName,
        // executeFetch will fill in the other fields if desired.
      });
      try {
        await executeFetch(
          context,
          node,
          currentCursor,
          captureTraces ? traceNode : null,
        );
      } catch (error) {
        context.errors.push(error);
      }
      return new Trace.QueryPlanNode({ fetch: traceNode });
    }
    case 'Defer': {
      assert(false, `@defer support is not available in the gateway`);
    }
    case 'Condition': {
      assert(false, `Condition nodes are not available in the gateway`);
    }
  }
}

async function executeFetch(
  context: ExecutionContext,
  fetch: FetchNode,
  currentCursor: ResultCursor,
  traceNode: Trace.QueryPlanNode.FetchNode | null,
): Promise<void> {

  const logger = context.requestContext.logger || console;
  const service = context.serviceMap[fetch.serviceName];

  return tracer.startActiveSpan(OpenTelemetrySpanNames.FETCH, {attributes:{service:fetch.serviceName}}, async span => {
    try {
      if (!service) {
        throw new Error(`Couldn't find service with name "${fetch.serviceName}"`);
      }

      let entities: ResultMap[];
      if (Array.isArray(currentCursor.data)) {
        // Remove null or undefined entities from the list
        entities = currentCursor.data.filter(isNotNullOrUndefined);
      } else {
        entities = [currentCursor.data];
      }

      if (entities.length < 1) return;

      const variables = Object.create(null);
      if (fetch.variableUsages) {
        for (const variableName of fetch.variableUsages) {
          const providedVariables = context.requestContext.request.variables;
          if (
              providedVariables &&
              typeof providedVariables[variableName] !== 'undefined'
          ) {
            variables[variableName] = providedVariables[variableName];
          }
        }
      }

      if (!fetch.requires) {
        const dataReceivedFromService = await sendOperation(variables);

        for (const entity of entities) {
          deepMerge(entity, withFetchRewrites(dataReceivedFromService, fetch.outputRewrites));
        }
      } else {
        const requires = fetch.requires;

        const representations: ResultMap[] = [];
        const representationToEntity: number[] = [];

        entities.forEach((entity, index) => {
          const representation = executeSelectionSet(
            // Note that `requires` may include references to inacessible elements, so we should "execute" it using the supergrah
            // schema, _not_ the API schema (the one in `context.operationContext.schema`). And this is not a security risk since
            // what we're extracting here is what is sent to subgraphs, and subgraphs knows `@inacessible` elements.
            context.supergraphSchema,
            entity,
            requires,
            fetch.inputRewrites,
          );
          if (representation && representation[TypeNameMetaFieldDef.name]) {
            representations.push(representation);
            representationToEntity.push(index);
          }
        });

        // If there are no representations, that means the type conditions in
        // the requires don't match any entities.
        if (representations.length < 1) return;

        if ('representations' in variables) {
          throw new Error(`Variables cannot contain key "representations"`);
        }

        const dataReceivedFromService = await sendOperation({...variables, representations});

        if (!dataReceivedFromService) {
          return;
        }

        if (
            !(
                dataReceivedFromService._entities &&
                Array.isArray(dataReceivedFromService._entities)
            )
        ) {
          throw new Error(`Expected "data._entities" in response to be an array`);
        }

        const receivedEntities = dataReceivedFromService._entities;

        if (receivedEntities.length !== representations.length) {
          throw new Error(
              `Expected "data._entities" to contain ${representations.length} elements`,
          );
        }

        for (let i = 0; i < entities.length; i++) {
          deepMerge(entities[representationToEntity[i]], withFetchRewrites(receivedEntities[i], filterEntityRewrites(representations[i], fetch.outputRewrites)));
        }
      }
    }
    catch (err) {
      span.setStatus({ code:SpanStatusCode.ERROR });
      throw err;
    }
    finally
    {
      span.end();
    }
  });

  async function sendOperation(
    variables: Record<string, any>,
  ): Promise<ResultMap | void | null> {

    // We declare this as 'any' because it is missing url and method, which
    // GraphQLRequest.http is supposed to have if it exists.
    // (This is admittedly kinda weird, since we currently do pass url and
    // method to `process` from the SDL fetching call site, but presumably
    // existing implementation of the interface don't try to look for these
    // fields. RemoteGraphQLDataSource just overwrites them.)
    let http: any;

    // If we're capturing a trace for Studio, then save the operation text to
    // the node we're building and tell the federated service to include a trace
    // in its response.
    if (traceNode) {
      http = {
        headers: new Headers({ 'apollo-federation-include-trace': 'ftv1' }),
      };
      if (
        context.requestContext.metrics &&
        context.requestContext.metrics.startHrTime
      ) {
        traceNode.sentTimeOffset = durationHrTimeToNanos(
          process.hrtime(context.requestContext.metrics.startHrTime),
        );
      }
      traceNode.sentTime = dateToProtoTimestamp(new Date());
    }

    const response = await service.process({
      kind: GraphQLDataSourceRequestKind.INCOMING_OPERATION,
      request: {
        query: fetch.operation,
        variables,
        operationName: fetch.operationName,
        http,
      },
      incomingRequestContext: context.requestContext,
      context: context.requestContext.context,
      document: fetch.operationDocumentNode,
    });

    if (response.errors) {
      const errorPathHelper = makeLazyErrorPathGenerator(fetch, currentCursor);

      const errors = response.errors.map((error) =>
        downstreamServiceError(error, fetch.serviceName, errorPathHelper),
      );
      context.errors.push(...errors);

      if (!response.extensions?.ftv1) {
        const errorPaths = response.errors.map((error) => ({
          subgraph: fetch.serviceName,
          path: error.path,
        }));
        if (context.requestContext.metrics.nonFtv1ErrorPaths) {
          context.requestContext.metrics.nonFtv1ErrorPaths.push(...errorPaths);
        } else {
          context.requestContext.metrics.nonFtv1ErrorPaths = errorPaths;
        }
      }
    }

    // If we're capturing a trace for Studio, save the received trace into the
    // query plan.
    if (traceNode) {
      traceNode.receivedTime = dateToProtoTimestamp(new Date());

      if (response.extensions && response.extensions.ftv1) {
        const traceBase64 = response.extensions.ftv1;

        let traceBuffer: Buffer | undefined;
        let traceParsingFailed = false;
        try {
          // XXX support non-Node implementations by using Uint8Array? protobufjs
          // supports that, but there's not a no-deps base64 implementation.
          traceBuffer = Buffer.from(traceBase64, 'base64');
        } catch (err) {
          logger.error(
            `error decoding base64 for federated trace from ${fetch.serviceName}: ${err}`,
          );
          traceParsingFailed = true;
        }

        if (traceBuffer) {
          try {
            const trace = Trace.decode(traceBuffer);
            traceNode.trace = trace;
          } catch (err) {
            logger.error(
              `error decoding protobuf for federated trace from ${fetch.serviceName}: ${err}`,
            );
            traceParsingFailed = true;
          }
        }
        if (traceNode.trace) {
          // Federation requires the root operations in the composed schema
          // to have the default names (Query, Mutation, Subscription) even
          // if the implementing services choose different names, so we override
          // whatever the implementing service reported here.
          const rootTypeName = defaultRootName(
            context.operationContext.operation.operation,
          );
          traceNode.trace.root?.child?.forEach((child) => {
            child.parentType = rootTypeName;
          });
        }
        traceNode.traceParsingFailed = traceParsingFailed;
      }
    }

    return response.data;
  }
}

type ErrorPathGenerator = (
  path: GraphQLErrorOptions['path'],
) => GraphQLErrorOptions['path'];

/**
 * Given response data collected so far and a path such as:
 *
 *    ["foo", "@", "bar", "@"]
 *
 * the returned function generates a list of "hydrated" paths, replacing the
 * `"@"` with array indices from the actual data. When we encounter an error in
 * a subgraph fetch, we can use the index in the error's path (e.g.
 * `["_entities", 2, "boom"]`) to look up the appropriate "hydrated" path
 * prefix. The result is something like:
 *
 *    ["foo", 1, "bar", 2, "boom"]
 *
 * The returned function is lazy — if we don't encounter errors and it's never
 * called, then we never process the response data to hydrate the paths.
 *
 * This approach is inspired by Apollo Router: https://github.com/apollographql/router/blob/0fd59d2e11cc09e82c876a5fee263b5658cb9539/apollo-router/src/query_planner/fetch.rs#L295-L403
 */
function makeLazyErrorPathGenerator(
  fetch: FetchNode,
  cursor: ResultCursor,
): ErrorPathGenerator {
  let hydratedPaths: ResponsePath[] | undefined;

  return (errorPath: GraphQLErrorOptions['path']) => {
    if (fetch.requires && typeof errorPath?.[1] === 'number') {
      // only generate paths if we need to look them up via entity index
      if (!hydratedPaths) {
        hydratedPaths = [];
        generateHydratedPaths(
          [],
          cursor.path,
          cursor.fullResult,
          hydratedPaths,
        );
      }

      const hydratedPath = hydratedPaths[errorPath[1]] ?? [];
      return [...hydratedPath, ...errorPath.slice(2)];
    } else {
      return errorPath ? [...cursor.path, ...errorPath.slice()] : undefined;
    }
  };
}

/**
 * Given a deeply nested object and a path such as `["foo", "@", "bar", "@"]`,
 * walk the path to build up a list of of "hydrated" paths that match the data,
 * such as:
 *
 *    [
 *      ["foo", 0, "bar", 0, "boom"],
 *      ["foo", 0, "bar", 1, "boom"]
 *      ["foo", 1, "bar", 0, "boom"],
 *      ["foo", 1, "bar", 1, "boom"]
 *    ]
 */
export function generateHydratedPaths(
  parent: ResponsePath,
  path: ResponsePath,
  data: ResultMap | null,
  result: ResponsePath[],
) {
  const head = path[0];

  if (data == null) {
    return;
  }

  if (head == null) { // terminate recursion
    result.push(parent.slice());
  } else if (head === '@') {
    assert(Array.isArray(data), 'expected array when encountering `@`');
    for (const [i, value] of data.entries()) {
      parent.push(i);
      generateHydratedPaths(parent, path.slice(1), value, result);
      parent.pop();
    }
  } else if (typeof head === 'string') {
    if (Array.isArray(data)) {
      for (const [i, value] of data.entries()) {
        parent.push(i);
        generateHydratedPaths(parent, path, value, result);
        parent.pop();
      }
    } else {
      if (head in data) {
        const value = data[head];
        parent.push(head);
        generateHydratedPaths(parent, path.slice(1), value, result);
        parent.pop();
      }
    }
  } else {
    assert(false, `unknown path part "${head}"`);
  }
}

function applyOrMapRecursive(value: any | any[], fct: (v: any) => any | undefined): any | any[] | undefined {
  if (Array.isArray(value)) {
    const res = value.map((elt) => applyOrMapRecursive(elt, fct)).filter(isDefined);
    return res.length === 0 ? undefined : res;
  }
  return fct(value);
}

function withFetchRewrites(fetchResult: ResultMap | null | void, rewrites: FetchDataOutputRewrite[] | undefined): ResultMap | null | void {
  if (!rewrites || !fetchResult) {
    return fetchResult;
  }

  for (const rewrite of rewrites) {
    let obj: any = fetchResult;
    let i = 0;
    while (obj && i < rewrite.path.length - 1) {
      const p = rewrite.path[i++];
      if (p.startsWith('... on ')) {
        const typename = p.slice('... on '.length);
        // Filter only objects that match the condition.
        obj = applyOrMapRecursive(obj, (elt) => elt[TypeNameMetaFieldDef.name] === typename ? elt : undefined);
      } else {
        obj = applyOrMapRecursive(obj, (elt) => elt[p]);
      }
    }
    if (obj) {
      applyOrMapRecursive(obj, (elt) => {
        if (typeof elt === 'object') {
          // We need to move the value at path[i] to `renameKeyTo`.
          const removedKey = rewrite.path[i];
          elt[rewrite.renameKeyTo] = elt[removedKey];
          elt[removedKey] = undefined;
        }
      });
    }
  }
  return fetchResult;
}

function filterEntityRewrites(entity: Record<string, any>, rewrites: FetchDataOutputRewrite[] | undefined): FetchDataOutputRewrite[] | undefined {
  if (!rewrites) {
    return undefined;
  }

  const typename = entity[TypeNameMetaFieldDef.name] as string;
  const typenameAsFragment = `... on ${typename}`;
  return rewrites.map((r) => r.path[0] === typenameAsFragment ? { ...r, path: r.path.slice(1) } : undefined).filter(isDefined)
}

function updateRewrites(rewrites: FetchDataInputRewrite[] | undefined, pathElement: string): {
  updated: FetchDataInputRewrite[],
  completeRewrite?: any,
} | undefined {
  if (!rewrites) {
    return undefined;
  }

  let completeRewrite: any = undefined;
  const updated = rewrites
    .map((r) => {
      let u: FetchDataInputRewrite | undefined = undefined;
      if (r.path[0] === pathElement) {
        const updatedPath = r.path.slice(1);
        if (updatedPath.length === 0) {
          completeRewrite = r.setValueTo;
        } else {
          u = { ...r, path: updatedPath };
        }
      }
      return u;
    })
    .filter(isDefined);
  return updated.length === 0 && completeRewrite === undefined
    ? undefined
    : { updated, completeRewrite };
}

/**
 *
 * @param source Result of GraphQL execution.
 * @param selectionSet
 */
function executeSelectionSet(
  schema: GraphQLSchema,
  source: Record<string, any> | null,
  selections: QueryPlanSelectionNode[],
  activeRewrites?: FetchDataInputRewrite[],
): Record<string, any> | null {

  // If the underlying service has returned null for the parent (source)
  // then there is no need to iterate through the parent's selection set
  if (source === null) {
    return null;
  }

  const result: Record<string, any> = Object.create(null);

  for (const selection of selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        const responseName = getResponseName(selection as QueryPlanFieldNode);
        const selections = (selection as QueryPlanFieldNode).selections;

        if (typeof source[responseName] === 'undefined') {
          // This method is called to collect the inputs/requires of a fetch. So, assuming query plans are correct
          // (and we have not reason to assume otherwise here), all inputs should be fetched beforehand and the
          // only reason for not finding one of the inputs is that we had an error fetching it _and_ that field
          // is non-nullable (it it was nullable, error fetching the input would have make that input `null`; not
          // having the input means the field is non-nullable so the whole entity had to be nullified/ignored,
          // leading use to not have the field at all).
          // In any case, we don't have all the necessary inputs for this particular entity and should ignore it.
          // Note that an error has already been logged for whichever issue happen while fetching the inputs we're
          // missing here, and that error had much more context, so no reason to log a duplicate (less useful) error
          // here.
          return null;
        }

        const updatedRewrites = updateRewrites(activeRewrites, responseName);
        if (updatedRewrites?.completeRewrite !== undefined) {
          result[responseName] = updatedRewrites.completeRewrite;
          continue;
        }

        if (Array.isArray(source[responseName])) {
          result[responseName] = source[responseName].map((value: any) =>
            selections
              ? executeSelectionSet(schema, value, selections, updatedRewrites?.updated)
              : value,
          );
        } else if (selections) {
          result[responseName] = executeSelectionSet(
            schema,
            source[responseName],
            selections,
            updatedRewrites?.updated,
          );
        } else {
          result[responseName] = source[responseName];
        }
        break;
      case Kind.INLINE_FRAGMENT:
        if (!selection.typeCondition) continue;

        const typename = source && source['__typename'];
        if (!typename) continue;

        if (doesTypeConditionMatch(schema, selection.typeCondition, typename)) {
          const updatedRewrites = activeRewrites ? updateRewrites(activeRewrites, `... on ${selection.typeCondition}`) : undefined;
          deepMerge(
            result,
            executeSelectionSet(schema, source, selection.selections, updatedRewrites?.updated),
          );
        }
        break;
    }
  }

  return result;
}

function doesTypeConditionMatch(
  schema: GraphQLSchema,
  typeCondition: string,
  typename: string,
): boolean {
  if (typeCondition === typename) {
    return true;
  }

  const type = schema.getType(typename);
  if (!type) {
    return false;
  }

  const conditionalType = schema.getType(typeCondition);
  if (!conditionalType) {
    return false;
  }

  if (isAbstractType(conditionalType)) {
    return (isObjectType(type) || isInterfaceType(type)) && schema.isSubType(conditionalType, type);
  }

  return false;
}

function moveIntoCursor(cursor: ResultCursor, pathInCursor: ResponsePath): ResultCursor | undefined {
  const data = flattenResultsAtPath(cursor.data, pathInCursor);
  return data ? {
    path: cursor.path.concat(pathInCursor),
    data,
    fullResult: cursor.fullResult,
  } : undefined;
}

function flattenResultsAtPath(value: ResultCursor['data'] | undefined | null, path: ResponsePath): ResultCursor['data'] | undefined | null {
  if (path.length === 0) return value;
  if (value === undefined || value === null) return value;

  const [current, ...rest] = path;
  if (current === '@') {
    return value.flatMap((element: any) => flattenResultsAtPath(element, rest));
  } else {
    assert(typeof current === 'string', () => `Unexpected ${typeof current} found in path`);
    assert(!Array.isArray(value), () => `Unexpected array in result for path element ${current}`);
    // Note that this typecheck because `value[current]` is of type `any` and so the typechecker "trusts us", but in
    // practice this only work because we use this on path that do not point to leaf types, and the `value[current]`
    // is never a base type (non-object nor null/undefined).
    return flattenResultsAtPath(value[current], rest);
  }
}

function downstreamServiceError(
  originalError: GraphQLFormattedError,
  serviceName: string,
  generateErrorPath: ErrorPathGenerator,
) {
  let { message } = originalError;
  const { extensions } = originalError;

  if (!message) {
    message = `Error while fetching subquery from service "${serviceName}"`;
  }

  const errorOptions: GraphQLErrorOptions = {
    originalError: originalError as Error,
    path: generateErrorPath(originalError.path),
    extensions: {
      ...extensions,
      // XXX The presence of a serviceName in extensions is used to
      // determine if this error should be captured for metrics reporting.
      serviceName,
    },
  };

  const codeDef = errorCodeDef(originalError);
  // It's possible the orignal has a code, but not one we know about (one generated by the underlying `GraphQLDataSource`,
  // which we don't control). In that case, we want to use that code (and have thus no `ErrorCodeDefinition` usable).
  if (!codeDef && extensions?.code) {
    return new GraphQLError(message, errorOptions);
  }
  // Otherwise, we either use the code we found and know, or default to a general downstream error code.
  return (codeDef ?? ERRORS.DOWNSTREAM_SERVICE_ERROR).err(
    message,
    errorOptions,
  );
}

export const defaultFieldResolverWithAliasSupport: GraphQLFieldResolver<
  any,
  any
> = function(source, args, contextValue, info) {
  // ensure source is a value for which property access is acceptable.
  if (typeof source === 'object' || typeof source === 'function') {
    // if this is an alias, check it first because a downstream service
    // would have returned the data *already cast* to an alias responseName
    const property = source[info.path.key];
    if (typeof property === 'function') {
      return source[info.fieldName](args, contextValue, info);
    }
    return property;
  }
};

// Converts an hrtime array (as returned from process.hrtime) to nanoseconds.
//
// ONLY CALL THIS ON VALUES REPRESENTING DELTAS, NOT ON THE RAW RETURN VALUE
// FROM process.hrtime() WITH NO ARGUMENTS.
//
// The entire point of the hrtime data structure is that the JavaScript Number
// type can't represent all int64 values without loss of precision:
// Number.MAX_SAFE_INTEGER nanoseconds is about 104 days. Calling this function
// on a duration that represents a value less than 104 days is fine. Calling
// this function on an absolute time (which is generally roughly time since
// system boot) is not a good idea.
//
// XXX We should probably use google.protobuf.Duration on the wire instead of
// ever trying to store durations in a single number.
function durationHrTimeToNanos(hrtime: [number, number]) {
  return hrtime[0] * 1e9 + hrtime[1];
}

// Converts a JS Date into a Timestamp.
function dateToProtoTimestamp(date: Date): google.protobuf.Timestamp {
  const totalMillis = +date;
  const millis = totalMillis % 1000;
  return new google.protobuf.Timestamp({
    seconds: (totalMillis - millis) / 1000,
    nanos: millis * 1e6,
  });
}
