/**
 * A transfer that definitely did not happen: the wallet refused it or reported it failed.
 * Any other error from a transfer leaves the outcome unknown, because the money may have
 * moved before the error (a timeout while waiting for confirmation, a dropped connection).
 */
export class TransferRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferRejectedError';
  }
}
