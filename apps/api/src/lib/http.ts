/** An error whose message is safe to show the user as is (plain English), with the HTTP status to send. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
