/** 带 HTTP 状态码、可以直接展示给用户的错误 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
