// Adapted from actus7/orca-autocomplete src/lsp/jsonrpc.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// The error a JSON-RPC request rejects with when the server answers with an error object.
class RpcError extends Error {
  public readonly code: number;

  public constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export { RpcError };
