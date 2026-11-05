export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly type: string,
    readonly code: string,
    message: string,
    readonly param?: string,
  ) {
    super(message);
  }

  toBody() {
    return { error: { type: this.type, code: this.code, message: this.message, param: this.param ?? null } };
  }
}

export const invalidRequest = (code: string, message: string, param?: string) =>
  new ApiError(400, "invalid_request_error", code, message, param);

export const notFound = (what: string, id: string) =>
  new ApiError(404, "invalid_request_error", "resource_missing", `No such ${what}: '${id}'`, "id");
