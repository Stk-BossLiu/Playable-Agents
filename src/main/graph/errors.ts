export type GraphErrorCode =
  | 'GRAPH_INVALID'
  | 'GRAPH_ID_INVALID'
  | 'GRAPH_NOT_FOUND'
  | 'GRAPH_EXISTS'
  | 'GRAPH_BUILTIN_READONLY'
  | 'GRAPH_IO_ERROR'
  | 'GRAPH_IMPORT_INVALID'
  | 'GRAPH_NODE_NOT_FOUND'
  | 'GRAPH_LOOP_UNSUPPORTED';

export class GraphError extends Error {
  constructor(
    readonly code: GraphErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}
